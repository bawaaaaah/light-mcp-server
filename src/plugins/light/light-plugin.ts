/**
 * The light plugin: engine + output + command layer, exposed as MCP tools, HTTP routes and live
 * WebSocket topics — all generated from the command registry (docs/architecture.md, principle 2).
 * The constructor wires the pieces in a fixed order (wiring/: MIDI, the knowledge stores, the activity log,
 * the external sync, the live publications, the automatic backup). The order that is part of the behaviour is
 * that of the subscriptions (commands.onCommand: who hears a command first; hub.on; engine.onFrame) and of the
 * collections opened; the command list is sorted by name (registry.ts), whatever the registration order.
 */
import { wsConnectionOf } from "../../core/ws-rest.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express, { type Request, type Response, type Router } from "express";
import { applyRestore, packArchive, previewRestore, readArchive, restoreBackupDir, type RestorePreview, type RestoreResult, type RestoreTargets } from "./data/archive.js";
import { definitionDirsFor, FixturePolicySchema, type FixturePolicy } from "./data/archive-fixtures.js";
import { z } from "zod";
import type { AuthMiddleware } from "../../core/auth.js";
import type { EventBus } from "../../core/event-bus.js";
import { HttpError } from "../../core/http-errors.js";
import type { LiveTopic, McpPlugin, PluginHealth } from "../../core/plugin.js";
import { summarizeDescription, type PluginToolCatalogue } from "../../core/tool-catalogue.js";
import type { ScopedConfigStore } from "../../core/config-store.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { registerCoreCommands } from "./commands/core-commands.js";
import { recallStartupSnapshot, registerShowCommands } from "./commands/show-commands.js";
import { registerTracksCommands } from "./commands/tracks-commands.js";
import { registerMoveCommands } from "./commands/move-commands.js";
import { registerTargetCommands } from "./commands/target-commands.js";
import { backupPath, registerFileCommands, sharedWith, showsOnVenueOrThrow, type FileServices } from "./commands/file-commands.js";
import { registerFixtureModeCommands, showFolder } from "./commands/fixture-mode-commands.js";
import { ActivityLog, commandNotice } from "./activity.js";
import { PROMPTS, promptArgs } from "./mcp-prompts.js";
import { registerImportCommands } from "./commands/import-commands.js";
import { registerLibraryCommands } from "./commands/library-commands.js";
import { registerSelftestCommands } from "./commands/selftest-commands.js";
import { registerExportCommands } from "./commands/export-commands.js";
import { registerSongCommands, type SongServices } from "./commands/song-commands.js";
import { SetlistSchema, SongSchema } from "./songs/songs.js";
import { registerDesignCommands, type IntentionStores } from "./commands/design-commands.js";
import { registerColourPresetCommands, type ColourStores } from "./commands/colour-preset-commands.js";
import { ShowRuntime } from "./show/runtime.js";
import { groupsOfOtherShows } from "./show/shared-venue.js";
import { ShowSettingsSchema } from "./show/model.js";
import { Venue } from "./venue/venue.js";
import { FolderStore, ID_RE } from "./data/store.js";
import type { MidiHub } from "./midi/hub.js";
import { MidiMapper } from "./midi/mapping.js";
import { OscServer } from "./osc/server.js";
import type { Os2lServer } from "./os2l/server.js";
import type { AbleSetClient } from "./ableset/ableset.js";
import { LinkListener } from "./link/link.js";
import { TempoClock } from "./timing/tempo.js";
import { dataRoot as defaultDataRoot } from "../../core/paths.js";
import { LiveSnapshotFile } from "./data/live-snapshot.js";
import { openApiDocument } from "./commands/openapi.js";
import { getPackageVersion } from "../../core/version.js";
import { argsShape, CommandError, CommandRegistry, commandTitle, type CommandContext, type CommandDef, type Origin } from "./commands/registry.js";
import { toolHints } from "./commands/tool-hints.js";
import { DmxEngine } from "./engine/dmx-engine.js";
import { OutputRouter, type OutputConfig } from "./output/output-router.js";
import { DmxUsbOutputs, type SerialBinding } from "./output/dmx-usb.js";
import { LoopDelay } from "../../core/loop-delay.js";
import { say } from "../../core/lang.js";
import { ConfigCell, LightConfigSchema, type LightConfig } from "./light-config.js";
import { MidiWiring } from "./wiring/midi-wiring.js";
import { attachSongIntentions, intentionLineLabel, machineRestoreHooks, migrateIntentionWords, openColours, openIntentions, showExtraFiles, showIntentionHooks } from "./wiring/knowledge-wiring.js";
import { activityFile, restoreActivity, wireActivity, writeActivity } from "./wiring/activity-wiring.js";
import { ExternalSync } from "./wiring/external-sync.js";
import { wireLivePublications } from "./wiring/live-publications.js";
import { AutoBackup } from "./wiring/auto-backup.js";
import { motionLockSummary, movingHeadsSummary, type MotionLockSummary } from "./show/motion-summary.js";
import { LIGHT_INSTRUCTIONS, registerMcpResources } from "./mcp-resources.js";

