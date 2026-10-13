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
import path from "node:path";
import { registerCoreCommands } from "./commands/core-commands.js";
import { MidiProfileSchema, registerMidiCommands, type MidiProfile } from "./commands/midi-commands.js";
import { registerShowCommands } from "./commands/show-commands.js";
import { registerImportCommands } from "./commands/import-commands.js";
import { registerSelftestCommands } from "./commands/selftest-commands.js";
import { registerExportCommands } from "./commands/export-commands.js";
import { followPosition, registerSongCommands, type SongServices } from "./commands/song-commands.js";
import { SetlistSchema, SongSchema } from "./songs/songs.js";
import { ShowRuntime } from "./show/runtime.js";
import { Venue } from "./venue/venue.js";
import { FolderStore } from "./data/store.js";
import { MidiHub, type HubMessage } from "./midi/hub.js";
import { MappingSchema, MidiMapper } from "./midi/mapping.js";
import { OscServer } from "./osc/server.js";
import { TempoClock } from "./timing/tempo.js";
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
  /** Current show and venue (folders under <dataRoot>/shows and /venues). */
  show: z.string().default("default"),
  venue: z.string().default("default"),
  midi: z
    .object({
      profiles: z.record(z.string(), MidiProfileSchema).default({ local: MidiProfileSchema.parse({ inputs: ["IAC"] }) }),
      active: z.string().default("local"),
    })
    .default({}),
  osc: z.object({ enabled: z.boolean().default(true), port: z.number().int().min(0).max(65535).default(9000), allow: z.array(z.string()).default([]) }).default({}),
});
export type LightConfig = z.infer<typeof LightConfigSchema>;

/** MCP tool name for a command: "dmx.set" → "light_dmx_set". */
export const toolName = (command: string): string => `light_${command.replace(/\./g, "_")}`;

export interface LightPluginOptions {
  eventBus: EventBus;
  config?: ScopedConfigStore;
  auth?: AuthMiddleware;
  /** Root of the data folders (machine/venues/shows). Default: <repo>/data. */
  dataRoot?: string;
  /** Test seams. */
  tickerRateHz?: number;
  midiNative?: null;
}

export class LightPlugin implements McpPlugin {
  readonly id = PLUGIN_ID;
  readonly name = "Lumière";
  readonly commands = new CommandRegistry();
  readonly engine: DmxEngine;
  readonly router: OutputRouter;
  readonly show: FolderStore;
  readonly venue: Venue;
  readonly runtime: ShowRuntime;
  readonly hub: MidiHub;
  readonly mapper = new MidiMapper();
  readonly tempo = new TempoClock();
  readonly osc: OscServer;
  private config: LightConfig;
  private started = false;
  private tempoTimer: NodeJS.Timeout | undefined;
  private songs: SongServices | undefined;

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

