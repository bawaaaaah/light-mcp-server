/**
 * The light plugin: engine + output + command layer, exposed as MCP tools, HTTP routes and live
 * WebSocket topics — all generated from the command registry (docs/architecture.md, principle 2).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express, { type Request, type Response, type Router } from "express";
import { diffFolder, packArchive, readArchive, restoreFolder } from "./data/archive.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AuthMiddleware } from "../../core/auth.js";
import type { EventBus } from "../../core/event-bus.js";
import { HttpError } from "../../core/http-errors.js";
import type { LiveTopic, McpPlugin, PluginHealth } from "../../core/plugin.js";
import { throttleMerge } from "../../core/throttle.js";
import { summarizeDescription, type PluginToolCatalogue } from "../../core/tool-catalogue.js";
import type { ScopedConfigStore } from "../../core/config-store.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { registerCoreCommands } from "./commands/core-commands.js";
import { MidiProfileSchema, registerMidiCommands, type MidiProfile } from "./commands/midi-commands.js";
import { registerShowCommands } from "./commands/show-commands.js";
import { registerMoveCommands } from "./commands/move-commands.js";
import { backupPath, registerFileCommands, runAutoBackup, type FileServices } from "./commands/file-commands.js";
import { ActivityLog, commandNotice } from "./activity.js";
import { PROMPTS, promptArgs } from "./mcp-prompts.js";
import { registerImportCommands } from "./commands/import-commands.js";
import { registerSelftestCommands } from "./commands/selftest-commands.js";
import { registerExportCommands } from "./commands/export-commands.js";
import { followPosition, registerSongCommands, type SongServices } from "./commands/song-commands.js";
import { SetlistSchema, SongSchema } from "./songs/songs.js";
import { registerDesignCommands } from "./commands/design-commands.js";
import { loadKnowledge, type Knowledge } from "./knowledge/knowledge.js";
import { ShowRuntime } from "./show/runtime.js";
import { ShowSettingsSchema } from "./show/model.js";
import { Venue } from "./venue/venue.js";
import { FolderStore } from "./data/store.js";
import { MidiHub, type HubMessage } from "./midi/hub.js";
import { MappingSchema, MidiMapper } from "./midi/mapping.js";
import { OscServer } from "./osc/server.js";
import { TempoClock } from "./timing/tempo.js";
import { dataRoot as defaultDataRoot } from "../../core/paths.js";
import { LiveSnapshotFile } from "./data/live-snapshot.js";
import { openApiDocument } from "./commands/openapi.js";
import { getPackageVersion } from "../../core/version.js";
import { CommandError, CommandRegistry, type CommandContext, type CommandDef, type Origin } from "./commands/registry.js";
import { DmxEngine } from "./engine/dmx-engine.js";
import { OutputRouter, type OutputConfig } from "./output/output-router.js";

export const PLUGIN_ID = "light";
/** First look for the day's automatic backup after start (a short test server never writes one), then hourly. */
const AUTO_BACKUP_FIRST_MS = 5 * 60_000;
const AUTO_BACKUP_EVERY_MS = 3600_000;

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
      /** Standby: the show runs but nothing is sent (QLC+ or another console holds the nodes). Kept across restarts. */
      standby: z.boolean().default(false),
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
  /** Start on standby (true) or sending (false), overriding and saving the config (`light serve --standby | --live`). */
  standby?: boolean;
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
  private readonly files: FileServices;
  private changedSinceAutoBackup = false;
  readonly activity = new ActivityLog();
  private autoBackupTimers: NodeJS.Timeout[] = [];
  private songs: SongServices | undefined;
  private readonly liveFile: LiveSnapshotFile;
  private readonly dataRoot: string;
  /** What was resumed at start-up after a restart, if anything. */
  resumed: { looks: string[]; blackout: boolean; song?: string; section?: string } | undefined;

  constructor(private readonly opts: LightPluginOptions) {
    this.config = LightConfigSchema.parse(opts.config?.get() ?? {});
    if (opts.standby !== undefined) this.config = { ...this.config, output: { ...this.config.output, standby: opts.standby } };
    this.engine = new DmxEngine(this.config.universes, { rateHz: opts.tickerRateHz });
    this.router = new OutputRouter(this.config.output as OutputConfig);
    this.commands.onStateChange = () => {
      this.engine.requestFrame();
      this.publish("state", this.state());
    };
    this.commands.onCommand((e) => {
      this.publish("command", commandNotice(e));
      if (e.ok) this.syncMidiFeedback();
    });
    registerCoreCommands(this.commands, this.engine, this.router, async (standby) => {
      this.config = { ...this.config, output: { ...this.config.output, standby } };
      await this.opts.config?.set(this.config);
      if (!standby) this.syncMidiFeedback(true); // take the controllers' LEDs back too
    });

    const dataRoot = opts.dataRoot ?? defaultDataRoot();
    this.dataRoot = dataRoot;
    this.show = new FolderStore(path.join(dataRoot, "shows", this.config.show), path.join(dataRoot, "backups", "shows", this.config.show));
    this.liveFile = new LiveSnapshotFile(path.join(dataRoot, "machine", "live.json"));
    this.venue = new Venue(
      new FolderStore(path.join(dataRoot, "venues", this.config.venue), path.join(dataRoot, "backups", "venues", this.config.venue)),
      this.definitionDirs(this.config.venue),
    );
    this.runtime = new ShowRuntime(this.show, this.venue, this.tempo);
    this.engine.setRenderer((buffers) => this.runtime.render(buffers));
    this.engine.setBlackoutKeep(() => this.venue.positionSlots());
    registerShowCommands(this.commands, this.engine, this.runtime);
    registerMoveCommands(this.commands, this.runtime);
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
    registerSelftestCommands(this.commands, this.engine, this.runtime, () => mappings.list(), () => this.tempo.state().bpm);
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
      run: (command, args) => this.commands.invoke(command, args, { origin: "timeline", can: () => true }),
    };
    registerSongCommands(this.commands, this.songs);
    const knowledgePath = path.join(dataRoot, "private", "knowledge.json");
    let kb: Knowledge | undefined;
    registerDesignCommands(this.commands, this.runtime, this.songs.songs, () => mappings.list(), () => (kb ??= loadKnowledge(knowledgePath)));
    registerImportCommands(this.commands, { runtime: this.runtime, show: this.show, mappings, mapper: this.mapper, tempo: this.tempo, importsDir: path.join(dataRoot, "imports"), fixturesDir: path.join(dataRoot, "fixtures") });
    this.files = {
      dataRoot,
      current: () => ({ show: this.config.show, venue: this.config.venue }),
      open: (id) => this.openShow(id),
      flush: () => {
        this.show.flushLive();
        this.venue.store.flushLive();
      },
      reload: () => {
        this.runtime.resetLive();
        this.reloadFromDisk();
      },
      restore: (bytes) => this.restoreArchive(bytes),
      importQxw: (xml) => this.commands.invoke("import.qxw", { xml, apply: true, force: true }, { origin: "ui", can: () => true }),
    };
    registerFileCommands(this.commands, this.files);
    try {
      if (existsSync(this.activityFile)) this.activity.restore(JSON.parse(readFileSync(this.activityFile, "utf8")), Date.now());
    } catch {
      /* an unreadable log only loses the past lines */
    }
    this.commands.onCommand((e) => this.activity.record(e, this.commands.get(e.name)?.title ?? e.name));
    this.commands.register({
      name: "activity.list",
      title: "Activité récente",
      description: "What changed (the last week, kept across restarts), newest first: command, who (user name, master token, AI client), from where (ui, midi, osc, mcp, timeline), the object acted on, and whether it worked. A burst of the same command (a fader dragged) is one line with a count.",
      right: "show:write",
      readOnly: true,
      profiles: ["setup", "design", "live"],
      schema: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
      run: ({ limit }) => this.activity.list(limit),
    });
    // any change of the show or its venue (a show switch reloads them: a change too) makes the day's automatic backup due
    this.show.onChange(() => (this.changedSinceAutoBackup = true));
    this.venue.store.onChange(() => (this.changedSinceAutoBackup = true));
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

  private definitionDirs(venue: string): string[] {
    return [path.join(this.dataRoot, "fixtures"), path.join(this.dataRoot, "venues", venue, "fixture-definitions")];
  }

  /** Re-reads the show and venue folders (archive restored, show reset or opened) and tells every screen. */
  private reloadFromDisk(): void {
    this.show.reloadAll();
    this.venue.store.reloadAll();
    this.venue.refreshDefinitions();
    this.runtime.reloadSettings();
    this.mapper.setMappings(this.show.collection("mappings", MappingSchema).list());
    this.engine.requestFrame();
    this.publish("state", this.state());
  }

  /** Opens another show and its venue, in place: everything live stops, every screen follows. */
  async openShow(id: string): Promise<void> {
    if (id === this.config.show) return;
    const showRoot = path.join(this.dataRoot, "shows", id);
    const settingsFile = path.join(showRoot, "show.json");
    const venue = ShowSettingsSchema.parse(existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {}).venue;
    this.saveLive();
    this.runtime.resetLive();
    this.engine.setBlackout(false);
    this.show.retarget(showRoot, path.join(this.dataRoot, "backups", "shows", id));
    if (venue !== this.config.venue) this.venue.retarget(path.join(this.dataRoot, "venues", venue), path.join(this.dataRoot, "backups", "venues", venue), this.definitionDirs(venue));
    this.config = { ...this.config, show: id, venue };
    await this.opts.config?.set(this.config);
    if (this.songs) Object.assign(this.songs.state, { setlist: undefined, song: undefined, section: undefined });
    this.reloadFromDisk();
  }

  /** Replaces the current show (and venue, when the archive has one), after copying them to the backups. */
  private restoreArchive(bytes: Uint8Array): { backup: string; files: { show: number; venue: number }; manifest: ReturnType<typeof readArchive>["manifest"] } {
    const content = readArchive(bytes);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backups = path.join(this.dataRoot, "backups", "restore-" + stamp);
    this.runtime.stopAll();
    if (Object.keys(content.show).length) restoreFolder(this.show.root, content.show, path.join(backups, "show"));
    if (Object.keys(content.venue).length) restoreFolder(this.venue.store.root, content.venue, path.join(backups, "venue"));
    this.reloadFromDisk();
    return { manifest: content.manifest, files: { show: Object.keys(content.show).length, venue: Object.keys(content.venue).length }, backup: path.basename(backups) };
  }

  private activeMidiProfile(): { inputs: string[]; feedbackOutput?: string; rtp: MidiProfile["rtp"] } {
    const p = this.config.midi.profiles[this.config.midi.active] ?? MidiProfileSchema.parse({});
    return { inputs: p.inputs, feedbackOutput: p.feedbackOutput, rtp: p.rtp };
  }

  /**
   * MIDI feedback follows the real state, whatever changed it (UI, OSC, MCP, timeline, MIDI):
   * look mappings light up when their look plays, level mappings mirror their group's master.
   */
  /** Sends MIDI feedback for state changes (all of it with `full`); silent on standby, where QLC+ holds the controllers. */
  syncMidiFeedback(full = false): void {
    if (this.router.isStandby()) return;
    const out: number[][] = [];
    for (const m of this.mapper.list()) {
      const target = String(m.on.args.id ?? "");
      if (m.on.command === "look.go") out.push(...this.mapper.syncState(m.id, this.runtime.isActive(target)));
      else if (m.on.command === "group.level") {
        const g = this.runtime.groups.get(target);
        if (g?.master) out.push(...this.mapper.syncState(m.id, !g.master.mute && g.master.level > 0, g.master.level));
      }
    }
    this.hub.sendFeedback(full ? this.mapper.allFeedback() : out);
  }

  /** Every MIDI message: tempo follows the clock; mappings turn the rest into commands. */
  private onMidi(m: HubMessage): void {
    this.tempo.handleMidi(m.msg);
    const t = m.msg.type;
    if (t === "clock" || t === "start" || t === "stop" || t === "continue" || t === "songposition") return;
    this.publish("midi", { monitor: { port: m.port, source: m.source, msg: m.msg, at: Date.now() } });
    // A Program Change selects the rule program carrying that number on that channel (no mapping needed).
    if (m.msg.type === "programchange") {
      const program = this.runtime.programFor(m.msg.channel, m.msg.program);
      if (program && this.runtime.selectProgram(program.id)) {
        this.engine.requestFrame();
        this.publish("state", this.state());
      }
    }
    const out = this.mapper.handle(m.msg, m.port);
    if (!this.router.isStandby()) this.hub.sendFeedback(out.feedback);
    for (const call of out.calls) {
      this.commands.invoke(call.command, call.args, { origin: "midi", can: () => true }).catch((err: Error) => this.publish("midi", { error: `${call.command} : ${err.message}` }));
    }
  }

  private publish(type: string, payload: unknown): void {
    this.opts.eventBus.publish({ pluginId: this.id, type, payload, timestamp: Date.now() });
  }

  state(): { show: { id: string; name: string }; blackout: boolean; universes: number; discovery: string; standby: boolean; foreignSources: string[]; foreignLocal: string[]; program: string | null } {
    return {
      show: { id: this.config.show, name: this.runtime?.settings.name ?? this.config.show },
      program: this.runtime?.activeProgram ?? null,
      blackout: this.engine.isBlackout(),
      universes: this.config.universes,
      discovery: this.router.stats.discovery,
      standby: this.router.isStandby(),
      foreignSources: this.router.foreignSources().map((f) => f.ip),
      // another instance or QLC+ on this very computer: said as such, it is not a stranger on the network
      foreignLocal: this.router.foreignSources().filter((f) => f.local).map((f) => f.ip),
    };
  }

  /** Invokes a command for a caller identified by its credential (HTTP, WS, OSC…). */
  invoke(name: string, args: unknown, origin: Origin, credential?: string): Promise<unknown> {
    const who = this.opts.auth?.nameOf(credential);
    const ctx: CommandContext = { origin, can: (right) => (this.opts.auth ? this.opts.auth.can(credential, right) : true), ...(who ? { who } : {}) };
    return this.commands.invoke(name, args, ctx);
  }

  /** Saves what is playing, for a resume after a restart. */
  saveLive(): void {
    const s = this.songs?.state;
    try {
      this.liveFile.save({ show: this.config.show, looks: this.runtime.activeLooks(), blackout: this.engine.isBlackout(), setlist: s?.setlist, song: s?.song, section: s?.section, program: this.runtime.activeProgram });
    } catch (err) {
      console.warn("sauvegarde de l'état en direct :", (err as Error).message);
    }
  }

  /** Restores a recent live state (crash or quick restart during a service). */
  private resumeLive(): void {
    const snap = this.liveFile.load(this.config.show);
    if (!snap) return;
    const looks = snap.looks.filter((id) => {
      try {
        return this.runtime.looks.get(id) !== undefined && (this.runtime.go(id), true);
      } catch {
        return false;
      }
    });
    this.engine.setBlackout(snap.blackout);
    if (snap.program && this.runtime.programs.get(snap.program)) this.runtime.selectProgram(snap.program);
    if (this.songs) Object.assign(this.songs.state, { setlist: snap.setlist, song: snap.song, section: snap.section });
    this.resumed = { looks, blackout: snap.blackout, song: snap.song, section: snap.section };
    console.warn(`Reprise après redémarrage : ${looks.length} look(s)${snap.blackout ? ", Blackout actif" : ""}${snap.song ? `, chant ${snap.song}` : ""}.`);
  }

  async start(): Promise<void> {
    if (this.opts.standby !== undefined) await this.opts.config?.set(this.config);
    this.resumeLive();
    await this.router.start({ discovery: this.config.discovery });
    if (this.router.isStandby()) console.warn("Sortie en veille : rien n'est envoyé aux nodes (Réglages → Reprendre la main, ou light serve --live).");
    this.engine.start();
    await this.hub.start();
    await this.osc.start().catch((err: Error) => console.warn(`OSC indisponible sur le port ${this.config.osc.port} : ${err.message}`));
    let lastState = "";
    let ticks = 0;
    this.tempoTimer = setInterval(() => {
      this.publish("tempo", this.tempo.state());
      // Output state (standby, other Art-Net sources) changes without commands: check it every second.
      if (++ticks % 4) return;
      this.saveLive();
      if (ticks % 20 === 0) this.saveActivity(); // every 5 s at most, when something happened
      const state = this.state();
      const key = JSON.stringify(state);
      if (key !== lastState) this.publish("state", state);
      lastState = key;
    }, 250);
    this.tempoTimer.unref();
    // the day's automatic backup (data/retention.ts): a first look a few minutes in, then every hour
    const check = () => this.autoBackup();
    this.autoBackupTimers = [setTimeout(check, AUTO_BACKUP_FIRST_MS), setInterval(check, AUTO_BACKUP_EVERY_MS)];
    for (const t of this.autoBackupTimers) t.unref();
    this.started = true;
  }

  /** Writes the day's automatic backup when due, and prunes old copies; never stops the show for it. */
  autoBackup(now = new Date()): string | undefined {
    try {
      const file = runAutoBackup(this.files, this.changedSinceAutoBackup, now);
      if (file) {
        this.changedSinceAutoBackup = false;
        console.log(`Sauvegarde automatique : data/backups/${file}`);
      }
      return file;
    } catch (err) {
      console.warn(`Sauvegarde automatique impossible : ${(err as Error).message}`);
      return undefined;
    }
  }

  /** The activity log survives a restart (data/machine/activity.json, the last week). */
  private get activityFile(): string {
    return path.join(this.dataRoot, "machine", "activity.json");
  }

  /** Writes the activity log when it changed (also called by the CLI, which runs commands in its own process). */
  saveActivity(): void {
    const lines = this.activity.takeChanges();
    if (!lines) return;
    try {
      mkdirSync(path.dirname(this.activityFile), { recursive: true });
      writeFileSync(`${this.activityFile}.tmp`, JSON.stringify(lines));
      renameSync(`${this.activityFile}.tmp`, this.activityFile);
    } catch (err) {
      console.warn(`Journal d'activité non enregistré : ${(err as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    if (this.tempoTimer) clearInterval(this.tempoTimer);
    this.saveActivity();
    for (const t of this.autoBackupTimers) clearTimeout(t);
    if (this.started) this.saveLive();
    this.show.flushLive();
    this.osc.stop();
    this.hub.stop();
    this.engine.stop();
    this.router.stop();
    this.started = false;
  }

  async getHealth(): Promise<PluginHealth> {
    const s = this.router.stats;
    const status = !this.started ? "ERROR" : s.discovery === "unavailable" ? "DEGRADED" : "HEALTHY";
    const rtpError = this.hub.status().rtp.error;
    const warnings = [...(this.hub.localAvailable ? [] : [`MIDI local indisponible : ${this.hub.localError}`]), ...(rtpError ? [`RTP-MIDI indisponible : ${rtpError}`] : [])];
    return {
      status,
      detail: { frames: this.engine.frames, packets: s.packetsSent, errors: s.errors, discovery: s.discovery, nodes: this.router.registry.list().length },
      ...(s.discovery === "unavailable" ? { errorMessage: `découverte Art-Net indisponible (port 6454 occupé ?) : ${s.discoveryError}` } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  /** What a model needs before its first call: safety, cheap reads, safe edits, where to look (docs/specs/mcp.md). */
  getInstructions(): string {
    return [
      "light-mcp-server drives DMX lighting (Art-Net/sACN). Every tool maps to one server command, the same ones the web UI, MIDI and OSC use; you only see the tools your role may call, and rules (UV max, forbidden modes…) are applied last to whatever you do.",
      "Safety: light_panic recalls the safe snapshot (else the safe look, else a Blackout); light_blackout cuts everything. light_output_status says whether the output is in standby (then nothing reaches the rig). Looks marked manualOnly are for a human finger, not for you.",
      "Reading: light_look_list is brief (name, playing, colour, technique kind); read one look whole with light_look_get before changing it with light_look_put (a brief look is refused). light_stage_describe and the light://show, light://venue and light://knowledge resources give the context.",
      "Changing safely: light_show_references says where a look, group or channel fader is used; deletes are refused while something uses it unless force. light_history_list / light_history_restore put an earlier version back, light_history_deleted lists what can come back.",
      "Checking: light_show_lint (references, patch overlaps, missing definitions, ambiguous names), light_venue_patch_check, light_selftest_run. light_activity_list says who did what and from where.",
      "Building a show: patch fixtures, make a canvas, create looks (light_look_from_intent, light_show_autopresets), then light_dashboard_generate.",
    ].join("\n");
  }

  toolRight(name: string): string | undefined {
    return this.commands.list().find((d) => toolName(d.name) === name)?.right;
  }

  registerTools(server: McpServer): void {
    this.registerResources(server);
    for (const p of PROMPTS) {
      server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: promptArgs(p) }, (args: Record<string, string | undefined>) => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: p.text(args ?? {}) } }],
      }));
    }
    for (const def of this.commands.list()) {
      const shape = (def.schema as unknown as z.AnyZodObject).shape ?? {};
      server.registerTool(
        toolName(def.name),
        { title: def.title, description: def.description, inputSchema: shape, annotations: { readOnlyHint: Boolean(def.readOnly) } },
        async (args: unknown, extra: { authInfo?: { token: string } }) => {
          try {
            // Over HTTP every call carries its caller (core/gateway.ts) and is checked against their
            // role; over stdio the client launched the server itself and may do everything.
            const token = extra?.authInfo?.token;
            const can = (right: string) => token === undefined || !this.opts.auth || this.opts.auth.can(token, right);
            const who = token === undefined ? "stdio" : this.opts.auth?.nameOf(token);
            const result = await this.commands.invoke(def.name, args, { origin: "mcp", can, ...(who ? { who } : {}) });
            return { content: [{ type: "text" as const, text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
          } catch (err) {
            return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
          }
        },
      );
    }
  }

  /** MCP resources: readable snapshots for the AI (docs/specs/mcp.md, « Ressources »). */
  private registerResources(server: McpServer): void {
    const json = (uri: URL, value: unknown) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] });
    const sys = { origin: "mcp" as const, can: () => true };
    server.registerResource("show", "light://show", { title: "Show", description: "Looks, palettes, groups, songs, setlists and settings of the current show.", mimeType: "application/json" }, async (uri) =>
      json(uri, {
        settings: this.runtime.settings,
        palettes: this.runtime.palettes.list(),
        looks: this.runtime.looks.list().map(({ technique, ...l }) => ({ ...l, technique: technique.kind })),
        groups: this.runtime.groups.list(),
        songs: await this.commands.invoke("song.list", {}, sys),
        setlists: await this.commands.invoke("setlist.list", {}, sys),
      }),
    );
    server.registerResource("venue", "light://venue", { title: "Lieu", description: "Patch, canvases and rules of the venue.", mimeType: "application/json" }, (uri) =>
      json(uri, { fixtures: this.venue.fixtures.list(), canvases: this.venue.canvases.list().map(({ render, ...c }) => ({ ...c, renderedRanges: render.length })), rules: this.runtime.venueRules.list() }),
    );
    server.registerResource("live", "light://live", { title: "En direct", description: "What is playing now, in plain French: looks, masters, blackout, tempo, song and section.", mimeType: "text/plain" }, async (uri) => {
      const t = this.tempo.state();
      const looks = this.runtime.activeLooks().map((id) => this.runtime.looks.get(id)?.name ?? id);
      const masters = this.runtime.groups.list().filter((g) => g.master).map((g) => `${g.name} ${Math.round((g.master!.mute ? 0 : g.master!.level) * 100)} % (effectif ${Math.round(this.runtime.effectiveLevel(g.id) * 100)} %)`);
      const song = (await this.commands.invoke("song.state", {}, sys)) as { song?: string; section?: string };
      const text = [
        this.engine.isBlackout() ? "BLACKOUT actif." : "",
        `Looks en cours : ${looks.length ? looks.join(", ") : "aucun"}.`,
        masters.length ? `Masters : ${masters.join(" ; ")}.` : "",
        `Tempo : ${t.bpm.toFixed(1)} BPM (${t.source}${t.clockMissing ? ", horloge absente" : ""}).`,
        song.song ? `Chant : ${song.song}, section ${song.section ?? "—"}.` : "",
        this.runtime.lastClamps.length ? `Règles appliquées : ${this.runtime.lastClamps.length} valeur(s) bornée(s).` : "",
      ].filter(Boolean).join("\n");
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
    });
    server.registerResource("stage", "light://stage", { title: "Scène", description: "The stage in plain French: zones (protected ones flagged), fixtures in them and fixtures lighting them.", mimeType: "text/plain" }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: String(await this.commands.invoke("stage.describe", {}, sys)) }],
    }));
    server.registerResource("knowledge", "light://knowledge", { title: "Base de connaissances couleur", description: "Mood → colours and design rules.", mimeType: "application/json" }, async (uri) => json(uri, await this.commands.invoke("knowledge.get", {}, sys)));

    // Read with the caller's own rights: a resource gives nothing its tools would refuse (the log needs show:write).
    const as = (extra: { authInfo?: { token: string } } | undefined) => {
      const token = extra?.authInfo?.token;
      return { origin: "mcp" as const, can: (right: string) => token === undefined || !this.opts.auth || this.opts.auth.can(token, right) };
    };
    server.registerResource("rules", "light://rules", { title: "Règles", description: "Rules of the venue and the show, the rule programs and the active one.", mimeType: "application/json" }, async (uri, extra) =>
      json(uri, { rules: await this.commands.invoke("rule.list", {}, as(extra)), programs: await this.commands.invoke("program.list", {}, as(extra)), activeProgram: this.runtime.activeProgram ?? null }),
    );
    server.registerResource("midi-map", "light://midi/map", { title: "Table MIDI", description: "MIDI mappings as a Markdown table: input, mode, action, label.", mimeType: "text/markdown" }, async (uri, extra) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: String(await this.commands.invoke("export.notes", {}, as(extra))) }],
    }));
    server.registerResource("osc-map", "light://osc/map", { title: "Table OSC", description: "OSC addresses, their parameters and the command each one runs.", mimeType: "application/json" }, async (uri, extra) => json(uri, await this.commands.invoke("osc.table", {}, as(extra))));
    server.registerResource("notes", "light://notes", { title: "Notes", description: "Every note of the show and the venue (looks, groups, fixtures, songs…).", mimeType: "application/json" }, async (uri, extra) => json(uri, await this.commands.invoke("notes.search", { query: "" }, as(extra))));
    server.registerResource("log", "light://log", { title: "Journal d'activité", description: "Who did what, from where, on which object, over the last week (needs the show:write right).", mimeType: "application/json" }, async (uri, extra) =>
      json(uri, await this.commands.invoke("activity.list", { limit: 500 }, as(extra))),
    );
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
    router.get("/openapi.json", (_req: Request, res: Response) => res.json(openApiDocument(this.commands.list(), getPackageVersion())));
    router.get("/commands", (_req: Request, res: Response) => {
      res.json(this.commands.list().map((d) => ({ name: d.name, title: d.title, description: d.description, right: d.right, readOnly: Boolean(d.readOnly), schema: zodToJsonSchema(d.schema) })));
    });
    router.post("/commands/:name", async (req: Request, res: Response) => {
      try {
        // the CLI says so (activity log); anything else over HTTP is the interface or a script
        const origin = req.get("x-light-origin") === "cli" ? "cli" : "ui";
        res.json({ ok: true, result: await this.invoke(String(req.params.name), req.body, origin, credential(req)) });
      } catch (err) {
        const status = err instanceof CommandError ? { unknown: 404, invalid: 400, forbidden: 403, failed: 422 }[err.code] : 500;
        res.status(status).json({ ok: false, error: err instanceof Error ? err.message : String(err), detail: err instanceof CommandError ? err.detail : undefined });
      }
    });
    router.get("/state", (_req, res) => res.json(this.state()));
    router.get("/archive", (req: Request, res: Response) => {
      if (!this.opts.auth?.can(credential(req), "show:write") && this.opts.auth) throw new HttpError(403, "droit requis : show:write");
      const withVenue = req.query.venue !== "0";
      this.show.flushLive(); // live levels not yet on disk
      const zip = packArchive({ show: { id: this.config.show, dir: this.show.root }, venue: withVenue ? { id: this.config.venue, dir: this.venue.store.root } : undefined });
      res.setHeader("content-type", "application/zip");
      res.setHeader("content-disposition", `attachment; filename="${this.config.show}.lightshow"`);
      res.send(Buffer.from(zip));
    });
    router.post("/archive", express.raw({ type: () => true, limit: "64mb" }), (req: Request, res: Response) => {
      if (this.opts.auth && !this.opts.auth.can(credential(req), "show:write")) throw new HttpError(403, "droit requis : show:write");
      let content: ReturnType<typeof readArchive>;
      try {
        content = readArchive(new Uint8Array(req.body as Buffer));
      } catch (err) {
        throw new HttpError(400, `archive illisible : ${(err as Error).message}`);
      }
      if (req.query.dryRun === "1") {
        // preview: what restoring would change, nothing written
        res.json({
          dryRun: true,
          manifest: content.manifest,
          show: Object.keys(content.show).length ? diffFolder(this.show.root, content.show) : null,
          venue: Object.keys(content.venue).length ? diffFolder(this.venue.store.root, content.venue) : null,
        });
        return;
      }
      res.json({ restored: true, ...this.restoreArchive(new Uint8Array(req.body as Buffer)) });
    });
    router.get("/backups/:file", (req: Request, res: Response) => {
      if (this.opts.auth && !this.opts.auth.can(credential(req), "show:write")) throw new HttpError(403, "droit requis : show:write");
      const file = backupPath(this.dataRoot, String(req.params.file));
      if (!file) throw new HttpError(404, "sauvegarde inconnue");
      res.download(file);
    });
  }

  liveTopics(): Record<string, LiveTopic> {
    let lastPreview = "";
    let lastPreviewAt = 0;
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
      /** Live 2D preview: screen colour of every fixture head, read from the output; on change (and every second). */
      preview: {
        channel: "stream",
        source: "frame",
        encode: (payload) => {
          const colors = this.venue.displayColors((payload as { buffers: Uint8Array[] }).buffers);
          const key = JSON.stringify(colors);
          const now = Date.now();
          if (key === lastPreview && now - lastPreviewAt < 1000) return null; // unchanged: once a second for late subscribers
          lastPreview = key;
          lastPreviewAt = now;
          return { fixtures: colors };
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