export { LightConfigSchema, type LightConfig } from "./light-config.js";
export type { MidiJournalEntry } from "./wiring/midi-wiring.js";

export const PLUGIN_ID = "light";

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
  /** The show runtime's clock (ms): fades, holds and voluntary resets follow it. */
  now?: () => number;
  /** The serial ports for DMX USB: null, none; a fake one in tests. */
  serial?: SerialBinding | null;
}

export class LightPlugin implements McpPlugin {
  readonly id = PLUGIN_ID;
  readonly name = "Lumière";
  readonly commands = new CommandRegistry();
  readonly engine: DmxEngine;
  readonly router: OutputRouter;
  readonly show: FolderStore;
  /** The layers of the colour knowledge base and the intentions of this machine and of the show (T15). */
  readonly intentions: IntentionStores;
  /** The colour presets of the show and of the personal library (T41). */
  readonly colours: ColourStores;
  readonly venue: Venue;
  readonly runtime: ShowRuntime;
  readonly hub: MidiHub;
  readonly mapper = new MidiMapper();
  readonly tempo = new TempoClock();
  readonly osc: OscServer;
  readonly os2l: Os2lServer;
  readonly ableset: AbleSetClient;
  /** How long Node keeps a message waiting (midi.status → node). */
  readonly loopDelay = new LoopDelay();
  /** Ableton Link, listened to only while it is the tempo source: its tempo, and its beats once measured. */
  readonly link = new LinkListener((bpm, beatAgoMs) => this.tempo.state().source === "link" && this.tempo.follow(bpm, beatAgoMs, "link"));
  /** The config, changed only through it (put, then save). */
  private readonly configCell: ConfigCell;
  private get config(): LightConfig {
    return this.configCell.get();
  }
  private started = false;
  private tempoTimer: NodeJS.Timeout | undefined;
  private readonly files: FileServices;
  readonly activity = new ActivityLog();
  private songs: SongServices | undefined;
  private readonly liveFile: LiveSnapshotFile;
  private readonly dataRoot: string;
  /** MIDI in: the mappings, the journal and the controllers' feedback. */
  private readonly midi: MidiWiring;
  /** The DJ (OS2L), AbleSet and Ableton Link. */
  private readonly sync: ExternalSync;
  private readonly backups: AutoBackup;
  /** What was resumed at start-up after a restart, if anything. */
  resumed: { looks: string[]; blackout: boolean; song?: string; section?: string } | undefined;