    const dataRoot = opts.dataRoot ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../data");
    this.show = new FolderStore(path.join(dataRoot, "shows", this.config.show), path.join(dataRoot, "backups", "shows", this.config.show));
    this.venue = new Venue(
      new FolderStore(path.join(dataRoot, "venues", this.config.venue), path.join(dataRoot, "backups", "venues", this.config.venue)),
      [path.join(dataRoot, "fixtures"), path.join(dataRoot, "venues", this.config.venue, "fixture-definitions")],
    );
    this.runtime = new ShowRuntime(this.show, this.venue, this.tempo);
    this.engine.setRenderer((buffers) => this.runtime.render(buffers));
    registerShowCommands(this.commands, this.engine, this.runtime);
    const mappings = this.show.collection("mappings", MappingSchema);
    this.mapper.setMappings(mappings.list());
    this.hub = new MidiHub(this.activeMidiProfile(), opts.midiNative === null ? { native: null } : {});
    this.hub.on("message", (m: HubMessage) => this.onMidi(m));
    this.hub.on("ports", () => this.publish("midi", { status: this.hub.status() }));
    this.hub.on("warning", (w: string) => this.publish("midi", { warning: w }));
    registerMidiCommands(this.commands, {
      hub: this.hub,
      mapper: this.mapper,
      mappings,
      tempo: this.tempo,
      profiles: () => this.config.midi.profiles,
      activeProfile: () => this.config.midi.active,
      selectProfile: async (name) => {
        if (!this.config.midi.profiles[name]) throw new Error(`profil inconnu : ${name}`);
        this.config = { ...this.config, midi: { ...this.config.midi, active: name } };
        await this.hub.setConfig(this.activeMidiProfile());
        await this.opts.config?.set(this.config);
      },
      saveProfile: async (name, profile) => {
        this.config = { ...this.config, midi: { ...this.config.midi, profiles: { ...this.config.midi.profiles, [name]: profile } } };
        if (name === this.config.midi.active) await this.hub.setConfig(this.activeMidiProfile());
        await this.opts.config?.set(this.config);
      },
    });
    registerSelftestCommands(this.commands, this.engine, this.runtime, () => mappings.list());
    registerExportCommands(this.commands, this.runtime, () => mappings.list(), dataRoot);
    this.songs = {
      runtime: this.runtime,
      songs: this.show.collection("songs", SongSchema),
      setlists: this.show.collection("setlists", SetlistSchema),
      tempo: this.tempo,
      mappings: () => mappings.list(),
      dataRoot,
      state: { follow: true },
      publish: (state) => this.publish("song", state),
    };
    registerSongCommands(this.commands, this.songs);
    registerImportCommands(this.commands, { runtime: this.runtime, show: this.show, mappings, mapper: this.mapper, tempo: this.tempo, importsDir: path.join(dataRoot, "imports") });
    this.osc = new OscServer(this.config.osc, this.commands, (command, args) => this.commands.invoke(command, args, { origin: "osc", can: () => true }));

    const publishFrame = throttleMerge<number>(
      40, // ≤ 25 Hz to dashboards (docs/architecture.md, topic light:dmx)
      (xs) => xs[xs.length - 1]!,
      (now) => this.publish("frame", { now, buffers: this.engine.output.buffers }),
    );
    let lastClampKey = "";
    this.engine.onFrame((buffers, now) => {
      if (this.songs) followPosition(this.songs);
      this.router.sendFrame(buffers);
      publishFrame(now);
      const clamps = this.runtime?.lastClamps ?? [];
      const key = clamps.map((c) => `${c.fixture}/${c.channel}/${c.to}`).join("|");
      if (key !== lastClampKey) {
        lastClampKey = key;
        this.publish("rules", { clamps });
      }
    });
    this.router.onNodesChanged(() => this.publish("nodes", this.router.registry.list()));
  }

  private activeMidiProfile(): { inputs: string[]; feedbackOutput?: string; rtp: MidiProfile["rtp"] } {
    const p = this.config.midi.profiles[this.config.midi.active] ?? MidiProfileSchema.parse({});
    return { inputs: p.inputs, feedbackOutput: p.feedbackOutput, rtp: p.rtp };
  }

  /** Every MIDI message: tempo follows the clock; mappings turn the rest into commands. */
  private onMidi(m: HubMessage): void {
    this.tempo.handleMidi(m.msg);
    const t = m.msg.type;
    if (t === "clock" || t === "start" || t === "stop" || t === "continue" || t === "songposition") return;
    this.publish("midi", { monitor: { port: m.port, source: m.source, msg: m.msg, at: Date.now() } });
    const out = this.mapper.handle(m.msg, m.port);
    this.hub.sendFeedback(out.feedback);
    for (const call of out.calls) {
      this.commands.invoke(call.command, call.args, { origin: "midi", can: () => true }).catch((err: Error) => this.publish("midi", { error: `${call.command} : ${err.message}` }));
    }
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
    await this.hub.start();
    await this.osc.start().catch((err: Error) => console.warn(`OSC indisponible sur le port ${this.config.osc.port} : ${err.message}`));
    this.tempoTimer = setInterval(() => this.publish("tempo", this.tempo.state()), 250);
    this.tempoTimer.unref();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.tempoTimer) clearInterval(this.tempoTimer);
    this.osc.stop();
    this.hub.stop();
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
      ...(this.hub.localAvailable ? {} : { warnings: [`MIDI local indisponible : ${this.hub.localError}`] }),
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
      midi: { channel: "control" },
      tempo: { channel: "control" },
      rules: { channel: "control" },
      song: { channel: "control" },
    };
  }
}
