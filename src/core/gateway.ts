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
import path from "node:path";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { signedInView, type AuthService, type UserSummary } from "./auth.js";
import { createPasskeyRouter, type PasskeyService } from "./passkeys.js";
import type { OAuthIntegration } from "./oauth.js";
import type { EventBus } from "./event-bus.js";
import { bodyString } from "./http-body.js";
import { errorHandler, HttpError } from "./http-errors.js";
import { inLang, langOf } from "./lang.js";
import { createMcpServer } from "./mcp-server-factory.js";
import type { McpPlugin } from "./plugin.js";
import type { ToolVisibilityController } from "./tool-visibility-controller.js";
import { getPackageVersion } from "./version.js";
import { WsHub } from "./ws-hub.js";
import { replayThroughServer } from "./ws-rest.js";
import { say } from "./lang.js";

export interface GatewayOptions {
  plugins: McpPlugin[];
  eventBus: EventBus;
  auth: AuthService;
  toolVisibility?: ToolVisibilityController;
  port: number;
  host?: string;
  /** `server.publicUrl`: the address behind a reverse proxy; its origin may open WebSockets. */
  publicUrl?: string;
  /** Hardware keys (YubiKey) and passkeys of the users. */
  passkeys?: PasskeyService;
  /** OAuth in front of /mcp (claude.ai connectors), when server.publicUrl is set. */
  oauth?: OAuthIntegration;
  /** Reverse proxies in front (server.trustProxy): the client's address comes from X-Forwarded-For. */
  trustProxy?: number;
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
  /** The user (or administrator) the session was opened for: nobody else may use it. */
  principal: string;
}

export class Gateway {
  readonly app: Express;
  private server: HttpServer | undefined;
  private wsHub: WsHub | undefined;
  private readonly sessions = new Map<string, McpSession>();
  private readonly startedAt = Date.now();