  constructor(private readonly opts: LightPluginOptions) {
    const parsed = LightConfigSchema.parse(opts.config?.get() ?? {});
    this.configCell = new ConfigCell(opts.standby === undefined ? parsed : { ...parsed, output: { ...parsed.output, standby: opts.standby } }, () => this.opts.config);
    const config = this.configCell;
    const publish = (type: string, payload: unknown) => this.publish(type, payload);

    // output and engine; every command's outcome first goes to the screens and the MIDI feedback
    this.engine = new DmxEngine(this.config.universes, { rateHz: opts.tickerRateHz });
    this.router = new OutputRouter(this.config.output as OutputConfig, new DmxUsbOutputs(opts.serial));
    this.commands.onStateChange = () => {
      this.engine.requestFrame();
      this.publish("state", this.state());
    };
    this.commands.onCommand((e) => {
      this.publish("command", commandNotice(e));
      // a lock command refused (a MIDI press on a hard lock, decision V1) flipped its mapping all the same: put it back
      if (e.ok || e.name.startsWith("motion.")) this.syncMidiFeedback();
    });
    registerCoreCommands(
      this.commands,
      this.engine,
      this.router,
      async (standby) => {
        config.put({ ...this.config, output: { ...this.config.output, standby } });
        await config.save();
        if (!standby) this.syncMidiFeedback(true); // take the controllers' LEDs back too
      },
      async (routes) => {
        config.put({ ...this.config, output: { ...this.config.output, routes } });
        await config.save();
      },
    );

    // show and venue
    const dataRoot = opts.dataRoot ?? defaultDataRoot();
    this.dataRoot = dataRoot;
    this.show = new FolderStore(path.join(dataRoot, "shows", this.config.show), path.join(dataRoot, "backups", "shows", this.config.show));
    this.liveFile = new LiveSnapshotFile(path.join(dataRoot, "machine", "live.json"));
    this.venue = new Venue(
      new FolderStore(path.join(dataRoot, "venues", this.config.venue), path.join(dataRoot, "backups", "venues", this.config.venue)),
      this.definitionDirs(this.config.venue),
    );
    this.runtime = new ShowRuntime(this.show, this.venue, this.tempo, opts.now);
    this.runtime.otherShowsGroups = () => groupsOfOtherShows(dataRoot, this.config.show, this.config.venue);
    this.engine.setRenderer((buffers) => this.runtime.render(buffers));
    this.engine.setGuard((buffers) => this.runtime.guard(buffers));
    // the hard motion lock freezes pan/tilt bytes in the guard, but leaves the DMX console's (T26, Q4)
    this.runtime.consoleSlots = () => this.engine.parkedSlots();
    this.engine.setBlackoutKeep(() => this.venue.positionSlots());
    // the other shows on the open venue, read from disk at the time of a delete (file-commands.ts)
    const otherShowsSharing = () => sharedWith({ dataRoot, current: () => ({ show: this.config.show, venue: this.config.venue }) });
    const showApi = registerShowCommands(this.commands, this.engine, this.runtime, {
      sharedWith: otherShowsSharing,
      standby: () => this.router.isStandby(),
      ...showIntentionHooks(() => this.intentions, () => ({ songs: this.songs?.songs.list() ?? [], looks: this.runtime.looks.list() })),
    });
    // a fixture's DMX mode, and a channel's working mode (T6); a mode changed « for every show » rewrites their folders
    registerFixtureModeCommands(this.commands, this.engine, this.runtime, showApi, {
      sharedWith: otherShowsSharing,
      otherShows: () => showsOnVenueOrThrow(dataRoot, this.config.venue, this.config.show).map(({ id, settings }) => showFolder(dataRoot, id, settings.name || id)),
      place: () => ({ show: this.config.show, venue: this.config.venue }),
    });
    registerMoveCommands(this.commands, this.runtime, () => this.nextFrame());
    registerTargetCommands(this.commands, this.runtime);
    registerTracksCommands(this.commands, this.runtime);

    // MIDI: the show's mappings, the hub, the midi.* commands
    this.midi = new MidiWiring({ commands: this.commands, engine: this.engine, router: this.router, runtime: this.runtime, show: this.show, mapper: this.mapper, tempo: this.tempo, loopDelay: this.loopDelay, config: config.section("midi"), ...(opts.midiNative === null ? { midiNative: null } : {}), publish, state: () => this.state() });
    this.hub = this.midi.hub;
    const mappings = this.midi.mappings;
    registerSelftestCommands(this.commands, this.engine, this.runtime, () => mappings.list(), () => this.tempo.state().bpm);
    registerExportCommands(this.commands, this.runtime, () => mappings.list(), dataRoot);

    // songs and setlists
    const songs: SongServices = {
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
    this.songs = songs;
    registerSongCommands(this.commands, songs);

    // the knowledge: intentions (T15), then the colour presets (T41), the imports and the fixture library (T20b)
    const knowledge = { dataRoot, show: this.show, currentShow: () => this.config.show, ...(opts.now ? { now: opts.now } : {}) };
    const { personal, intentions } = openIntentions(knowledge);
    this.intentions = intentions;
    attachSongIntentions(songs, intentions);
    registerDesignCommands(this.commands, this.runtime, songs.songs, () => mappings.list(), this.intentions, (id) => this.colours.show.has(id) || this.colours.personal.has(id));
    this.colours = openColours({ ...knowledge, personal, mappings, songs: songs.songs });
    registerColourPresetCommands(this.commands, this.runtime, this.colours);
    registerImportCommands(this.commands, { runtime: this.runtime, show: this.show, mappings, mapper: this.mapper, tempo: this.tempo, importsDir: path.join(dataRoot, "imports"), fixturesDir: path.join(dataRoot, "fixtures"), ...(opts.now ? { now: opts.now } : {}) });
    // the fixture library (T20b): list, duplicates, duplicate, delete to a trash, merge (pick or alias)
    registerLibraryCommands(this.commands, { runtime: this.runtime, dataRoot, venue: () => this.config.venue, ...(opts.now ? { now: opts.now } : {}) });

    // files: open, copy, archive, restore, backups
    this.files = {
      dataRoot,
      current: () => ({ show: this.config.show, venue: this.config.venue }),
      open: (id) => this.openShow(id),
      flush: () => {
        this.runtime.flushHeld(); // where a locked head is held, before a copy, an archive or a rename re-reads the show
        this.show.flushLive();
        this.venue.store.flushLive();
      },
      flipsMoveFrozen: (fixture, before, after) => this.runtime.flipsMoveFrozen(fixture, before, after),
      reload: () => {
        this.runtime.resetLive();
        this.reloadFromDisk();
      },
      restore: (bytes, fixtures, keepMachine) => this.restoreArchive(bytes, fixtures, keepMachine),
      preview: (bytes, fixtures) => this.previewArchive(bytes, fixtures),
      importQxw: (xml) => this.commands.invoke("import.qxw", { xml, apply: true, force: true }, { origin: "ui", can: () => true }),
      showExtra: () => this.showExtra(),
    };
    registerFileCommands(this.commands, this.files);

    // the activity log, read back from the last run, then recording every command
    restoreActivity(this.activity, activityFile(dataRoot));
    wireActivity(this.commands, this.activity, (args) => intentionLineLabel(this.intentions, args));
    // the personal intentions a show uses go into its backups (T15): a change there is a change of the backup
    this.backups = new AutoBackup(this.files);
    this.backups.watch([this.show, personal, this.venue.store]);

    // OSC, then the DJ (OS2L), AbleSet and Link
    this.osc = new OscServer(this.config.osc, this.commands, (command, args) => this.commands.invoke(command, args, { origin: "osc", can: () => true }));
    this.sync = new ExternalSync({ commands: this.commands, runtime: this.runtime, songs, tempo: this.tempo, link: this.link, hub: this.hub, os2l: config.section("os2l"), ableset: config.section("ableset") });
    this.os2l = this.sync.os2l;
    this.ableset = this.sync.ableset;

    // every frame to the nodes and the dashboards
    wireLivePublications({ engine: this.engine, router: this.router, runtime: this.runtime, songs, publish });
  }

  private definitionDirs(venue: string): string[] {
    return definitionDirsFor(this.dataRoot, venue);
  }

  /** Set by start(): the show's loads migrate its intention references from then on (never offline, T15b). */
  private serving = false;

  /**
   * The words of the show's songs (mood) and looks (ambiance: tags) written by name become the id of
   * the intention they name, where one intention only answers to the name (T15b): at the show's load
   * by the server (start, open, restore, reset; never the offline CLI), once (an id stays an id: loading
   * again writes nothing), each change kept in the history as any put. An ambiguous name, a masked one
   * or a free word stay as they are (show.lint says the ambiguous ones). Nothing while the private
   * intentions file is unreadable. Public for the tests: start() calls it.
   */
  migrateIntentionRefs(): void {
    this.serving = true;
    this.migrateLoaded();
  }

  private migrateLoaded(): void {
    if (!this.serving) return;
    migrateIntentionWords(this.intentions, this.songs?.songs, this.runtime.looks);
  }

  /** Re-reads the show and venue folders (archive restored, show reset or opened) and tells every screen. */
  private reloadFromDisk(): void {
    this.show.reloadAll();
    this.migrateLoaded();
    this.venue.reload(); // an archive restored may hold model overrides under an old key
    this.runtime.reloadSettings();
    this.mapper.setMappings(this.midi.mappings.list()); // the guarded collection, re-read by reloadAll
    this.engine.requestFrame();
    this.publish("state", this.state());
  }

  /** Opens another show and its venue, in place: everything live stops, every screen follows. */
  async openShow(id: string): Promise<void> {
    const showRoot = path.join(this.dataRoot, "shows", id);
    const settingsFile = path.join(showRoot, "show.json");
    const venue = ShowSettingsSchema.parse(existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {}).venue;
    // a folder name: a hand-edited show.json must not open a venue outside data/venues
    if (!ID_RE.test(venue)) throw new Error(say(`lieu invalide dans le show ${id} : ${venue}`, `invalid venue in show ${id}: ${venue}`));
    // the open show again is a no-op, unless its venue changed (show.venue.set / detach): then it follows
    if (id === this.config.show && venue === this.config.venue) return;
    // where the locked heads are frozen goes to the show they were frozen in, before it is left (T26)
    this.runtime.flushHeld();
    this.saveLive();
    this.runtime.resetLive();
    this.engine.setBlackout(false);
    this.show.retarget(showRoot, path.join(this.dataRoot, "backups", "shows", id));
    if (venue !== this.config.venue) this.venue.retarget(path.join(this.dataRoot, "venues", venue), path.join(this.dataRoot, "backups", "venues", venue), this.definitionDirs(venue));
    this.configCell.put({ ...this.config, show: id, venue });
    if (this.songs) Object.assign(this.songs.state, { setlist: undefined, song: undefined, section: undefined });
    // from the retarget to here, nothing awaits: no frame can write the old show's settings into the new folder
    this.reloadFromDisk();
    this.recallStartup(); // the opened show's own startup snapshot
    await this.configCell.save();
  }

  /**
   * The intentions of this machine (personal library, private file) the open show names, as files of
   * its own: its archives carry them, so that a restore anywhere brings them back as the show's (T15).
   */
  showExtra(): Record<string, string> {
    return showExtraFiles(this.intentions, this.colours, { songs: this.songs?.songs.list() ?? [], looks: this.runtime.looks.list() });
  }

  restoreTargets(): RestoreTargets {
    return {
      showDir: this.show.root,
      venueDir: this.venue.store.root,
      venueId: this.config.venue,
      definitionDirs: this.definitionDirs(this.config.venue),
      fixturesDir: path.join(this.dataRoot, "fixtures"),
      ...machineRestoreHooks(this.intentions, this.colours),
    };
  }

  /** What restoring an archive would change (show, venue, definitions); nothing is written. */
  previewArchive(bytes: Uint8Array, fixtures: FixturePolicy = "missing"): RestorePreview {
    return previewRestore(readArchive(bytes), this.restoreTargets(), fixtures);
  }

  /**
   * Replaces the current show (and venue, when the archive has one), after copying them to the
   * backups, and merges the archive's fixture definitions into the library as the policy says.
   * `keepMachine`: intentions of the archive (ids) whose twin of this machine is kept instead (T15b).
   */
  private restoreArchive(bytes: Uint8Array, fixtures: FixturePolicy = "missing", keepMachine: readonly string[] = []): RestoreResult & { manifest: ReturnType<typeof readArchive>["manifest"] } {
    const content = readArchive(bytes);
    this.runtime.flushHeld(); // the show replaced is backed up with its heads where they are frozen (T26)
    this.runtime.stopAll();
    try {
      return { manifest: content.manifest, ...applyRestore(content, this.restoreTargets(), fixtures, restoreBackupDir(this.dataRoot), keepMachine) };
    } finally {
      this.reloadFromDisk(); // also re-reads the definitions that were added or replaced; after a failure, what is on disk now
    }
  }

  /** Sends MIDI feedback for state changes (all of it with `full`); silent on standby, where QLC+ holds the controllers. */
  syncMidiFeedback(full = false): void {
    this.midi.syncFeedback(full);
  }

  /** Resolves true after the next frame the engine renders, false when none comes within 100 ms (the engine does not run). */
  private nextFrame(): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (came: boolean) => {
        off();
        clearTimeout(timer);
        resolve(came);
      };
      const off = this.engine.onFrame(() => done(true));
      const timer = setTimeout(() => done(false), 100);
      this.engine.requestFrame();
    });
  }

  private publish(type: string, payload: unknown): void {
    this.opts.eventBus.publish({ pluginId: this.id, type, payload, timestamp: Date.now() });
  }

  state(): { show: { id: string; name: string }; blackout: boolean; universes: number; discovery: string; standby: boolean; foreignSources: string[]; foreignLocal: string[]; program: string | null; parked: number; panicUndo: boolean; liveAi: boolean; grandMaster: number; grandMasterSmoothed: boolean; motionLock: MotionLockSummary; movingHeads: { total: number; frozen: number; hard: number } } {
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
      // channels forced from the DMX console: over the show until released, so said on every page
      parked: this.engine.parkedCount(),
      // a Panic pressed by mistake can be undone for a minute: the Live shows « ↶ Revenir » meanwhile
      panicUndo: this.runtime?.panicUndoUntil() !== undefined,
      // AI clients may touch up the service live: said on every page while it is so
      liveAi: Boolean(this.runtime?.settings.liveAi),
      grandMaster: this.runtime?.settings.grandMaster ?? 1,
      grandMasterSmoothed: Boolean(this.runtime?.settings.grandMasterSmoothing),
      // « Figer les lyres » (T26): said on every page; `effective` is the strictest level a moving head is under (the
      // badge: a head frozen hard under a soft global lock is « everything frozen » for it)
      motionLock: motionLockSummary(this.runtime),
      // the installed moving heads and how many of them are frozen (effective level not off): the top bar shows its
      // « Figer les lyres » button only where the venue has heads, and says when only some are frozen
      movingHeads: movingHeadsSummary(this.runtime),
    };
  }

  /** Invokes a command for a caller identified by its credential (HTTP, WS, OSC…). */
  invoke(name: string, args: unknown, origin: Origin, credential?: string, connection?: string): Promise<unknown> {
    const who = this.opts.auth?.nameOf(credential);
    const role = this.opts.auth?.roleOf(credential)?.id;
    const ctx: CommandContext = { origin, can: (right) => (this.opts.auth ? this.opts.auth.can(credential, right) : true), ...(who ? { who } : {}), ...(role ? { role } : {}), ...(connection ? { connection } : {}) };
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
  private resumeLive(): boolean {
    const snap = this.liveFile.load(this.config.show);
    if (!snap) return false;
    // A clean stop with nothing playing saves an empty state: it must not win over the startup snapshot.
    if (!snap.looks.length && !snap.blackout && !snap.song && !snap.section) return false;
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
    return true;
  }

  /** Recalls the open show's startup snapshot (output standby is not touched: the state is applied, nothing is sent on standby). */
  private recallStartup(): void {
    try {
      const done = recallStartupSnapshot(this.engine, this.runtime);
      if (!done) return;
      console.warn("missing" in done ? `Instantané de démarrage introuvable, ignoré : ${done.missing}.` : `Instantané de démarrage rappelé : ${done.name}`);
    } catch (err) {
      console.warn("instantané de démarrage :", (err as Error).message);
    }
  }

  async start(): Promise<void> {
    this.migrateIntentionRefs(); // the show's words by name become ids, now and at each load (T15b)
    if (this.opts.standby !== undefined) await this.configCell.save();
    if (!this.resumeLive()) this.recallStartup(); // a recent crash resume wins over the startup snapshot
    this.loopDelay.start();
    await this.router.start({ discovery: this.config.discovery });
    if (this.router.isStandby()) console.warn("Sortie en veille : rien n'est envoyé aux nodes (Réglages → Reprendre la main, ou light serve --live).");
    this.engine.start();
    await this.hub.start();
    await this.osc.start().catch((err: Error) => console.warn(`OSC indisponible sur le port ${this.config.osc.port} : ${err.message}`));
    await this.sync.startOs2l();
    this.midi.startClock();
    await this.ableset.start();
    let lastState = "";
    let ticks = 0;
    this.tempoTimer = setInterval(() => {
      this.sync.handBackToMidi();
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
    this.backups.start(() => this.autoBackup());
    this.started = true;
  }

  /** Writes the day's automatic backup when due, and prunes old copies; never stops the show for it. */
  autoBackup(now = new Date()): string | undefined {
    return this.backups.run(now);
  }

  /** Writes the activity log when it changed (also called by the CLI, which runs commands in its own process). */
  saveActivity(): void {
    writeActivity(this.activity, activityFile(this.dataRoot));
  }

  async stop(): Promise<void> {
    if (this.tempoTimer) clearInterval(this.tempoTimer);
    this.loopDelay.stop();
    this.saveActivity();
    this.backups.stop();
    if (this.started) this.saveLive();
    this.show.flushLive();
    this.runtime.flushHeld(); // the pad's last move under a soft lock, still within its second (T26)
    this.osc.stop();
    this.midi.stopClock();
    await this.ableset.stop();
    await this.link.stop();
    await this.sync.stopOs2l();
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
      ...(s.discovery === "unavailable" ? { errorMessage: say(`découverte Art-Net indisponible (port 6454 occupé ?) : ${s.discoveryError}`, `Art-Net discovery unavailable (port 6454 taken?): ${s.discoveryError}`) } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  /** What a model needs before its first call: safety, cheap reads, safe edits, where to look (docs/specs/mcp.md). */
  getInstructions(): string {
    return LIGHT_INSTRUCTIONS;
  }

  toolRight(name: string): string | undefined {
    return this.commands.list().find((d) => toolName(d.name) === name)?.right;
  }

  registerTools(server: McpServer): void {
    registerMcpResources(server, { commands: this.commands, runtime: this.runtime, venue: this.venue, engine: this.engine, router: this.router, tempo: this.tempo, auth: this.opts.auth });
    for (const p of PROMPTS) {
      server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: promptArgs(p) }, (args: Record<string, string | undefined>) => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: p.text(args ?? {}) } }],
      }));
    }
    for (const def of this.commands.list()) {
      const shape = argsShape(def);
      server.registerTool(
        toolName(def.name),
        { title: def.title, description: def.description, inputSchema: shape, annotations: toolHints(def) },
        async (args: unknown, extra: { authInfo?: { token: string } }) => {
          try {
            // Over HTTP every call carries its caller (core/gateway.ts) and is checked against their
            // role; over stdio the client launched the server itself and may do everything.
            const token = extra?.authInfo?.token;
            const can = (right: string) => token === undefined || !this.opts.auth || this.opts.auth.can(token, right);
            const who = token === undefined ? "stdio" : this.opts.auth?.nameOf(token);
            const role = token === undefined ? undefined : this.opts.auth?.roleOf(token)?.id;
            const result = await this.commands.invoke(def.name, args, { origin: "mcp", can, ...(who ? { who } : {}), ...(role ? { role } : {}) });
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
    return z.toJSONSchema(LightConfigSchema, { io: "input", reused: "inline", unrepresentable: "any" });
  }

  getConfig(): unknown {
    return this.config;
  }

  async setConfig(config: unknown): Promise<void> {
    const next = LightConfigSchema.parse(config);
    if (next.universes !== this.config.universes) throw new HttpError(409, say("changer le nombre d'univers demande un redémarrage", "changing the number of universes needs a restart"));
    this.configCell.put(next);
    this.router.setConfig(next.output as OutputConfig);
    await this.configCell.save();
  }

  registerHttpRoutes(router: Router): void {
    const credential = (req: Request) => this.opts.auth?.bearerOf(req);
    router.get("/openapi.json", (_req: Request, res: Response) => res.json(openApiDocument(this.commands.list(), getPackageVersion())));
    router.get("/commands", (_req: Request, res: Response) => {
      res.json(this.commands.list().map((d) => ({ name: d.name, title: commandTitle(d), description: d.description, right: d.right, readOnly: Boolean(d.readOnly), schema: z.toJSONSchema(d.schema, { io: "input", reused: "inline", unrepresentable: "any" }) })));
    });
    router.post("/commands/:name", async (req: Request, res: Response) => {
      try {
        // the CLI says so (activity log); anything else over HTTP is the interface or a script
        const origin = req.get("x-light-origin") === "cli" ? "cli" : "ui";
        // the live connection it came over, if any: read from the transport, never from the request
        res.json({ ok: true, result: await this.invoke(String(req.params.name), req.body, origin, credential(req), wsConnectionOf(req)) });
      } catch (err) {
        const status = err instanceof CommandError ? { unknown: 404, invalid: 400, forbidden: 403, failed: 422 }[err.code] : 500;
        res.status(status).json({ ok: false, error: err instanceof Error ? err.message : String(err), detail: err instanceof CommandError ? err.detail : undefined });
      }
    });
    router.get("/state", (_req, res) => res.json(this.state()));
    router.get("/archive", (req: Request, res: Response) => {
      if (!this.opts.auth?.can(credential(req), "show:write") && this.opts.auth) throw new HttpError(403, say("droit requis : show:write", "right required: show:write"));
      const withVenue = req.query.venue !== "0";
      this.show.flushLive(); // live levels not yet on disk
      const zip = packArchive({ show: { id: this.config.show, dir: this.show.root, extra: this.showExtra() }, venue: withVenue ? { id: this.config.venue, dir: this.venue.store.root } : undefined, definitionDirs: this.definitionDirs(this.config.venue) });
      res.setHeader("content-type", "application/zip");
      res.setHeader("content-disposition", `attachment; filename="${this.config.show}.lightshow"`);
      res.send(Buffer.from(zip));
    });
    router.post("/archive", express.raw({ type: () => true, limit: "64mb" }), (req: Request, res: Response) => {
      if (this.opts.auth && !this.opts.auth.can(credential(req), "show:write")) throw new HttpError(403, say("droit requis : show:write", "right required: show:write"));
      const policy = FixturePolicySchema.safeParse(req.query.fixtures ?? "missing");
      if (!policy.success) throw new HttpError(400, say("fixtures : missing, replace ou none", "fixtures: missing, replace or none"));
      const bytes = new Uint8Array(req.body as Buffer);
      try {
        readArchive(bytes);
      } catch (err) {
        throw new HttpError(400, say(`archive illisible : ${(err as Error).message}`, `unreadable archive: ${(err as Error).message}`));
      }
      // preview: what restoring would change, nothing written
      if (req.query.dryRun === "1") return void res.json(this.previewArchive(bytes, policy.data));
      // keepMachine: the archive's intentions (ids, comma separated) whose twin of this machine is kept (T15b)
      const keep = typeof req.query.keepMachine === "string" ? req.query.keepMachine.split(",").filter(Boolean) : [];
      res.json({ restored: true, ...this.restoreArchive(bytes, policy.data, keep) });
    });
    router.get("/backups/:file", (req: Request, res: Response) => {
      if (this.opts.auth && !this.opts.auth.can(credential(req), "show:write")) throw new HttpError(403, say("droit requis : show:write", "right required: show:write"));
      const file = backupPath(this.dataRoot, String(req.params.file));
      if (!file) throw new HttpError(404, say("sauvegarde inconnue", "unknown backup"));
      res.download(file);
    });
  }

  /** A browser's Web MIDI relay is a sustained flow: past its own rate a message is dropped, never the connection closed. */
  liveLossyRoutes(): readonly string[] {
    return ["commands/midi.in"];
  }

  /** A Web MIDI batch dropped (its rate exceeded): counted, and said on the MIDI page's monitor. */
  liveRequestDropped(): void {
    this.midi.dropped();
  }

  /** A browser's connection closed: the Web MIDI inputs it relayed go (as the « web » port-loss setting says). */
  liveConnectionClosed(id: string): void {
    this.midi.clientClosed(id);
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
      /** Live 2D preview: screen colour of every fixture head, the strobing fixtures and where beams go, read from the output; on change (and every second). */
      preview: {
        channel: "stream",
        source: "frame",
        encode: (payload) => {
          const { buffers } = payload as { buffers: Uint8Array[] };
          const update = { fixtures: this.venue.displayColors(buffers), strobe: this.venue.strobing(buffers), beams: this.venue.beams(buffers, this.runtime.zones.list()) };
          const key = JSON.stringify(update);
          const now = Date.now();
          if (key === lastPreview && now - lastPreviewAt < 1000) return null; // unchanged: once a second for late subscribers
          lastPreview = key;
          lastPreviewAt = now;
          return update;
        },
      },
      state: { channel: "control" },
      nodes: { channel: "control" },
      command: { channel: "control" },
      midi: { channel: "control" },
      tempo: { channel: "control" },
      rules: { channel: "control" },
      /** Smoothed faders on their way: the level each one sends (groups-masters.md, « Lissage »). */
      glide: { channel: "control" },
      /**
       * Why each moving head is where it is (position.list's report), on a change of layer, owner, lock, rest or glide
       * start/end (engine-effects-timing.md, « Couche Mouvement »). Not a position feed: sent, position and remainingMs
       * are those of the message's moment and are not followed (read position.list, or the light:dmx stream).
       */
      motion: { channel: "control" },
      song: { channel: "control" },
    };
  }
}
