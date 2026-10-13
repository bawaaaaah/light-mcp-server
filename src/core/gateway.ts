/**
 * HTTP gateway: health, PIN login and roles, WebSocket tickets, MCP over streamable HTTP, plugin
 * routes, the WebSocket hub (REST replayed over WS) and the web UI.
 *
 * Simplified from wing-mcp-server's McpGatewayServer (MIT): no OAuth or passkeys in v1 (roles +
 * PIN instead, docs/architecture.md); MCP session handling follows the same rules (one McpServer
 * per session, 404 for an unknown session so clients re-initialise).
 */
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import http, { type Server as HttpServer } from "node:http";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { AuthService } from "./auth.js";
import type { EventBus } from "./event-bus.js";
import { bodyString } from "./http-body.js";
import { errorHandler, HttpError } from "./http-errors.js";
import { createMcpServer } from "./mcp-server-factory.js";
import type { McpPlugin } from "./plugin.js";
import type { ToolVisibilityController } from "./tool-visibility-controller.js";
import { getPackageVersion } from "./version.js";
import { WsHub } from "./ws-hub.js";
import { replayThroughServer } from "./ws-rest.js";

export interface GatewayOptions {
  plugins: McpPlugin[];
  eventBus: EventBus;
  auth: AuthService;
  toolVisibility?: ToolVisibilityController;
  port: number;
  host?: string;
  /** Built web UI (web/dist); served when present. */
  webRoot?: string;
  log?: (msg: string) => void;
}

const MAX_SESSIONS = 32;
const SESSION_IDLE_MS = 60 * 60_000;

interface McpSession {
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
  toolHandles: Map<string, RegisteredTool>;
}

export class Gateway {
  readonly app: Express;
  private server: HttpServer | undefined;
  private wsHub: WsHub | undefined;
  private readonly sessions = new Map<string, McpSession>();
  private readonly startedAt = Date.now();

  constructor(private readonly opts: GatewayOptions) {
    this.app = express();
    this.app.disable("x-powered-by");
    this.mountCoreRoutes();
    this.mountMcp();
    this.mountPlugins();
    if (opts.webRoot && existsSync(opts.webRoot)) {
      this.app.use(express.static(opts.webRoot));
      this.app.get(/^\/(?!api\/|mcp).*/, (_req, res) => res.sendFile("index.html", { root: opts.webRoot }));
    }
    this.app.use(errorHandler());
  }

  get address(): { port: number } | undefined {
    const a = this.server?.address();
    return a && typeof a === "object" ? { port: a.port } : undefined;
  }