  constructor(private readonly opts: GatewayOptions) {
    this.app = express();
    if (opts.trustProxy) this.app.set("trust proxy", opts.trustProxy);
    this.app.disable("x-powered-by");
    // Nothing here is meant to sit in another site's frame: a page that framed the controls (or the
    // OAuth approval page) could disguise what a click does. No MIME sniffing either.
    this.app.use((_req, res, next) => {
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
      res.setHeader("X-Content-Type-Options", "nosniff");
      next();
    });
    // an interface set to English is answered in English (core/lang.ts); everyone else in French
    this.app.use((req, _res, next) => inLang(langOf(req.headers["x-light-lang"]), next));
    this.mountCoreRoutes();
    this.mountMcp();
    this.mountPlugins();
    if (opts.webRoot && existsSync(opts.webRoot)) {
      // Vite names every built asset after its content: cached for good, while index.html is checked each time
      this.app.use("/assets", express.static(path.join(opts.webRoot, "assets"), { maxAge: "1y", immutable: true }));
      this.app.use("/assets", (_req, res) => void res.status(404).end()); // a missing asset is not the app page
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
      publicUrl: parseUrl(this.opts.publicUrl),
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
    this.opts.oauth?.provider.close();
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
    const passkeys = this.opts.passkeys;
    const userJson = (u: UserSummary) => ({ ...u, keys: passkeys?.count(u.id) ?? 0 });
    app.post("/api/auth/login", express.json(), (req, res) => {
      const pin = bodyString(req.body, "pin");
      if (!pin) throw new HttpError(400, say("pin requis", "PIN required"));
      // req.ip: the client's own address behind a trusted proxy (server.trustProxy), else the socket's
      const { token, role, user } = auth.login(pin, bodyString(req.body, "user") ?? bodyString(req.body, "role"), req.ip ?? req.socket.remoteAddress);
      res.json({ token, role: signedInView(role, user) });
    });
    app.get("/api/auth/login-users", (_req, res) => res.json({ users: auth.loginUsers(), keys: passkeys?.hasPasskeys() ?? false }));
    // who has the interface open right now (tablets, régie…): names and addresses, never credentials
    app.get("/api/clients", auth.requireRight("show:write"), (req, res) => {
      const me = auth.bearerOf(req);
      const clients = (this.wsHub?.clients() ?? [])
        .map((c) => ({ who: auth.nameOf(c.credential) ?? "?", role: auth.roleOf(c.credential)?.name, address: c.address, since: new Date(c.since).toISOString(), self: c.credential === me }))
        .sort((a, b) => a.since.localeCompare(b.since));
      res.json(clients);
    });
    app.post("/api/auth/logout", auth.requireAuth(), (req, res) => {
      auth.logout(auth.bearerOf(req)!);
      res.status(204).end();
    });
    app.get("/api/auth/me", auth.requireAuth(), (req, res) => {
      const credential = auth.bearerOf(req);
      res.json({ ...signedInView(auth.roleOf(credential)!, auth.userOf(credential)), kind: auth.authKind(req) });
    });
    // one's own PIN (a signed-in user, not the master token)
    app.put("/api/auth/me/pin", auth.requireAuth(), express.json(), (req, res, next) => {
      const user = auth.userOf(auth.bearerOf(req));
      if (!user) return next(new HttpError(400, say("entré avec le jeton : pas de compte à qui donner un PIN", "signed in with the token: no account to give a PIN to")));
      const pin = bodyString(req.body, "pin");
      auth.setPin(user.id, pin ? pin : null).then(() => res.status(204).end(), next);
    });
    app.post("/api/auth/ws-ticket", auth.requireAuth(), (req, res) => {
      res.json({ ticket: auth.issueStreamTicket(auth.bearerOf(req)!) });
    });
    // users: the administrator's (auth:admin)
    const admin = auth.requireRight("auth:admin");
    const wrap = (fn: (req: express.Request, res: express.Response) => Promise<void>) => (req: express.Request, res: express.Response, next: express.NextFunction) => fn(req, res).catch(next);
    app.get("/api/auth/roles", admin, (_req, res) => res.json(auth.roles()));
    const rightsOf = (body: unknown) => {
      const r = (body as { rights?: unknown } | undefined)?.rights;
      return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : undefined;
    };
    const dashboardsOf = (body: unknown) => {
      const d = (body as { dashboards?: unknown } | undefined)?.dashboards;
      return d === null ? null : Array.isArray(d) ? d.filter((x): x is string => typeof x === "string") : undefined;
    };
    app.post(
      "/api/auth/roles",
      admin,
      express.json(),
      wrap(async (req, res) => {
        res.status(201).json(await auth.addRole({ name: bodyString(req.body, "name") ?? "", rights: rightsOf(req.body) ?? [], dashboards: dashboardsOf(req.body) ?? undefined }));
      }),
    );
    app.patch(
      "/api/auth/roles/:id",
      admin,
      express.json(),
      wrap(async (req, res) => {
        res.json(await auth.updateRole(String(req.params.id), { name: bodyString(req.body, "name"), rights: rightsOf(req.body), dashboards: dashboardsOf(req.body) }));
      }),
    );
    app.delete(
      "/api/auth/roles/:id",
      admin,
      wrap(async (req, res) => {
        await auth.deleteRole(String(req.params.id));
        res.status(204).end();
      }),
    );
    app.get("/api/auth/users", admin, (_req, res) => res.json(auth.users().map(userJson)));
    app.post(
      "/api/auth/users",
      admin,
      express.json(),
      wrap(async (req, res) => {
        const name = bodyString(req.body, "name")?.trim();
        if (!name) throw new HttpError(400, say("nom requis", "name required"));
        res.status(201).json(userJson(await auth.addUser({ name, role: bodyString(req.body, "role") ?? "", pin: bodyString(req.body, "pin") || undefined })));
      }),
    );
    app.patch(
      "/api/auth/users/:id",
      admin,
      express.json(),
      wrap(async (req, res) => {
        const disabled = req.body?.disabled;
        res.json(userJson(await auth.updateUser(String(req.params.id), { name: bodyString(req.body, "name"), role: bodyString(req.body, "role"), disabled: typeof disabled === "boolean" ? disabled : undefined })));
      }),
    );
    app.put(
      "/api/auth/users/:id/pin",
      admin,
      express.json(),
      wrap(async (req, res) => {
        const pin = bodyString(req.body, "pin");
        await auth.setPin(String(req.params.id), pin ? pin : null);
        res.status(204).end();
      }),
    );
    app.delete(
      "/api/auth/users/:id",
      admin,
      wrap(async (req, res) => {
        await auth.deleteUser(String(req.params.id));
        await passkeys?.removeUser(String(req.params.id));
        res.status(204).end();
      }),
    );
    if (passkeys) app.use(createPasskeyRouter(passkeys, auth));
    const oauth = this.opts.oauth;
    if (oauth) {
      app.use(oauth.router);
      app.get("/api/auth/oauth/clients", admin, (_req, res) => res.json(oauth.provider.listClients()));
      app.delete(
        "/api/auth/oauth/clients/:id",
        admin,
        wrap(async (req, res) => {
          if (!(await oauth.provider.revokeClient(String(req.params.id)))) throw new HttpError(404, say("client inconnu", "unknown client"));
          res.status(204).end();
        }),
      );
    }
    app.get("/api/server", auth.requireAuth(), (_req, res) => {
      res.json({ version: getPackageVersion(), publicUrl: parseUrl(this.opts.publicUrl)?.origin ?? null, oauth: Boolean(this.opts.oauth) });
    });
    app.get("/api/plugins", auth.requireAuth(), async (_req, res) => {
      res.json(await Promise.all(this.opts.plugins.map(async (p) => ({ id: p.id, name: p.name, health: await p.getHealth() }))));
    });
  }

  private mountPlugins(): void {
    for (const plugin of this.opts.plugins) {
      if (!plugin.registerHttpRoutes) continue;
      const router = express.Router();
      router.use(express.json({ limit: "16mb" }));
      plugin.registerHttpRoutes(router);
      this.app.use(`/api/plugins/${plugin.id}`, this.opts.auth.requireAuth(), router);
    }
  }

  /** An MCP session for one user: the tools their role cannot call are not even listed. */
  private newSession(credential: string): { mcpServer: ReturnType<typeof createMcpServer>["mcpServer"]; toolHandles: Map<string, RegisteredTool> } {
    const vis = this.opts.toolVisibility;
    const forbidden = (name: string) => {
      const right = this.opts.plugins.map((p) => p.toolRight?.(name)).find(Boolean);
      return right !== undefined && !this.opts.auth.can(credential, right);
    };
    return createMcpServer(this.opts.plugins, { extraInstructions: vis?.instructionsAddendum(), isToolHidden: (n) => (vis?.isHidden(n) ?? false) || forbidden(n) });
  }

  /** Who a credential acts as: the same user (or the administrator) keeps their session across token refreshes. */
  private principalOf(credential: string): string {
    return `${this.opts.auth.roleOf(credential)?.id ?? ""}:${this.opts.auth.userOf(credential)?.id ?? ""}`;
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
    const requireMcp = (req: Request, res: Response, next: NextFunction) => {
      const credential = this.opts.auth.bearerOf(req);
      if (!credential || !this.opts.auth.isValidCredential(credential)) {
        // OAuth-only clients (claude.ai) discover the authorization server from this header
        if (this.opts.oauth) res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${this.opts.oauth.resourceMetadataUrl}"`);
        return next(new HttpError(401, "Unauthorized: send the token as a Bearer header"));
      }
      if (!this.opts.auth.can(credential, "mcp:use")) return next(new HttpError(403, say("ce rôle n'a pas accès au MCP", "this role has no access to MCP")));
      // The transport hands this to every tool call (extra.authInfo): each call is checked with its caller's rights.
      (req as Request & { auth?: AuthInfo }).auth = { token: credential, clientId: this.principalOf(credential), scopes: [] };
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
        const credential = this.opts.auth.bearerOf(req)!;
        if (existing) {
          if (existing.principal !== this.principalOf(credential)) {
            res.status(403).json({ jsonrpc: "2.0", error: { code: -32001, message: "session d'un autre utilisateur" }, id: null });
            return;
          }
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
        const session = this.newSession(credential);
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            this.sweepSessions();
            this.sessions.set(sid, { transport, lastSeenAt: Date.now(), toolHandles: session.toolHandles, principal: this.principalOf(credential) });
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
      if (entry.principal !== this.principalOf(this.opts.auth.bearerOf(req)!)) {
        res.status(403).send("session d'un autre utilisateur");
        return;
      }
      entry.lastSeenAt = Date.now();
      await entry.transport.handleRequest(req, res);
    };
    this.app.get("/mcp", requireMcp, sessionHandler);
    this.app.delete("/mcp", requireMcp, sessionHandler);
  }
}

/** `server.publicUrl` as a URL, or undefined when it is absent or not a URL. */
function parseUrl(value: string | undefined): URL | undefined {
  try {
    return value ? new URL(value) : undefined;
  } catch {
    return undefined;
  }
}
