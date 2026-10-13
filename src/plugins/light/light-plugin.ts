/**
 * The light plugin: engine + output + command layer, exposed as MCP tools, HTTP routes and live
 * WebSocket topics — all generated from the command registry (docs/architecture.md, principle 2).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Request, Response, Router } from "express";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AuthMiddleware } from "../../core/auth.js";
import type { EventBus } from "../../core/event-bus.js";
import { HttpError } from "../../core/http-errors.js";
import type { LiveTopic, McpPlugin, PluginHealth } from "../../core/plugin.js";
import { throttleMerge } from "../../core/throttle.js";
import { summarizeDescription, type PluginToolCatalogue } from "../../core/tool-catalogue.js";
import type { ScopedConfigStore } from "../../core/config-store.js";
import { registerCoreCommands } from "./commands/core-commands.js";
import { CommandError, CommandRegistry, type CommandContext, type CommandDef, type Origin } from "./commands/registry.js";
import { DmxEngine } from "./engine/dmx-engine.js";
import { OutputRouter, type OutputConfig } from "./output/output-router.js";

export const PLUGIN_ID = "light";

const RouteSchema = z.object({
  universe: z.number().int().min(1),
  artnet: z.object({ portAddress: z.number().int().min(0).max(32767), targets: z.array(z.string()).optional(), broadcast: z.boolean().optional() }).optional(),
  sacn: z.object({ universe: z.number().int().min(1).max(63999), priority: z.number().int().min(0).max(200).optional(), unicast: z.array(z.string()).optional() }).optional(),
});

export const LightConfigSchema = z.object({
  universes: z.number().int().min(1).max(16).default(4),
  output: z
    .object({
      bindAddress: z.string().optional(),
      artSync: z.boolean().optional(),
      sourceName: z.string().optional(),
      routes: z.array(RouteSchema),
    })
    .default({ routes: [{ universe: 1, artnet: { portAddress: 0 } }] }),
  discovery: z.boolean().default(true),
});
export type LightConfig = z.infer<typeof LightConfigSchema>;

/** MCP tool name for a command: "dmx.set" → "light_dmx_set". */
export const toolName = (command: string): string => `light_${command.replace(/\./g, "_")}`;

export interface LightPluginOptions {
  eventBus: EventBus;
  config?: ScopedConfigStore;
  auth?: AuthMiddleware;
  /** Test seam: engine ticker options. */
  tickerRateHz?: number;
}

export class LightPlugin implements McpPlugin {
  readonly id = PLUGIN_ID;
  readonly name = "Lumière";
  readonly commands = new CommandRegistry();
  readonly engine: DmxEngine;
  readonly router: OutputRouter;
  private config: LightConfig;
  private started = false;

  constructor(private readonly opts: LightPluginOptions) {
    this.config = LightConfigSchema.parse(opts.config?.get() ?? {});
    this.engine = new DmxEngine(this.config.universes, { rateHz: opts.tickerRateHz });
    this.router = new OutputRouter(this.config.output as OutputConfig);
    this.commands.onStateChange = () => {
      this.engine.requestFrame();
      this.publish("state", this.state());
    };
    this.commands.onCommand((e) => this.publish("command", e));
    registerCoreCommands(this.commands, this.engine, this.router);

    const publishFrame = throttleMerge<number>(
      40, // ≤ 25 Hz to dashboards (docs/architecture.md, topic light:dmx)
      (xs) => xs[xs.length - 1]!,
      (now) => this.publish("frame", { now, buffers: this.engine.output.buffers }),
    );
    this.engine.onFrame((buffers, now) => {
      this.router.sendFrame(buffers);
      publishFrame(now);
    });
    this.router.onNodesChanged(() => this.publish("nodes", this.router.registry.list()));
  }

  private publish(type: string, payload: unknown): void {
    this.opts.eventBus.publish({ pluginId: this.id, type, payload, timestamp: Date.now() });
  }

  state(): { blackout: boolean; universes: number; discovery: string } {
    return { blackout: this.engine.isBlackout(), universes: this.config.universes, discovery: this.router.stats.discovery };
  }

  /** Invokes a command for a caller identified by its credential (HTTP, WS, OSC…). */
  invoke(name: string, args: unknown, origin: Origin, credential?: string): Promise<unknown> {
    const ctx: CommandContext = { origin, can: (right) => (this.opts.auth ? this.opts.auth.can(credential, right) : true) };
    return this.commands.invoke(name, args, ctx);
  }

  async start(): Promise<void> {
    await this.router.start({ discovery: this.config.discovery });
    this.engine.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    this.engine.stop();
    this.router.stop();
    this.started = false;
  }