  async start(): Promise<void> {
    await this.opts.toolVisibility?.load();
    const server = http.createServer(this.app);
    this.server = server;
    this.wsHub = new WsHub({
      plugins: this.opts.plugins,
      eventBus: this.opts.eventBus,
      auth: this.opts.auth,
      handleRequest: (req) => replayThroughServer(server, req),
    });
    server.on("upgrade", (req, socket, head) => this.wsHub!.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port, this.opts.host ?? "0.0.0.0", () => resolve());
    });
    this.opts.log?.(`light-mcp-server ${getPackageVersion()} : http://${this.opts.host ?? "0.0.0.0"}:${this.address?.port} (MCP sur /mcp, WebSocket sur /api/ws)`);
  }

  async stop(): Promise<void> {
    await this.wsHub?.close();
    for (const s of this.sessions.values()) await s.transport.close().catch(() => undefined);
    this.sessions.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server?.closeAllConnections?.();
  }

  private mountCoreRoutes(): void {
    const { app } = this;
    const auth = this.opts.auth;
    app.get("/health", async (_req, res) => {
      const healths = await Promise.all(this.opts.plugins.map(async (p) => ({ id: p.id, ...(await p.getHealth()) })));
      const status = healths.some((h) => h.status === "ERROR") ? "ERROR" : healths.some((h) => h.status === "DEGRADED") ? "DEGRADED" : "HEALTHY";
      res.json({ status, version: getPackageVersion(), uptimeMs: Date.now() - this.startedAt, plugins: healths.map(({ id, status: s }) => ({ id, status: s })) });
    });
    app.post("/api/auth/login", express.json(), (req, res) => {
      const pin = bodyString(req.body, "pin");
      if (!pin) throw new HttpError(400, "pin requis");
      const { token, role } = auth.login(pin);
      res.json({ token, role: { id: role.id, name: role.name, rights: role.rights, dashboards: role.dashboards } });
    });
    app.post("/api/auth/logout", auth.requireAuth(), (req, res) => {
      auth.logout(auth.bearerOf(req)!);
      res.status(204).end();
    });
    app.get("/api/auth/me", auth.requireAuth(), (req, res) => {
      const role = auth.roleOf(auth.bearerOf(req))!;
      res.json({ id: role.id, name: role.name, rights: role.rights, dashboards: role.dashboards });
    });
    app.post("/api/auth/ws-ticket", auth.requireAuth(), (req, res) => {
      res.json({ ticket: auth.issueStreamTicket(auth.bearerOf(req)!) });
    });
    app.get("/api/auth/roles", auth.requireRight("auth:admin"), (_req, res) => res.json(auth.roles()));
    app.put("/api/auth/roles/:id/pin", auth.requireRight("auth:admin"), express.json(), async (req, res, next) => {
      try {
        await auth.setPin(String(req.params.id), bodyString(req.body, "pin") ?? "");
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    });
    app.get("/api/plugins", auth.requireAuth(), async (_req, res) => {
      res.json(await Promise.all(this.opts.plugins.map(async (p) => ({ id: p.id, name: p.name, health: await p.getHealth() }))));
    });
  }

  private mountPlugins(): void {
    for (const plugin of this.opts.plugins) {
      if (!plugin.registerHttpRoutes) continue;
      const router = express.Router();
      router.use(express.json());
      plugin.registerHttpRoutes(router);
      this.app.use(`/api/plugins/${plugin.id}`, this.opts.auth.requireAuth(), router);
    }
  }

  private newSession(): { mcpServer: ReturnType<typeof createMcpServer>["mcpServer"]; toolHandles: Map<string, RegisteredTool> } {
    const vis = this.opts.toolVisibility;
    return createMcpServer(this.opts.plugins, vis ? { extraInstructions: vis.instructionsAddendum(), isToolHidden: (n) => vis.isHidden(n) } : {});
  }

  private sweepSessions(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeenAt > SESSION_IDLE_MS) {
        void s.transport.close();
        this.sessions.delete(id);
      }
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
      if (oldest) {
        void oldest[1].transport.close();
        this.sessions.delete(oldest[0]);
      }
    }
  }

  private mountMcp(): void {
    const requireMcp = (req: Request, _res: Response, next: NextFunction) => {
      const credential = this.opts.auth.bearerOf(req);
      if (!credential || !this.opts.auth.isValidCredential(credential)) return next(new HttpError(401, "Unauthorized: send the token as a Bearer header"));
      if (!this.opts.auth.can(credential, "mcp:use")) return next(new HttpError(403, "ce rôle n'a pas accès au MCP"));
      next();
    };
    const sessionId = (req: Request): string | undefined => {
      const v = req.headers["mcp-session-id"];
      return Array.isArray(v) ? v[0] : v;
    };
    this.app.post("/mcp", requireMcp, express.json({ limit: "4mb" }), async (req, res) => {
      const id = sessionId(req);
      try {
        const existing = id ? this.sessions.get(id) : undefined;
        if (existing) {
          existing.lastSeenAt = Date.now();
          await existing.transport.handleRequest(req, res, req.body);
          return;
        }
        if (id) {
          res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
          return;
        }
        if (!isInitializeRequest(req.body)) {
          res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" }, id: null });
          return;
        }
        const session = this.newSession();
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            this.sweepSessions();
            this.sessions.set(sid, { transport, lastSeenAt: Date.now(), toolHandles: session.toolHandles });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) this.sessions.delete(transport.sessionId);
        };
        await session.mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error("Error handling MCP request:", err);
        if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    });
    const sessionHandler = async (req: Request, res: Response) => {
      const id = sessionId(req);
      const entry = id ? this.sessions.get(id) : undefined;
      if (!entry) {
        res.status(id ? 404 : 400).send(id ? "Session not found" : "Missing session ID");
        return;
      }
      entry.lastSeenAt = Date.now();
      await entry.transport.handleRequest(req, res);
    };
    this.app.get("/mcp", requireMcp, sessionHandler);
    this.app.delete("/mcp", requireMcp, sessionHandler);
  }
}