  async getHealth(): Promise<PluginHealth> {
    const s = this.router.stats;
    const status = !this.started ? "ERROR" : s.discovery === "unavailable" ? "DEGRADED" : "HEALTHY";
    return {
      status,
      detail: { frames: this.engine.frames, packets: s.packetsSent, errors: s.errors, discovery: s.discovery, nodes: this.router.registry.list().length },
      ...(s.discovery === "unavailable" ? { errorMessage: `découverte Art-Net indisponible (port 6454 occupé ?) : ${s.discoveryError}` } : {}),
    };
  }

  getInstructions(): string {
    return [
      "light-mcp-server drives DMX lighting (Art-Net/sACN).",
      "Every tool maps to one server command; the same commands are used by the web UI, MIDI and OSC.",
      "Safety: light_panic recalls the show's safe look (Blackout until one is defined); light_blackout cuts everything.",
    ].join(" ");
  }

  registerTools(server: McpServer): void {
    for (const def of this.commands.list()) {
      const shape = (def.schema as unknown as z.AnyZodObject).shape ?? {};
      server.registerTool(
        toolName(def.name),
        { title: def.title, description: def.description, inputSchema: shape, annotations: { readOnlyHint: Boolean(def.readOnly) } },
        async (args: unknown) => {
          try {
            const result = await this.commands.invoke(def.name, args, { origin: "mcp", can: () => true });
            return { content: [{ type: "text" as const, text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
          } catch (err) {
            return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
          }
        },
      );
    }
  }

  async getToolCatalogue(): Promise<PluginToolCatalogue> {
    const defs = this.commands.list();
    const domain = (d: CommandDef) => d.name.split(".")[0]!;
    const groups = [...new Set(defs.map(domain))].map((id) => ({ id, label: id, description: `Commandes ${id}` }));
    const profile = (id: "setup" | "design" | "live", label: string) => ({
      id,
      label,
      description: `Outils du profil ${label}`,
      groups: [...new Set(defs.filter((d) => d.profiles?.includes(id)).map(domain))],
    });
    return {
      pluginId: this.id,
      groups,
      tools: defs.map((d) => ({ name: toolName(d.name), title: d.title, summary: summarizeDescription(d.description), group: domain(d), bytes: d.description.length, readOnly: Boolean(d.readOnly) })),
      profiles: [profile("setup", "installation"), profile("design", "conception"), profile("live", "spectacle"), { id: "full", label: "tout", description: "Tous les outils", groups: groups.map((g) => g.id) }],
    };
  }

  getConfigSchema(): object {
    return zodToJsonSchema(LightConfigSchema);
  }

  getConfig(): unknown {
    return this.config;
  }

  async setConfig(config: unknown): Promise<void> {
    const next = LightConfigSchema.parse(config);
    if (next.universes !== this.config.universes) throw new HttpError(409, "changer le nombre d'univers demande un redémarrage");
    this.config = next;
    this.router.setConfig(next.output as OutputConfig);
    await this.opts.config?.set(next);
  }

  registerHttpRoutes(router: Router): void {
    const credential = (req: Request) => this.opts.auth?.bearerOf(req);
    router.get("/commands", (_req: Request, res: Response) => {
      res.json(this.commands.list().map((d) => ({ name: d.name, title: d.title, description: d.description, right: d.right, readOnly: Boolean(d.readOnly), schema: zodToJsonSchema(d.schema) })));
    });
    router.post("/commands/:name", async (req: Request, res: Response) => {
      try {
        res.json({ ok: true, result: await this.invoke(String(req.params.name), req.body, "ui", credential(req)) });
      } catch (err) {
        const status = err instanceof CommandError ? { unknown: 404, invalid: 400, forbidden: 403, failed: 422 }[err.code] : 500;
        res.status(status).json({ ok: false, error: err instanceof Error ? err.message : String(err), detail: err instanceof CommandError ? err.detail : undefined });
      }
    });
    router.get("/state", (_req, res) => res.json(this.state()));
  }

  liveTopics(): Record<string, LiveTopic> {
    const universesParam = z.object({ universes: z.array(z.number().int().min(1).max(this.config.universes)).min(1).max(16) });
    return {
      dmx: {
        channel: "stream",
        source: "frame",
        compress: false,
        subscribe: (params) => {
          const p = universesParam.parse(params ?? { universes: [1] });
          const universes = [...new Set(p.universes)].sort((a, b) => a - b);
          return { key: universes.join(","), params: { universes }, ack: { universes } };
        },
        encode: (payload, params) => {
          const { buffers } = payload as { buffers: Uint8Array[] };
          const { universes } = params as { universes: number[] };
          return { universes: universes.map((u) => [u, buffers[u - 1]!.slice()]) };
        },
      },
      state: { channel: "control" },
      nodes: { channel: "control" },
      command: { channel: "control" },
    };
  }
}
