/**
 * Show runtime: the playing state of a show on a venue, rendered into DMX on every engine frame.
 *
 * Pipeline (docs/architecture.md): active looks → canvas colours (scaled, fixture by fixture, by the
 * masters of the groups that include them and do not already dose the fixture, skipping fixtures of
 * groups that exclude them) → intensity per fixture = grand master × the master of every DCA covering
 * it, each once (show/dca.ts) → venue.toDmx, raw dimmers dosed like painted ones → channel faders.
 */
import type { Collection, FolderStore } from "../data/store.js";
import { Glide } from "../engine/glide.js";
import { LookPlayer, ease } from "../engine/player.js";
import { generateSteps, OFF, scaleColor, type Step, type Technique } from "../engine/techniques.js";
import type { MoveFade, Position } from "../engine/move.js";
import { claimKey, claimsAxis, ownerOfClaimKey, emptyMotionState, FALLBACK_BPM, holdMotion, isHeld, releasedOf, releaseMotion, resolveMotion, type Axis, type AxisLayer, type AxisMode, type HeadStatus, type LockLevel, type MotionClaim, type MotionState } from "../engine/motion.js";
import { aimAt } from "../venue/aim.js";
import type { ColorComponent, FixtureChannel } from "../venue/qxf-import.js";
import { motionOffsets, verbatimOffsets, type TrackLayer } from "../venue/tracks.js";
import { addWeighted, aimSetupOf, emptyFrame, mergeColors, rawLevelApplies, settle, splitByShown, weighted, type AttributeFrame, type Canvas, type Color, type RawWrite, type ResolvedFixture, type Venue, type WeightedColors, type WheelChoice } from "../venue/venue.js";
import { slotHex } from "../venue/color-wheel.js";
import { applyHolds, applyRules, applySpeeds, applySteady, RuleProgramSchema, RuleSchema, rulesInForce, type Clamp, type Rule, type RuleProgram } from "../rules/rules.js";
import { holdAtRest, isBuiltinRule, RESET_RULE_ID, RESET_WINDOW_MS, resetChannels, resetProtectionRule, type ResetChannel } from "../rules/reset-protection.js";
import { affectedGroups, proposeTypeGrouping, type ExistingGroup, type TypeGrouping } from "../venue/grouping.js";
import { beamCrosses, ZoneSchema, zoneOf, type Zone } from "../venue/stage.js";
import { DcaIndex } from "./dca.js";
import { carriesLight, Doses, isLight, type LightOffsets } from "./doses.js";
import { ChannelFaderSchema, GroupSchema, LookSchema, PaletteSchema, ShowSettingsSchema, SnapshotSchema, type ChannelFader, type Group, type Look, type Palette, type ShowSettings, type Snapshot } from "./model.js";
import { say } from "../../../core/lang.js";

/** How long a Panic stays undoable. */
export const PANIC_UNDO_MS = 60_000;

/** A value rendered with its object keys sorted: two looks saved with a `map` in another key order are the same look. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** What a look plays, without what only names or files it (name, tags — its folder —, notes): renaming or filing a look changes nothing on stage. */
function played(look: Look): string {
  const { name: _name, tags: _tags, notes: _notes, ...rest } = look;
  return canonical(rest);
}

export interface TempoSource {
  /** `bpm`: the tempo a glide given in beats is timed at (the motion layer); 120 when the source gives none. */
  state(): { beats: number; bpm?: number };
}

/** A manual position (XY pad, aiming, a named position recalled): one claim of the motion layer per head. */
interface ManualPosition {
  /** The axes it places: one alone leaves the other to the layer below. */
  position: Partial<Position>;
  /** The launch order of the command that set it (the counter of the look launches): a transition watches it. */
  order: number;
  /** It glides there over the show's `moveFade` (a destination recalled) instead of following the gesture at once. */
  glide: boolean;
}

/** One pass of the motion layer: the state it starts from, what was really sent and the tempo; `compose` leaves the next state and the status in it. */
interface MotionRun {
  state: MotionState;
  /** The tempo a glide given in beats is timed at when it starts. */
  bpm: number;
  sent?: ReadonlyMap<string, Position> | undefined;
  status: ReadonlyMap<string, HeadStatus>;
}

/** strictBounds: the frame the heads' speed is first measured from lies one output frame (44 Hz) before the first sample. */
const STRICT_FRAME_MS = 23;
/** strictBounds: how far ahead the arrival frame is played — past the longest fade and the longest glide (64 beats at a slow tempo). */
const STRICT_ARRIVAL_MS = 600_000;

/** The pad and the commands that follow a continuous gesture are direct (R8). */
const DIRECT: MoveFade = { seconds: 0 };

interface ActiveLook {
  look: Look;
  player: LookPlayer;
}

/**
 * The palette revision a player was built under: a look queued while its palette changes keeps a player that
 * paints the old palette, so starting it again must rebuild it instead of resuming that copy.
 */
interface ReleasingLook {
  look: Look;
  player: LookPlayer;
  stopTime: number;
  exitFade: number;
  rev: number;
  /** Fixtures with tracks (T5): the crossfade whose sheet it shared when it was stopped (ShowRuntime.sharedSheet), while that one lasts. */
  shared?: string;
}

/** A look leaving through a crossfade: its weight goes from `start` to 0 over `dur` seconds from `t`. */
interface Leaving {
  look: Look;
  player: LookPlayer;
  start: number;
  t: number;
  dur: number;
  rev: number;
  /**
   * Fixtures with tracks (T5): it was stopped while it was coming back (Crossfade.rank) — this share of its weight
   * still lies at the rank it had before, in `sheet` when that part kept one of its own.
   */
  left?: { rank: number; share: number; sheet?: string };
}

/**
 * A look coming in over the looks of its exclusive group that it released (docs/specs/engine-effects-
 * timing.md, « Fondu enchaîné »): it rises over `tIn` seconds from `t0` while they go, their weights adding up
 * on the cells they share. `from` is the weight it already had when it starts again in mid-fade (0 when it
 * comes in over nothing): it rises from there, not from black. Kept under the id of the incoming look; once
 * that look has left or is gone, the others go on leaving under a key of their own (`tIn` 0).
 */
interface Crossfade {
  t0: number;
  tIn: number;
  from: number;
  outgoing: Leaving[];
  /** The launch rank its incoming look had when it started again while leaving (`from` > 0): where the part of it still leaving lies on a fixture with tracks (T5). */
  rank?: number;
  /** That part keeps a sheet of its own (it released other looks as it came back: they cross with what rises of it, not with what it still had). */
  apart?: boolean;
}

/** How far a stopped look is into its exit fade at `now`, 0..1: at 1 it neither paints nor moves a head any more. */
const exitProgress = (r: Pick<ReleasingLook, "stopTime" | "exitFade">, now: number): number => Math.min(1, Math.max(0, (now - r.stopTime) / 1000) / r.exitFade);

/** Stable small seed from a string, so a random-order look plays the same way every time. */
function seedOf(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** What `ShowRuntime.explainChannel` answers: `intensity` is absent when no fixture owns the channel. */
export interface ChannelExplanation {
  /** `head`: the colour head (0-based) the channel drives on a fixture with several; `accent` when that head is an accent one (a halo). */
  fixture: { id: string; name: string; offset: number; channel: string | undefined; attribute: FixtureChannel["attribute"] | undefined; definition: boolean; head?: number; accent?: true } | undefined;
  /**
   * `dcas`: every DCA covering the fixture, each once — `own` is the factor really multiplied, `effective` its
   * level with the groups above it (display); `factor` = grand master × the `own` of each. `dosesRaw`: the channel
   * carries the fixture's light (its dimmer, or a colour of a fixture without one) and a look writes it raw: the
   * intensity doses that write too.
   */
  intensity?: {
    grandMaster: number;
    grandMasterSent: number;
    dcas: { id: string; name: string; own: number; effective: number }[];
    factor: number;
    dosesRaw?: true;
  };
  /** Not a light channel (a machine channel, pan/tilt, an offset off the definition): neither the grand master nor any DCA doses it. */
  undosed?: true;
  /** A light channel channel faders hold: the DCAs they are linked to (with the groups above, each once, but those in `intensity`) dose the looks writing it, by `factor`. */
  faderDcas?: { dcas: { id: string; name: string; own: number }[]; factor: number };
  /**
   * The channel faders on it: `travel` is the level sent within its range (0..1 of 255); `effective` is the fader's own
   * value there as the frame computes it (Doses.faderValue): `travel` × each DCA of `dcas` once × `grandMaster` when
   * given; `doses` on a colour fixture's dimmer, which it doses.
   */
  faders: { id: string; name: string; level: number; sent: number; travel: number; dca: string | undefined; effective: number; dcas: { id: string; name: string; own: number }[]; grandMaster?: number; doses?: true }[];
  /**
   * Looks writing the channel as a raw channel; `leaving` for one fading out (an exit fade, or under a crossfade): it
   * still counts. `level`: what the groups including the look give it on this channel (lookLevelOn), when below 1 and
   * venue.toDmx applies it there (rawLevelApplies).
   */
  rawLooks: { id: string; name: string; leaving?: true; level?: number }[];
  /** `name`: the rule's, when it is still in force (the built-in Reset protection's among them). */
  clamps: (Pick<Clamp, "rule" | "from" | "to"> & { name?: string })[];
  /** The fixture has Reset channels, held at rest by the built-in rule: `fixture.reset` resets it on purpose. */
  resettable?: true;
  /**
   * A colour channel: the looks whose canvas reaches its head (or the whole fixture, or, for a halo that follows, a
   * full head), in the order they compose. `leaving` for one fading out (an exit fade, or under a crossfade); `covered`
   * for a playing look a later playing look covers there (`looksMerge: "last"`): its colour does not show. `level`: as
   * for `rawLooks`.
   */
  paintingLooks?: { id: string; name: string; leaving?: true; covered?: true; level?: number }[];
  /** The colour wheel of a lamp-only fixture: the slot it holds (its real colour) and, while a look asks a colour of it, that colour and the gap between them (OKLab, 0 = the same). */
  wheel?: { slot: string; color: string; asked?: string; gap: number };
  /** Its Reset channels (the range a voluntary reset sends), and the seconds left while one runs. */
  reset?: { channels: ResetChannel[]; secondsLeft?: number };
  /** On a fixture whose tracks are enabled (T5): whether this channel follows the transitions or jumps (pan/tilt left out: the motion layer's). */
  track?: "fade" | "jump";
  /**
   * A pan or tilt channel of a moving head: who places it (the motion layer, T25). `axis` is the logical axis the
   * channel drives (the other one on a head whose axes are swapped); `owner` the winning claim ("manual", "look:<id>",
   * "target:<id>"; null for a lock, a Panic hold and the rest position) and `name` its look's; while a glide runs,
   * `from` → `to` (0..1 of the travel) and the milliseconds left. `masked`: who else claims the axis and is beaten,
   * `released` when it was handed back. Looks that write the channel raw are listed in `rawLooks` only when they hold the axis.
   */
  motion?: {
    axis: Axis;
    layer: AxisLayer;
    owner: string | null;
    name?: string;
    lock: LockLevel;
    position: number;
    moving: boolean;
    from?: number;
    to?: number;
    remainingMs?: number;
    error?: string;
    masked: { owner: string; name?: string; released?: true }[];
  };
}

export class ShowRuntime {
  readonly palettes: Collection<Palette>;
  readonly looks: Collection<Look>;
  readonly groups: Collection<Group>;
  readonly faders: Collection<ChannelFader>;
  /** Show-level rules; venue/type rules live in the venue store. */
  readonly rules: Collection<Rule>;
  readonly venueRules: Collection<Rule>;
  readonly programs: Collection<RuleProgram>;
  /** Active rule program (one at a time), or none. */
  activeProgram: string | undefined;
  readonly zones: Collection<Zone>;
  readonly snapshots: Collection<Snapshot>;
  settings: ShowSettings;
  /** Values moved by the rules on the last frame (for the UI and the AI). */
  lastClamps: Clamp[] = [];
  /** Smoothed faders (docs/specs/groups-masters.md, « Lissage »): the levels sent, gliding to the levels asked. */
  readonly glide = new Glide();
  private readonly active = new Map<string, ActiveLook>();
  /**
   * When each player was (re)launched, in order: the layers of a fixture with tracks (T5) stack by it, so that a look
   * leaving keeps its place among the others while it fades instead of dropping under the ones still playing.
   */
  private readonly launchOrder = new WeakMap<LookPlayer, number>();
  private launches = 0;
  /**
   * Fixtures with tracks only (T5): the crossfade (by key) whose sheet a look (by id, active or the key of its own
   * crossfade) shares — a look that starts again while it leaves beside others (the tail of a crossfade stopped
   * midway) keeps sharing their sheet while they last, or the weights that made one mean would part into two sheets
   * in one frame. The other fixtures keep the sheets they always had.
   */
  private readonly sharedSheet = new Map<string, string>();
  /** Looks stopped with an exit fade, still fading to black (not active). */
  private readonly releasing = new Map<string, ReleasingLook>();
  /** Looks coming in over the ones they replaced (by incoming look id); the leaving ones are not active. */
  private readonly crossfades = new Map<string, Crossfade>();
  /** palette id → number of edits: a queued look whose palette was edited has a stale player. */
  private readonly paletteRevs = new Map<string, number>();
  private orphans = 0;
  /** group id → flash held */
  private readonly flashes = new Set<string>();
  /** Manual positions (XY pad, aiming): the manual claims of the motion layer, one per head, until released. */
  private readonly manualPositions = new Map<string, ManualPosition>();
  /**
   * The motion layer (engine/motion.ts, T25): its state from the last frame really rendered, and the logical position
   * each head was really sent then — read back in the output after the rules, and again after the guard (the DMX
   * console, the locked rules, the speed limits). Only `render` and the commands keep a state: a frame played in
   * memory (strictBounds) starts from it and drops its own.
   */
  private motionState: MotionState = emptyMotionState();
  private sentPositions: ReadonlyMap<string, Position> = new Map();
  private lastMotion: ReadonlyMap<string, HeadStatus> = new Map();
  /** T26 plugs the lock here: "off" until then. */
  motionLock: (head: string) => LockLevel = () => "off";
  /** The slot each colour wheel holds (venue.toDmx): kept from frame to frame, a slot changes only for one clearly closer (color-wheel.ts). */
  private readonly wheels = new Map<string, WheelChoice>();
  lastErrors: string[] = [];

  constructor(
    readonly store: FolderStore,
    readonly venue: Venue,
    private readonly tempo: TempoSource,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.palettes = store.collection("palettes", PaletteSchema);
    this.looks = store.collection("looks", LookSchema);
    this.groups = store.collection("groups", GroupSchema);
    this.faders = store.collection("faders", ChannelFaderSchema);
    this.rules = store.collection("rules", RuleSchema);
    this.venueRules = venue.store.collection("rules", RuleSchema);
    this.programs = store.collection("programs", RuleProgramSchema);
    this.zones = venue.store.collection("zones", ZoneSchema);
    this.snapshots = store.collection("snapshots", SnapshotSchema);
    this.settings = store.readManifest("show.json", ShowSettingsSchema, ShowSettingsSchema.parse({}));
    this.venue.absent = new Set(this.settings.absentFixtures);
    // a patch change may put another fixture's channel on a remembered slot: the Reset protection forgets
    venue.store.onChange((e) => {
      if (e.collection === "fixtures" || e.collection === "models") this.atRest.clear();
    });
    store.onChange((e) => {
      // A look or palette edited while playing restarts with the new definition (effects stay editable live);
      // renamed, filed in a folder or annotated, it plays on untouched.
      if (e.collection === "looks") {
        const playing = this.active.get(e.id);
        const fresh = playing && this.looks.get(e.id);
        if (playing && fresh && played(fresh) === played(playing.look)) playing.look = fresh;
        else if (playing) this.restart(e.id);
      }
      if (e.collection === "palettes") {
        this.paletteRevs.set(e.id, (this.paletteRevs.get(e.id) ?? 0) + 1);
        for (const a of [...this.active.values()]) if (a.look.palette === e.id) this.restart(a.look.id);
      }
    });
  }

  reloadSettings(): void {
    this.settings = this.store.readManifest("show.json", ShowSettingsSchema, ShowSettingsSchema.parse({}));
    this.venue.absent = new Set(this.settings.absentFixtures);
  }

  saveSettings(patch: Partial<ShowSettings>): ShowSettings {
    this.settings = ShowSettingsSchema.parse({ ...this.settings, ...patch });
    this.venue.absent = new Set(this.settings.absentFixtures);
    this.store.writeManifest("show.json", this.settings);
    return this.settings;
  }

  /** The technique with its palette applied (palettes are used by reference). */
  resolvedTechnique(look: Look): Technique {
    const t = look.technique;
    if (!look.palette) return t;
    const palette = this.palettes.get(look.palette);
    if (!palette) throw new Error(say(`palette inconnue : ${look.palette}`, `unknown palette: ${look.palette}`));
    const cols = palette.colors;
    switch (t.kind) {
      case "plat":
      case "flash":
        return { ...t, color: cols[0]! };
      case "damier":
      case "creux":
      case "masques":
        return { ...t, colors: [cols[0]!, cols[1] ?? cols[0]!] };
      case "palette":
      case "respiration":
      case "flamme":
      case "onde":
        return { ...t, colors: cols.length >= (t.kind === "palette" ? 3 : 1) ? cols : t.colors } as Technique;
      case "orage":
        return { ...t, base: cols[0]!, flash: cols[1] ?? t.flash };
      default:
        return t;
    }
  }

  /** The steps a look plays on its canvas (palette and mirror applied); `canvas`: as it is about to be written. */
  stepsOf(look: Look, canvas: Pick<Canvas, "cells" | "topology"> | undefined = this.venue.canvases.get(look.canvas)): Step[] {
    if (!canvas) throw new Error(say(`canevas inconnu : ${look.canvas}`, `unknown canvas: ${look.canvas}`));
    return generateSteps(this.resolvedTechnique(look), canvas.cells, look.mirror ?? canvas.topology === "line-mirror");
  }

  /** `withEntry` false: the look comes in through a crossfade, which dims it itself. */
  private build(look: Look, withEntry = true): LookPlayer {
    const steps = this.stepsOf(look);
    // entry fade (« pas 0 d'entrée », a QLC+ scene's fade in): from black on the cells the look paints
    const entry = withEntry && look.timing.entryFade > 0 ? steps[0]!.map((c) => (c ? OFF : null)) : null;
    return new LookPlayer(steps, look.timing, seedOf(look.id), entry);
  }

  /**
   * Playback fader: its DCA above 0 (and not muted) starts the looks it doses, at 0 stops them —
   * only those it started, a look launched by a button stays (like a QLC+ « Playback » slider).
   */
  syncPlayback(groupId: string): void {
    const g = this.groups.get(groupId);
    if (!g?.playback) return;
    const up = (g.master?.level ?? 0) > 0 && !g.master?.mute;
    for (const lookId of g.presets.included) {
      if (up && !this.isActive(lookId) && this.looks.get(lookId)) {
        this.go(lookId);
        this.playbackStarted.add(lookId);
      } else if (!up && this.playbackStarted.delete(lookId) && this.isActive(lookId)) this.stop(lookId);
    }
  }
  private readonly playbackStarted = new Set<string>();

  /** The state just before the last Panic, kept a minute: a Panic pressed by mistake is undone. */
  private beforePanic: { snap: Omit<Snapshot, "id" | "name" | "notes">; until: number; after?: string } | undefined;

  /** What a snapshot holds, timeless: two equal keys are the same live state. */
  private stateKey(blackout: boolean): string {
    const { savedAt: _t, ...s } = this.captureSnapshot(blackout);
    return JSON.stringify(s);
  }

  rememberBeforePanic(blackout: boolean, now = Date.now()): void {
    // A Panic again with nothing changed since the last (the finger insisted) keeps the state from
    // before the first one; anything played or moved in between makes this one the Panic to undo.
    if (this.panicUndoUntil(now) !== undefined && this.beforePanic?.after === this.stateKey(blackout)) return;
    this.beforePanic = { snap: this.captureSnapshot(blackout), until: now + PANIC_UNDO_MS };
  }

  /** The state the Panic left, to tell a repeated Panic from a new one. */
  notePanicDone(blackout: boolean): void {
    if (this.beforePanic) this.beforePanic.after = this.stateKey(blackout);
  }

  /** Whether a Panic can still be undone (and until when). */
  panicUndoUntil(now = Date.now()): number | undefined {
    return this.beforePanic && now <= this.beforePanic.until ? this.beforePanic.until : undefined;
  }

  /** Takes the state from before the Panic, once, while it is fresh; undefined otherwise. */
  takeBeforePanic(now = Date.now()): Snapshot | undefined {
    const kept = this.beforePanic;
    this.beforePanic = undefined;
    return kept && now <= kept.until ? { id: "avant-panic", name: "Avant le Panic", ...kept.snap } : undefined;
  }

  /** The live state a snapshot saves: looks playing, DCA, channel faders, grand master, program. */
  captureSnapshot(blackout: boolean): Omit<Snapshot, "id" | "name" | "notes"> {
    return {
      looks: this.activeLooks(),
      groups: Object.fromEntries(this.groups.list().flatMap((g) => (g.master ? [[g.id, { level: g.master.level, mute: g.master.mute }]] : []))),
      faders: Object.fromEntries(this.faders.list().map((f) => [f.id, f.level])),
      grandMaster: this.settings.grandMaster,
      program: this.activeProgram,
      blackout,
      savedAt: new Date().toISOString(),
    };
  }

  /**
   * Puts a snapshot back: its levels first (playback DCAs start their looks), then only its looks
   * play. Objects deleted since are skipped and listed. The Blackout is the caller's (engine).
   */
  applySnapshot(s: Snapshot): { looks: string[]; skipped: string[] } {
    this.stopAll();
    this.playbackStarted.clear();
    const skipped: string[] = [];
    for (const [id, m] of Object.entries(s.groups)) {
      const g = this.groups.get(id);
      if (g) this.groups.putLive({ ...g, master: { ...g.master, level: m.level, mute: m.mute } });
      else skipped.push(id);
    }
    for (const [id, level] of Object.entries(s.faders)) {
      const f = this.faders.get(id);
      if (f) this.faders.putLive({ ...f, level });
      else skipped.push(id);
    }
    if (s.grandMaster !== undefined && s.grandMaster !== this.settings.grandMaster) this.saveSettings({ grandMaster: s.grandMaster });
    this.selectProgram(s.program && this.programs.get(s.program) ? s.program : undefined);
    for (const g of this.groups.list()) if (g.playback) this.syncPlayback(g.id);
    for (const id of s.looks) {
      // A look whose canvas was force-deleted throws: it is skipped, the others still play.
      try {
        if (this.looks.get(id)) this.go(id);
        else skipped.push(id);
      } catch (e) {
        skipped.push(`${id} (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    return { looks: this.activeLooks(), skipped };
  }

  isActive(lookId: string): boolean {
    return this.active.has(lookId);
  }

  activeLooks(): string[] {
    return [...this.active.keys()];
  }

  /**
   * Starts a look; releases the other looks of its exclusive groups. Idempotent (« Déclencher »).
   * `auto`: started by the timeline, the AI or the section follower — a « manuel seulement » look
   * refuses (docs/specs/rules-limits.md, drapeaux de section): checked here so no path skips it.
   */
  go(lookId: string, auto = false): { started: boolean; released: string[] } {
    const look = this.looks.get(lookId);
    if (!look) throw new Error(say(`look inconnu : ${lookId}`, `unknown look: ${lookId}`));
    if (auto && look.manualOnly) throw new Error(say(`« ${look.name} » est en manuel seulement`, `“${look.name}” is manual only`));
    const released: string[] = [];
    const leaving: ActiveLook[] = [];
    const now = this.now();
    // A look that starts again while it still leaves resumes from the level it is at; read what it has on
    // stage before letting go of it below (docs/specs/engine-effects-timing.md, « Fondu enchaîné »).
    const resume = this.queueOf(lookId, now);
    // The crossfades it was leaving in, by key. A crossfade still running is kept under the id of its incoming look:
    // one of these keys that is a look released below is a look it was crossing with (released, it goes on sharing its sheet).
    const leftIn = new Set([...this.crossfades].filter(([, c]) => c.outgoing.some((o) => o.look.id === lookId)).map(([key]) => key));
    // the tail of a stopped crossfade it leaves beside others, if any (tracks: it keeps sharing their sheet)
    const beside = [...this.crossfades].find(([key, c]) => key !== lookId && !this.active.has(key) && c.outgoing.length > 1 && c.outgoing.some((o) => o.look.id === lookId))?.[0] ?? this.releasing.get(lookId)?.shared;
    this.releasing.delete(lookId);
    this.leaveCrossfades(lookId);
    for (const g of this.groups.list()) {
      if (!g.exclusive || !g.members.looks.includes(lookId)) continue;
      for (const other of g.members.looks) {
        if (other === lookId) continue;
        const otherActive = this.active.get(other);
        if (otherActive && this.active.delete(other)) {
          released.push(other);
          leaving.push(otherActive);
        }
      }
    }
    const fadeOut = () => leaving.forEach((l) => this.leaveActive(l, now));
    if (this.active.has(lookId)) {
      fadeOut();
      return { started: false, released };
    }
    // Resuming keeps the player of the queue, so the animation keeps its place — unless the look was edited
    // since it left (another definition: it starts fresh, as it always did) or its palette changed while it
    // queued (its player paints the old one).
    const again = resume !== undefined && this.resumable(resume, look) ? resume : undefined;
    const from = again?.weight ?? 0;
    // a look that fades in takes over from the ones it replaces (they leave under it), or from the weight
    // it still has when it starts again over nothing released: a crossfade can carry no outgoing look
    const crossfade = (leaving.length > 0 || from > 0) && look.timing.entryFade > 0;
    let player: LookPlayer;
    if (again) {
      player = again.player; // resumed: no rebuild, no start() — it never went back to the first step
    } else {
      try {
        player = this.build(look, !crossfade);
      } catch (err) {
        fadeOut();
        throw err;
      }
      player.start(this.now(), this.tempo.state().beats);
    }
    // where it lay while it was leaving: the part of it still leaving stays there on a fixture with tracks
    const rank = from > 0 && resume ? this.launchOrder.get(resume.player) : undefined;
    this.launchOrder.set(player, ++this.launches);
    this.active.set(lookId, { look, player });
    if (crossfade) {
      // it releases looks it was not crossing with: what it still had keeps a sheet of its own
      const apart = leaving.length > 0 && !leaving.some((l) => leftIn.has(l.look.id));
      this.beginCrossfade(look, leaving, now, from, rank === undefined ? undefined : { rank, apart });
      // alone to come back (nothing released): it goes on sharing the sheet of the tail it left
      if (beside !== undefined && !leaving.length && this.crossfades.has(beside)) this.sharedSheet.set(lookId, beside);
    } else fadeOut();
    return { started: true, released };
  }

  /**
   * What a look that starts again still has on stage, to resume from: the weight it is at now — the queues
   * it leaves through add up (a crossfade tail, a fading copy), bounded to [0, 1] — and the player of the
   * brightest of them. Nothing when it no longer leaves anywhere.
   */
  private queueOf(lookId: string, now: number): { weight: number; look: Look; player: LookPlayer; rev: number } | undefined {
    let weight = 0;
    let brightest: { weight: number; look: Look; player: LookPlayer; rev: number } | undefined;
    const add = (w: number, look: Look, player: LookPlayer, rev: number): void => {
      weight += w;
      if (w > (brightest?.weight ?? 0)) brightest = { weight: w, look, player, rev };
    };
    for (const c of this.crossfades.values()) for (const o of c.outgoing) if (o.look.id === lookId) add(this.outWeight(o, now), o.look, o.player, o.rev);
    const r = this.releasing.get(lookId);
    if (r) add(r.exitFade > 0 ? 1 - ease(Math.min(1, Math.max(0, (now - r.stopTime) / 1000) / r.exitFade)) : 0, r.look, r.player, r.rev);
    return brightest && { weight: Math.min(1, Math.max(0, weight)), look: brightest.look, player: brightest.player, rev: brightest.rev };
  }

  /** Whether the queued copy still paints what `look` paints now: same definition (a no-op save stores another object) and same palette. */
  private resumable(resume: { look: Look; rev: number }, look: Look): boolean {
    if (resume.rev !== this.lookRev(look)) return false;
    return resume.look === look || played(resume.look) === played(look);
  }

  /** The revision of the palette `look` uses (0 when it uses none). */
  private lookRev(look: Look): number {
    return (look.palette && this.paletteRevs.get(look.palette)) || 0;
  }

  stop(lookId: string): boolean {
    const a = this.active.get(lookId);
    if (!a) return false;
    this.active.delete(lookId);
    this.leaveActive(a, this.now());
    return true;
  }

  /**
   * An active look that is released or stopped leaves: over its exit fade, or at once without one. A look that was
   * itself coming in through a crossfade leaves from the weight it had, and the looks that were leaving under it keep
   * leaving on the same sheet: nothing jumps.
   */
  private leaveActive(a: ActiveLook, now: number): void {
    const crossfade = this.crossfades.get(a.look.id);
    if (!crossfade) {
      const shared = this.sharedSheet.get(a.look.id);
      this.sharedSheet.delete(a.look.id);
      this.startFadeOut(a.look, a.player, now, shared);
      return;
    }
    this.crossfades.delete(a.look.id);
    const outgoing = [...crossfade.outgoing];
    if (a.look.timing.exitFade > 0) {
      const start = this.inWeight(crossfade, now);
      const left = this.leftOf(crossfade, start, a.look.id);
      outgoing.push({ look: a.look, player: a.player, start, t: now, dur: a.look.timing.exitFade, rev: this.lookRev(a.look), ...(left ? { left } : {}) });
    }
    const key = this.orphanKey();
    this.moveSheet(a.look.id, key);
    if (outgoing.length) this.crossfades.set(key, { t0: now, tIn: 0, from: 0, outgoing });
  }

  /**
   * A look leaves (stopped, or released by another) while it was coming back (Crossfade.rank): the share of the weight
   * it leaves from (`start`) that still lay at the rank it had before stays there as it fades, on a fixture with tracks.
   */
  private leftOf(crossfade: Crossfade, start: number, lookId: string): Leaving["left"] {
    if (crossfade.rank === undefined || start <= 0 || crossfade.from >= 1) return undefined;
    const under = (crossfade.from * (1 - start)) / (1 - crossfade.from) / start;
    return under > 0 ? { rank: crossfade.rank, share: Math.min(1, under), ...(crossfade.apart ? { sheet: `was:${lookId}` } : {}) } : undefined;
  }

  private orphanKey(): string {
    return `\0${++this.orphans}`;
  }

  /** The incoming look of a crossfade is gone: what was leaving under it goes on leaving. */
  private orphan(lookId: string): void {
    const crossfade = this.crossfades.get(lookId);
    if (!crossfade) return;
    this.crossfades.delete(lookId);
    const key = this.orphanKey();
    this.moveSheet(lookId, key);
    if (crossfade.outgoing.length) this.crossfades.set(key, crossfade);
  }

  /** The weight of a look coming in through a crossfade: `from` → 1 over its entry fade (smoothstep, like the entry fade); 1 at once when it has none. */
  private inWeight(c: Crossfade, now: number): number {
    if (c.tIn <= 0) return 1;
    const from = Math.min(1, Math.max(0, c.from));
    return Math.min(1, from + (1 - from) * ease(Math.min(1, Math.max(0, (now - c.t0) / 1000) / c.tIn)));
  }

  /** The weight of a look leaving through a crossfade: `start` → 0. */
  private outWeight(o: Leaving, now: number): number {
    return o.start * (1 - ease(Math.min(1, Math.max(0, (now - o.t) / 1000) / o.dur)));
  }

  /**
   * `look` has just started over the `leaving` looks it released, from the weight `from` it already had when
   * it starts again. Each leaves over its own exit fade, or over the entry fade of the incoming look when it
   * has none. A leaving look that was itself coming in leaves from the weight it had, and what was leaving
   * under it keeps going, from the weight it has now. `back`: it starts again while it was leaving — the rank it had
   * and whether what it still had keeps a sheet of its own (Crossfade.rank, Crossfade.apart; fixtures with tracks).
   */
  private beginCrossfade(look: Look, leaving: ActiveLook[], now: number, from: number, back?: { rank: number; apart: boolean }): void {
    const outgoing: Leaving[] = [];
    this.sharedSheet.delete(look.id);
    for (const l of leaving) {
      const was = this.crossfades.get(l.look.id);
      if (was) {
        this.crossfades.delete(l.look.id);
        this.moveSheet(l.look.id, look.id);
        for (const o of was.outgoing) outgoing.push({ ...o, start: this.outWeight(o, now), t: now, dur: Math.max(0.05, o.dur - (now - o.t) / 1000) });
      }
      const exit = l.look.timing.exitFade;
      const start = was ? this.inWeight(was, now) : 1;
      const left = was ? this.leftOf(was, start, l.look.id) : undefined;
      outgoing.push({ look: l.look, player: l.player, start, t: now, dur: exit > 0 ? exit : look.timing.entryFade, rev: this.lookRev(l.look), ...(left ? { left } : {}) });
    }
    this.crossfades.set(look.id, { t0: now, tIn: look.timing.entryFade, from: Math.min(1, Math.max(0, from)), outgoing, ...back });
  }

  /** A crossfade goes on under another key: the sheet it shared on the fixtures with tracks follows it. */
  private moveSheet(from: string, to: string): void {
    const shared = this.sharedSheet.get(from);
    this.sharedSheet.delete(from);
    if (shared !== undefined && shared !== to) this.sharedSheet.set(to, shared);
  }

  /** The sheet of a crossfade on the fixtures with tracks: its own, or the one it shares (sharedSheet). */
  private trackSheet(key: string): string {
    let k = key;
    // a shared sheet may itself share another's (a tail moved under a new key); bounded, so that a cycle cannot hang the frame
    for (let i = 0; i < 8; i++) {
      const next = this.sharedSheet.get(k);
      if (next === undefined) break;
      k = next;
    }
    return `x:${k}`;
  }

  /**
   * A look that starts again (its queues read first by `go`, to resume from: this only lets them go) or is
   * deleted (its queue must fall) no longer leaves under another one.
   */
  private leaveCrossfades(lookId: string): void {
    for (const c of this.crossfades.values()) c.outgoing = c.outgoing.filter((o) => o.look.id !== lookId);
  }

  /** Moves a stopped look into the `releasing` fade-out, when its exitFade > 0. */
  private startFadeOut(look: Look, player: LookPlayer, stopTime = this.now(), shared?: string): void {
    const exitFade = look.timing?.exitFade ?? 0;
    if (exitFade <= 0) return;
    // Drop any earlier fading copy of the same look.
    this.releasing.delete(look.id);
    this.releasing.set(look.id, { look, player, stopTime, exitFade, rev: this.lookRev(look), ...(shared === undefined ? {} : { shared }) });
  }

  /** Forgets a look at once, fading copy included (it is being deleted). */
  drop(lookId: string): void {
    this.active.delete(lookId);
    this.releasing.delete(lookId);
    this.orphan(lookId);
    this.leaveCrossfades(lookId);
  }

  stopAll(): string[] {
    const ids = [...this.active.keys()];
    this.active.clear();
    this.releasing.clear();
    this.crossfades.clear();
    this.sharedSheet.clear();
    return ids;
  }

  /** Forgets everything live (looks, flashes, manual positions, program): another show opens. */
  resetLive(): void {
    this.active.clear();
    this.releasing.clear();
    this.crossfades.clear();
    this.sharedSheet.clear();
    this.playbackStarted.clear();
    this.flashes.clear();
    this.manualPositions.clear();
    // the layer starts afresh; what was sent is kept, so that the heads glide from where they are
    this.motionState = emptyMotionState();
    this.lastMotion = new Map();
    this.activeProgram = undefined;
    this.resets.clear();
    this.atRest.clear();
  }

  private restart(lookId: string): void {
    const look = this.looks.get(lookId);
    this.active.delete(lookId);
    if (look) {
      try {
        const player = this.build(look, !this.crossfades.has(lookId));
        player.start(this.now(), this.tempo.state().beats);
        this.launchOrder.set(player, ++this.launches);
        this.active.set(lookId, { look, player });
        return;
      } catch (err) {
        this.lastErrors = [(err as Error).message];
      }
    }
    this.orphan(lookId); // gone, or it no longer builds: what was leaving under it goes on leaving
  }

  setFlash(groupId: string, on: boolean): void {
    if (!this.groups.get(groupId)) throw new Error(say(`groupe inconnu : ${groupId}`, `unknown group: ${groupId}`));
    if (on) this.flashes.add(groupId);
    else this.flashes.delete(groupId);
  }

  /** Fixtures of a group, including sub-groups and dynamic selector members. */
  fixturesOf(groupId: string, seen = new Set<string>()): Set<string> {
    const out = new Set<string>();
    if (seen.has(groupId)) return out;
    seen.add(groupId);
    const g = this.groups.get(groupId);
    if (!g) return out;
    for (const f of g.members.fixtures) out.add(f);
    if (g.selector) {
      for (const f of this.venue.fixtures.list()) {
        if (g.selector.role && f.role !== g.selector.role) continue;
        if (g.selector.tags && !g.selector.tags.every((t) => f.tags.includes(t))) continue;
        out.add(f.id);
      }
    }
    for (const sub of g.members.groups) for (const f of this.fixturesOf(sub, seen)) out.add(f);
    return out;
  }

  /** A group's own factor (its DCA): master level within its limits; mute = 0; flash = its max. */
  private ownLevel(g: Group): number {
    return dcaLevel(g.master ? { ...g, master: { ...g.master, level: this.masterLevel(g) } } : g, this.flashes.has(g.id));
  }

  /** The level a DCA's master sends now: its level, or on its way there when smoothed. */
  masterLevel(g: Group): number {
    return this.glide.value(`group:${g.id}`, g.master?.level ?? 1, g.master?.smoothing, this.now());
  }

  /** The level a channel fader sends now. */
  faderLevel(f: ChannelFader): number {
    return this.glide.value(`fader:${f.id}`, f.level, f.smoothing, this.now());
  }

  /** The faders still gliding to their level, with the level sent (topic light:glide, the ghost bars of the Live). */
  gliding(): { groups: Record<string, number>; faders: Record<string, number>; gm?: number } {
    const out: { groups: Record<string, number>; faders: Record<string, number>; gm?: number } = { groups: {}, faders: {} };
    for (const [key, level] of Object.entries(this.glide.moving(this.now()))) {
      if (key === "gm") out.gm = level;
      else if (key.startsWith("group:")) out.groups[key.slice(6)] = level;
      else if (key.startsWith("fader:")) out.faders[key.slice(6)] = level;
    }
    return out;
  }

  /** The grand master sent now. */
  grandMasterLevel(): number {
    return this.glide.value("gm", this.settings.grandMaster, this.settings.grandMasterSmoothing, this.now());
  }

  /** Effective factor of a group: its own level × every group above it, each once (a parent reached by two paths is one fader). */
  effectiveLevel(groupId: string, index = this.dcaIndex()): number {
    return index.effective(groupId);
  }

  /**
   * Who doses what now (show/dca.ts): a snapshot of the groups, each DCA counted once. compose() builds
   * one per frame and drops it after; the other callers (dmx.explain, group.list) build one on demand.
   */
  dcaIndex(): DcaIndex {
    return new DcaIndex({ groups: this.groups.list(), isDca: (g) => !!g.master || this.flashes.has(g.id), fixturesOf: (id) => this.fixturesOf(id), own: (g) => this.ownLevel(g) });
  }

  /** What doses each light channel now (show/doses.ts), on a snapshot of the groups: one per frame, or one on demand. */
  doses(index = this.dcaIndex()): Doses {
    return new Doses({ index, faders: this.faders.list(), groups: this.groups.list(), light: (id) => this.lightOffsets(id), dosesDimmer: (f, o) => this.dosesDimmer(f, o), grandMaster: this.grandMasterLevel() });
  }

  /** The DCAs covering a fixture (docs/specs/groups-masters.md, « Calcul »): holding it directly, by selector or through any sub-group. */
  dcasOf(fixtureId: string, index = this.dcaIndex()): Group[] {
    return index.groups(index.covering(fixtureId));
  }

  /**
   * The light channels of a fixture: its dimmer(s) and the colour components of its heads (accent ones
   * included). Machine channels (a wheel, a macro, a speed), pan/tilt and offsets off the definition are not.
   */
  private lightOffsets(fixtureId: string): LightOffsets | undefined {
    const r = this.venue.resolve(fixtureId);
    if ("error" in r) return undefined;
    const colours = new Set<number>();
    for (const comps of r.heads.values()) for (const off of Object.values(comps)) colours.add(off);
    return { dimmers: r.dimmers, colours };
  }

  /**
   * The level the groups including a look (`presets.included`) give it on a fixture, on one of its channels when
   * given: those DCAs and every group above them, each once, but those already dosing that channel there — the
   * DCAs covering the fixture, those of the channel faders on its dimmer and on that channel (Doses.lookLevel, T35).
   * No caller yet: this signature is the contract T35 keeps for T5, which doses its layers' `level` with it
   * (docs/todo.md, T5); the frame and dmx.explain call Doses.lookLevel on their own snapshot.
   */
  lookLevelOn(look: Pick<Look, "id">, fixtureId: string, offset?: number, doses = this.doses()): number {
    return doses.lookLevel(look.id, fixtureId, offset);
  }

  /**
   * Doses what a look paints on one fixture (`heads`, its halo spelt out already) by the level its groups give it,
   * channel by channel: one factor for the whole fixture in the usual case; when a channel fader linked to one of
   * those groups holds only some of its colours, each component by the level on its own channel, a whole-fixture
   * colour spelt out head by head first (as Venue.followAccents does). True when anything was dosed.
   */
  private doseLookColours(doses: Doses, lookId: string, fixtureId: string, heads: Map<number, Color>): boolean {
    const light = doses.light(fixtureId);
    const colours = light ? [...light.colours] : [];
    const levels = new Map(colours.map((o) => [o, doses.lookLevel(lookId, fixtureId, o)]));
    const values = [...levels.values()];
    const uniform = values.every((v) => v === values[0]) ? (values[0] ?? doses.lookLevel(lookId, fixtureId, light?.dimmers[0])) : undefined;
    if (uniform !== undefined) {
      if (uniform === 1) return false;
      for (const [h, c] of heads) heads.set(h, scaleColor(c, uniform));
      return true;
    }
    const r = this.venue.resolve(fixtureId);
    if ("error" in r) return false; // no definition: no light channel either (unreachable with levels to tell apart)
    const whole = heads.get(-1);
    if (whole) {
      heads.delete(-1);
      for (const h of r.heads.keys()) if (!heads.has(h) && (!r.accent.has(h) || r.follow)) heads.set(h, whole);
    }
    const lowest = Math.min(...values);
    for (const [h, c] of heads) {
      const comps = r.heads.get(h) ?? {};
      const out: Color = {};
      for (const [comp, v] of Object.entries(c) as [ColorComponent, number][]) {
        const offset = comps[comp];
        out[comp] = v * ((offset === undefined ? undefined : levels.get(offset)) ?? lowest);
      }
      heads.set(h, out);
    }
    return true;
  }

  /** A channel fader's travel: its level within its range (a QLC+ slider limited to 0..200 never goes past 200), 0..1 of 255. */
  private faderTravel(fader: ChannelFader): number {
    const { min, max } = fader.range ?? { min: 0, max: 255 };
    return (min + this.faderLevel(fader) * (max - min)) / 255;
  }

  /**
   * Why a DMX channel has its value (groups-masters.md, « Console DMX »): the fixture and channel
   * it belongs to, the grand master and the DCAs dosing that fixture, the channel faders and the
   * raw-channel looks writing it, and the rules that bounded it on the last frame. The caller adds
   * the output value and any forcing from the console, which live in the engine.
   */
  explainChannel(universe: number, channel: number): ChannelExplanation {
    // an installed fixture first: an absent one on the same address sends nothing there
    const fixture = [...this.venue.installed(), ...this.venue.fixtures.list().filter((f) => this.venue.absent.has(f.id))].find((f) => {
      if (f.universe !== universe || channel < f.address) return false;
      const resolved = this.venue.resolve(f.id);
      return channel < f.address + ("error" in resolved ? 1 : resolved.mode.channels.length);
    });
    if (!fixture) return { fixture: undefined, faders: [], rawLooks: [], clamps: [] };
    const offset = channel - fixture.address;
    const r = this.venue.resolve(fixture.id);
    const name = "error" in r ? undefined : r.mode.channels[offset];
    const attribute = name && !("error" in r) ? r.def.channels.get(name)?.attribute : undefined;
    // the colour head the channel drives, when the fixture has several (declared or deduced), and whether it is an accent one
    const head = "error" in r || r.heads.has(-1) ? undefined : this.venue.headOf(r, offset);
    // the same rule as the frame's (show/dca.ts), on a snapshot taken now
    const index = this.dcaIndex();
    const doses = this.doses(index);
    const named = (ids: Iterable<string>) => index.groups(ids).map((g) => ({ id: g.id, name: g.name, own: index.own(g.id) }));
    const dcas = this.dcasOf(fixture.id, index).map((g) => ({ id: g.id, name: g.name, own: index.own(g.id), effective: index.effective(g.id) }));
    // each fader's own value here, by the very function the frame uses (Doses.faderValue)
    const faders = this.faders
      .list()
      .filter((f) => f.channels.some((c) => c.fixture === fixture.id && c.offset === offset))
      .map((f) => {
        const travel = this.faderTravel(f);
        const v = doses.faderValue(f, travel, fixture.id, offset);
        return { id: f.id, name: f.name, level: f.level, sent: this.faderLevel(f), travel, dca: f.dca, effective: v.level, dcas: named(v.dcas), ...(v.grandMaster ? { grandMaster: doses.grandMaster } : {}), ...(v.doses ? { doses: true as const } : {}) };
      });
    const writes = (look: Look) => look.channels?.targets.some((t) => t.fixture === fixture.id && t.offset === offset) ?? false;
    const leaving = [...this.releasing.values(), ...[...this.crossfades.values()].flatMap((x) => x.outgoing)].map(({ look }) => look);
    const light = doses.light(fixture.id);
    // what this channel is to the doses: the fixture's dimmer, one of its colours, or a machine channel (not light: never dosed)
    const kind = !light || !isLight(light, offset) ? ("machine" as const) : light.dimmers.includes(offset) ? ("dimmer" as const) : ("colour" as const);
    const bodyColours = new Set(!("error" in r) ? [...r.heads].filter(([h]) => !r.accent.has(h)).flatMap(([, comps]) => Object.values(comps)) : []);
    const raws = [
      ...[...this.active.values()].filter(({ look }) => writes(look)).map(({ look }) => ({ look, leaving: false })),
      ...leaving.filter((look) => writes(look) && !this.active.has(look.id)).map((look) => ({ look, leaving: true })),
    ].filter((l, i, all) => all.findIndex((x) => x.look.id === l.look.id) === i);
    // the looks dosing their light by their colours here (painting the body), as venue.toDmx classes them
    const bodyPainters = raws.length && kind !== "machine" ? new Set(this.paintingLooks(fixture.id, (heads) => this.venue.lightsBody(fixture.id, heads)).map((l) => l.id)) : new Set<string>();
    const rawLooks = raws.map(({ look, leaving: out }) => {
      const mine = look.channels?.targets.filter((t) => t.fixture === fixture.id) ?? [];
      const byColour = bodyPainters.has(look.id) || mine.some((t) => bodyColours.has(t.offset));
      const byDimmer = mine.some((t) => light?.dimmers.includes(t.offset));
      // the level is told only where venue.toDmx applies it (rawLevelApplies); on a fixture with tracks, where
      // composeTracks applies it: always on a colour, on the dimmer of a lamp or of a look lighting it by that dimmer only
      const applies = !("error" in r) && r.tracks ? kind === "colour" || r.levelDimmer || !byColour : rawLevelApplies(kind, { byColour, byDimmer });
      const level = kind !== "machine" && applies ? doses.lookLevel(look.id, fixture.id, offset) : 1;
      return { id: look.id, name: look.name, ...(out ? { leaving: true as const } : {}), ...(level === 1 ? {} : { level }) };
    });
    // a raw dimmer, or a raw colour of a fixture without a dimmer, is light: the intensity doses what a look writes there
    const rawDosed = rawLooks.length > 0 && !!light && carriesLight(light, offset);
    // the DCAs a channel fader links to this light channel: they dose the looks writing it too
    const viaFaders = named(doses.showDcas(fixture.id, offset));
    const ruleNames = new Map(this.rulesInForce().map((x) => [x.id, x.name]));
    const clamps = this.lastClamps.filter((c) => c.fixture === fixture.id && c.channel === name).map(({ rule, from, to }) => ({ rule, from, to, ...(ruleNames.get(rule) ? { name: ruleNames.get(rule)! } : {}) }));
    // a lamp's colour wheel: the slot held, its real colour, and how far it is from the colour asked
    const held = !("error" in r) && r.lampOnly && r.wheel?.offset === offset ? this.wheels.get(fixture.id) : undefined;
    const slot = held && !("error" in r) ? r.wheel?.slots.find((s) => s.min === held.slot) : undefined;
    const wheel = held && slot ? { slot: slot.name, color: slotHex(slot), ...(held.asked ? { asked: held.asked } : {}), gap: held.gap } : undefined;
    // the looks painting this colour channel's head (or the whole fixture) at their current step, read only when asked;
    // on a lamp's wheel, those lighting its body (a halo alone turns no wheel)
    const onWheel = !("error" in r) && r.lampOnly && r.wheel?.offset === offset;
    // fadeable tracks (T5): the wheel follows its own rule (T18), never faded; pan/tilt belong to the motion layer
    const track = "error" in r || !r.tracks || motionOffsets(r).has(offset) ? undefined : r.tracks.fade.has(offset) && !onWheel ? ("fade" as const) : ("jump" as const);
    // pan/tilt: the motion layer places the head; a look writing the channel raw is a source only when it holds the axis
    const motion = "error" in r ? undefined : this.explainMotion(fixture.id, r, offset);
    const isColour = onWheel || (!("error" in r) && [...r.heads.values()].some((c) => Object.values(c).includes(offset)));
    const paintsHere = (heads: Set<number>): boolean => (onWheel ? this.venue.lightsBody(fixture.id, heads) : heads.has(-1) || (head !== undefined && heads.has(head.head)));
    // a painting look's colour here carries the level its groups give it on this channel (colorsOf)
    const painting = isColour
      ? this.paintingLooks(fixture.id, paintsHere).map((l) => {
          const level = doses.lookLevel(l.id, fixture.id, onWheel ? undefined : offset);
          return level === 1 ? l : { ...l, level };
        })
      : [];
    return {
      ...(painting.length ? { paintingLooks: painting } : {}),
      ...(wheel ? { wheel } : {}),
      ...(track ? { track } : {}),
      fixture: { id: fixture.id, name: fixture.name, offset: offset + 1, channel: name, attribute, definition: !("error" in r), ...(head ? { head: head.head, ...(head.accent ? { accent: true as const } : {}) } : {}) },
      intensity: { grandMaster: this.settings.grandMaster, grandMasterSent: this.grandMasterLevel(), dcas, factor: this.intensityOf(fixture.id, index), ...(rawDosed ? { dosesRaw: true as const } : {}) },
      ...(viaFaders.length ? { faderDcas: { dcas: viaFaders, factor: index.product(viaFaders.map((d) => d.id)) } } : {}),
      ...(kind === "machine" ? { undosed: true as const } : {}),
      faders,
      rawLooks: motion ? rawLooks.filter((l) => `look:${l.id}` === motion.owner) : rawLooks,
      ...(motion ? { motion } : {}),
      clamps,
      ...(!("error" in r) && resetChannels(r).length
        ? { resettable: true as const, reset: { channels: resetChannels(r), ...(this.resetting(fixture.id) ? { secondsLeft: Math.ceil((this.resets.get(fixture.id)! - this.now()) / 1000) } : {}) } }
        : {}),
    };
  }

  /** Who places the axis a pan or tilt channel drives, on the last frame rendered (ChannelExplanation.motion); undefined for any other channel. */
  private explainMotion(fixtureId: string, r: ResolvedFixture, offset: number): ChannelExplanation["motion"] {
    const channel: Axis | undefined = r.pan && (r.pan.coarse === offset || r.pan.fine === offset) ? "pan" : r.tilt && (r.tilt.coarse === offset || r.tilt.fine === offset) ? "tilt" : undefined;
    const status = this.lastMotion.get(fixtureId);
    if (!channel || !status) return undefined;
    const axis: Axis = r.patch.orientation?.swapPanTilt ? (channel === "pan" ? "tilt" : "pan") : channel;
    const a = status[axis];
    const named = (owner: string) => {
      const name = owner.startsWith("look:") ? this.looks.get(owner.slice(5))?.name : undefined;
      return name === undefined ? {} : { name };
    };
    const masked: NonNullable<ChannelExplanation["motion"]>["masked"] = [];
    for (const c of this.motionClaims(this.movingHeads(), this.now(), this.tempo.state().beats)) {
      if (!c.heads.includes(fixtureId) || !claimsAxis(c, axis) || c.owner === a.owner || masked.some((m) => m.owner === c.owner)) continue;
      masked.push({ owner: c.owner, ...named(c.owner), ...(status.released.includes(claimKey(c)) ? { released: true as const } : {}) });
    }
    return {
      axis,
      layer: a.layer,
      owner: a.owner,
      ...(a.owner ? named(a.owner) : {}),
      lock: status.lock,
      position: a.position,
      moving: a.moving,
      ...(a.moving && a.from !== undefined ? { from: a.from } : {}),
      ...(a.moving && a.target !== undefined ? { to: a.target } : {}),
      ...(a.moving && a.remainingMs !== undefined ? { remainingMs: Math.round(a.remainingMs) } : {}),
      ...(a.error === undefined ? {} : { error: a.error }),
      masked,
    };
  }

  /** The fixtures a look leaves out: those of the groups whose presets exclude it. */
  private excludedFrom(look: Look): Set<string> {
    const excluded = new Set<string>();
    for (const g of this.groups.list()) if (g.presets.excluded.includes(look.id)) for (const f of this.fixturesOf(g.id)) excluded.add(f);
    return excluded;
  }

  /**
   * The looks painting a fixture's heads that `here` accepts (dmx.explain), read only when asked, never per frame:
   * the heads the cells of a look's current step paint — the cells it leaves empty paint nothing, nor does a look
   * that only holds raw channels — through the frame's own path (Venue.paintCanvas, then its halo spelt out by
   * Venue.followAccents), in the order the looks compose: the ones leaving (an exit fade, under a crossfade), then
   * the ones playing. Under `looksMerge: "last"`, a playing look a later playing look also paints there is covered.
   */
  private paintingLooks(fixtureId: string, here: (heads: Set<number>) => boolean): NonNullable<ChannelExplanation["paintingLooks"]> {
    const now = this.now();
    const beats = this.tempo.state().beats;
    const paints = ({ look, player }: { look: Look; player: LookPlayer }): boolean => {
      if (this.excludedFrom(look).has(fixtureId)) return false;
      const own = emptyFrame();
      try {
        this.venue.paintCanvas(own, look.canvas, player.render(now, beats));
      } catch {
        return false; // an unknown canvas paints nothing
      }
      const sheet = own.colors.get(fixtureId);
      if (!sheet?.size) return false;
      this.venue.followAccents(new Map([[fixtureId, sheet]]));
      return here(new Set(sheet.keys()));
    };
    const leaving = [...this.releasing.values(), ...[...this.crossfades.values()].flatMap((x) => x.outgoing)]
      .filter((l, i, all) => !this.active.has(l.look.id) && all.findIndex((x) => x.look.id === l.look.id) === i && paints(l))
      .map(({ look }) => ({ id: look.id, name: look.name, leaving: true as const }));
    const playing = [...this.active.values()].filter(paints).map(({ look }) => ({ id: look.id, name: look.name }));
    const last = this.settings.looksMerge === "last";
    return [...leaving, ...playing.map((l, i) => (last && i < playing.length - 1 ? { ...l, covered: true as const } : l))];
  }

  /**
   * Intensity of a fixture: grand master × the own level of every DCA covering it — directly, by selector
   * or through any sub-group —, each once (T35, docs/specs/groups-masters.md, « Calcul »).
   */
  intensityOf(fixtureId: string, index = this.dcaIndex()): number {
    return this.grandMasterLevel() * index.product(index.covering(fixtureId));
  }

  /**
   * The rules bounding the output now: the engine's built-in ones (the Reset protection), then those
   * of no program or of the active one; not those for some callers only.
   */
  rulesInForce(program = this.activeProgram): Rule[] {
    return [...this.builtinRules(), ...rulesInForce([...this.venueRules.list(), ...this.rules.list()], program).filter((r) => !r.appliesTo && !isBuiltinRule(r.id))];
  }

  /** Rules of the engine itself, in force on every venue and show, neither deletable nor editable. */
  builtinRules(): Rule[] {
    return [resetProtectionRule()];
  }

  /** Voluntary resets (`fixture.reset`): fixture id → when the protection of its Reset channels comes back (runtime clock). */
  private readonly resets = new Map<string, number>();

  /**
   * Resets a fixture on purpose: for RESET_WINDOW_MS, its Reset channels get the value that triggers
   * the reset (over the show and the console), the built-in protection lifted on those channels only
   * (a twin wired on the same address gets it too: it shares them); then the protection comes back.
   * Refused for a fixture without a Reset channel.
   */
  startReset(fixtureId: string): { fixture: string; channels: ResetChannel[]; until: number; seconds: number } {
    const r = this.venue.resolve(fixtureId);
    if ("error" in r) throw new Error(r.error);
    const channels = resetChannels(r);
    if (!channels.length) throw new Error(say(`${r.patch.name} n'a pas de canal Reset dans sa définition`, `${r.patch.name} has no Reset channel in its definition`));
    const until = this.now() + RESET_WINDOW_MS;
    this.resets.set(fixtureId, until);
    return { fixture: fixtureId, channels, until, seconds: RESET_WINDOW_MS / 1000 };
  }

  /** Stops the voluntary resets under way (all, or one fixture's): the protection holds again at once. */
  cancelResets(fixtureId?: string): void {
    if (fixtureId === undefined) this.resets.clear();
    else this.resets.delete(fixtureId);
  }

  /** The DMX slots the voluntary resets send now: universe → 0-based index → value. */
  private resetSlots(now = this.now()): Map<number, Map<number, number>> {
    const slots = new Map<number, Map<number, number>>();
    for (const id of [...this.resets.keys()]) {
      const f = this.venue.fixtures.get(id);
      const r = this.venue.resolve(id);
      if (!this.resetting(id, now) || !f || "error" in r || this.venue.absent.has(id)) continue;
      const u = slots.get(f.universe) ?? new Map<number, number>();
      for (const c of resetChannels(r)) if (f.address - 1 + c.offset < 512) u.set(f.address - 1 + c.offset, c.value);
      slots.set(f.universe, u);
    }
    return slots;
  }

  /**
   * What a voluntary reset really sends, read in rendered buffers: per Reset channel, the value out
   * and, when it is not the reset's, the rules that moved that slot on the last frame (by name,
   * through whichever fixture shares it). Blackout and the output's standby are the caller's to
   * tell: they live in the engine and the router.
   */
  resetOutcome(fixtureId: string, buffers: readonly Uint8Array[]): { name: string; value: number; sent: number; rules: string[]; beyond?: true }[] {
    const f = this.venue.fixtures.get(fixtureId);
    const r = this.venue.resolve(fixtureId);
    if (!f || "error" in r) return [];
    const names = new Map(this.rulesInForce().map((x) => [x.id, x.name || x.id]));
    const slotOf = (c: Clamp): number | undefined => {
      const o = this.venue.fixtures.get(c.fixture);
      const ro = this.venue.resolve(c.fixture);
      if (!o || o.universe !== f.universe || "error" in ro) return undefined;
      const offset = ro.mode.channels.indexOf(c.channel);
      return offset < 0 ? undefined : o.address - 1 + offset;
    };
    return resetChannels(r).map((c) => {
      const index = f.address - 1 + c.offset;
      // past channel 512: the fixture runs off its universe, that channel is never sent
      if (index >= 512) return { name: c.name, value: c.value, sent: 0, rules: [], beyond: true as const };
      const sent = buffers[f.universe - 1]?.[index] ?? 0;
      const rules = sent === c.value ? [] : [...new Set(this.lastClamps.filter((x) => slotOf(x) === index).map((x) => names.get(x.rule) ?? x.rule))];
      return { name: c.name, value: c.value, sent, rules };
    });
  }

  /** Whether a voluntary reset of this fixture is under way; a closed window is forgotten. */
  resetting(fixtureId: string, now = this.now()): boolean {
    const until = this.resets.get(fixtureId);
    if (until === undefined) return false;
    if (now < until) return true;
    this.resets.delete(fixtureId);
    return false;
  }

  /** The rules in force for some callers only (appliesTo) that concern this one. */
  callerRules(caller: { origin?: string; role?: string }): Rule[] {
    return rulesInForce([...this.venueRules.list(), ...this.rules.list()], this.activeProgram).filter(
      (r) => r.appliesTo && ((caller.origin !== undefined && r.appliesTo.origins?.includes(caller.origin as never)) || (caller.role !== undefined && r.appliesTo.roles?.includes(caller.role))),
    );
  }

  /** Activates a rule program (undefined = none); returns whether it changed. */
  selectProgram(id: string | undefined): boolean {
    if (id !== undefined && !this.programs.get(id)) throw new Error(say(`programme inconnu : ${id}`, `unknown program: ${id}`));
    const changed = this.activeProgram !== id;
    this.activeProgram = id;
    return changed;
  }

  /** The program a MIDI Program Change selects, if any. */
  programFor(channel: number, number: number): RuleProgram | undefined {
    return this.programs.list().find((p) => p.programChange === number && p.channel === channel);
  }

  /** Tags and groups by kind of fixture to propose (venue/grouping.ts): nothing is written. */
  typeGrouping(): TypeGrouping {
    const fixtures = this.venue.fixtures.list().map((f) => {
      const own = { id: f.id, name: f.name, tags: f.tags, ...(f.role ? { role: f.role } : {}) };
      const r = this.venue.resolve(f.id);
      if ("error" in r) return { ...own, type: "", moving: false, machine: false, colour: false };
      const channels = r.mode.channels.map((n) => r.def.channels.get(n));
      return { ...own, type: r.def.type, moving: Boolean(r.pan || r.tilt), machine: channels.some((c) => c?.tags.includes("machine")), colour: channels.some((c) => c?.attribute === "color") };
    });
    const proposal = proposeTypeGrouping(fixtures, this.groups.list().map(existingGroup));
    // the tags live in the venue: the live groups of the other shows on it change too
    const elsewhere = this.otherShowsGroups().flatMap((o) => affectedGroups(fixtures, proposal.tags, o.groups.map(existingGroup)).map((a) => ({ ...a, show: o.show })));
    return { ...proposal, affected: [...proposal.affected, ...elsewhere] };
  }

  /** The groups of the other shows playing on this venue (set by the plugin, which reads their folders); none in tests. */
  otherShowsGroups: () => { show: string; groups: Group[] }[] = () => [];

  /** The moving heads while a frame is composed: listed once for the frame (compose, the claims, the read-back). */
  private frameHeads: string[] | undefined;

  /** Runs `fn` with the moving heads listed once. */
  private withHeads<T>(fn: () => T): T {
    const had = this.frameHeads;
    this.frameHeads ??= this.movingHeads();
    try {
      return fn();
    } finally {
      this.frameHeads = had;
    }
  }

  /** Moving heads of the venue (fixtures with pan or tilt), in patch order. */
  movingHeads(): string[] {
    if (this.frameHeads) return this.frameHeads;
    return this.venue.fixtures.list().filter((f) => {
      if (this.venue.absent.has(f.id)) return false;
      const r = this.venue.resolve(f.id);
      return !("error" in r) && (r.pan || r.tilt);
    }).map((f) => f.id);
  }

  /** Fixtures moved by a look, in row order (canvas order, or by X position for a group). */
  movedBy(look: Look): string[] {
    const heads = new Set(this.movingHeads());
    if (look.move?.group) {
      const pos = (id: string) => this.venue.fixtures.get(id)?.position?.x ?? 0;
      const order = this.venue.fixtures.list().map((f) => f.id);
      return [...this.fixturesOf(look.move.group)].filter((f) => heads.has(f)).sort((a, b) => pos(a) - pos(b) || order.indexOf(a) - order.indexOf(b));
    }
    const out: string[] = [];
    for (const cell of this.venue.cellTargets(look.canvas)) for (const t of cell) if (heads.has(t.fixture) && !out.includes(t.fixture)) out.push(t.fixture);
    return out;
  }

  /**
   * Sets a manual position (normalised pan/tilt) on fixtures: the manual claim of the motion layer, above the looks
   * until released. Pan or tilt alone keeps the other axis as it was claimed, or leaves it to the layer below. Each
   * command is a new claim (a new launch order, the counter of the looks). "direct": the head follows at once (the
   * pad, a gesture); "glide": it goes there over the show's `moveFade` (a destination recalled, T32).
   */
  setPosition(fixtures: string[], p: Partial<Position>, how: "direct" | "glide" = "direct"): void {
    const order = ++this.launches;
    for (const f of fixtures) {
      const cur = this.manualPositions.get(f)?.position;
      const position = { ...cur, ...(p.pan === undefined ? {} : { pan: p.pan }), ...(p.tilt === undefined ? {} : { tilt: p.tilt }) };
      this.manualPositions.set(f, { position, order, glide: how === "glide" });
    }
  }

  /** Releases manual positions (all when no fixture is given): the layer below takes the heads, gliding; returns the released fixtures. */
  releasePositions(fixtures?: string[]): string[] {
    const ids = fixtures ?? [...this.manualPositions.keys()];
    return ids.filter((f) => this.manualPositions.delete(f));
  }

  /** The manual position of a head, if any; an axis it does not place is where the head was last sent. */
  manualPosition(fixture: string): Position | undefined {
    const manual = this.manualPositions.get(fixture)?.position;
    if (!manual) return undefined;
    const sent = this.sentPositions.get(fixture);
    return { pan: manual.pan ?? sent?.pan ?? 0.5, tilt: manual.tilt ?? sent?.tilt ?? 0.5 };
  }

  /** Why each moving head is where it is (engine/motion.ts, HeadStatus), on the last frame rendered. */
  motionStatus(): ReadonlyMap<string, HeadStatus> {
    return this.lastMotion;
  }

  /** The logical position a moving head was really sent on the last frame (after the rules and the guard). */
  sentPosition(fixture: string): Position | undefined {
    return this.sentPositions.get(fixture);
  }

  /**
   * « Rendre la main »: on a target, releases only the strongest top layer present among its heads, axis by axis.
   * Other heads keep their layer until a later press reaches it. The layer below takes over, gliding, down to rest.
   * A look released keeps playing: it claims the head again once started again. Returns, per head, the owners released.
   */
  releaseTop(fixtures?: string[]): { fixture: string; released: string[] }[] {
    return this.releaseClaims("top", fixtures);
  }

  /** `position.home`: releases every claim on heads (but a lock): they glide to their rest position. */
  homePositions(fixtures?: string[]): { fixture: string; released: string[] }[] {
    return this.releaseClaims("all", fixtures);
  }

  private releaseClaims(scope: "top" | "all", fixtures?: string[]): { fixture: string; released: string[] }[] {
    const all = this.movingHeads();
    const heads = fixtures ? fixtures.filter((f) => all.includes(f)) : all;
    const before = this.motionState;
    this.motionState = releaseMotion({ heads: all, claims: this.motionClaims(all, this.now(), this.tempo.state().beats), lock: this.motionLock }, before, { heads, scope });
    return heads.map((head) => {
      const was = new Set(releasedOf(before, head));
      const added = releasedOf(this.motionState, head).filter((key) => !was.has(key));
      // a manual claim released is gone: the next command is a new one
      const manual = this.manualPositions.get(head);
      if (manual && added.includes(claimKey({ owner: "manual", order: manual.order }))) this.manualPositions.delete(head);
      // a Panic hold let go is told like a claim
      const hold = isHeld(before, head) && !isHeld(this.motionState, head) ? ["hold"] : [];
      return { fixture: head, released: [...new Set([...added.map(ownerOfClaimKey), ...hold])] };
    });
  }

  /**
   * Lets heads out of the hold a Panic left (all the moving heads when none is given), and nothing else: they glide
   * to the look that claims them, else to rest. Returns the heads that were held. `position.release` calls it: after
   * a Panic, the button that hands a head back must not leave it stuck.
   */
  releaseHold(fixtures?: string[]): string[] {
    const all = this.movingHeads();
    const held = (fixtures ?? all).filter((f) => all.includes(f) && isHeld(this.motionState, f));
    if (held.length) this.motionState = releaseMotion({ heads: all, claims: [], lock: this.motionLock }, this.motionState, { heads: held, scope: "hold" });
    return held.filter((f) => !isHeld(this.motionState, f));
  }

  /**
   * Panic (R10): no head moves by itself. Every claim present is released and the heads hold where they are until a
   * new claim takes them — the safe look or snapshot, started after, glides in. Call it before stopping the looks.
   */
  holdPositions(): void {
    const heads = this.movingHeads();
    this.motionState = holdMotion({ claims: this.motionClaims(heads, this.now(), this.tempo.state().beats) }, this.motionState, heads);
  }

  /**
   * What claims the moving heads at `now` (engine/motion.ts), each claim with its launch order: the moves of the
   * looks — those leaving keep theirs to the end of their fade, as their colours do —, the raw pan/tilt channels of
   * the looks (question 6: the bytes turned into a logical position by venue.readPosition, on the axes written only),
   * then the manual positions. A look's raw pan/tilt comes after its own move: it wins on the axes it writes.
   */
  private motionClaims(heads: readonly string[], now: number, beats: number, errors: string[] = []): MotionClaim[] {
    const claims: MotionClaim[] = [];
    if (!heads.length) return claims;
    const isHead = new Set(heads);
    const resolved = new Map<string, ResolvedFixture | undefined>();
    const headAt = (id: string): ResolvedFixture | undefined => {
      if (!resolved.has(id)) {
        const r = isHead.has(id) ? this.venue.resolve(id) : undefined;
        resolved.set(id, r && !("error" in r) ? r : undefined);
      }
      return resolved.get(id);
    };
    const ofLook = (look: Look, player: LookPlayer): void => {
      const own = { owner: `look:${look.id}`, layer: "look" as const, order: this.launchOrder.get(player) ?? 0, ...(look.move?.fade ? { fade: look.move.fade } : {}) };
      if (look.move) {
        try {
          const moved = this.movedBy(look);
          if (moved.length) claims.push({ ...own, heads: moved, shape: { move: look.move, cycles: player.position(now, beats, look.move.every) } });
        } catch (err) {
          errors.push((err as Error).message);
        }
      }
      if (!look.channels) return;
      const row = look.channels.steps[player.rawStep(now, beats, look.channels.steps.length)] ?? [];
      const bytes = new Map<string, Map<number, number>>();
      look.channels.targets.forEach((t, k) => {
        const r = headAt(t.fixture);
        if (!r || !motionOffsets(r).has(t.offset)) return;
        const mine = bytes.get(t.fixture) ?? new Map<number, number>();
        bytes.set(t.fixture, mine.set(t.offset, Math.max(mine.get(t.offset) ?? 0, row[k] ?? 0)));
      });
      for (const [f, mine] of bytes) {
        const at = this.venue.readPosition(headAt(f)!, (offset) => mine.get(offset));
        if (at.pan !== undefined || at.tilt !== undefined) claims.push({ ...own, heads: [f], base: { kind: "fixed", ...at } });
      }
    };
    for (const r of this.releasing.values()) if (exitProgress(r, now) < 1) ofLook(r.look, r.player);
    for (const x of this.crossfades.values()) for (const o of x.outgoing) if (this.outWeight(o, now) > 0) ofLook(o.look, o.player);
    for (const { look, player } of this.active.values()) ofLook(look, player);
    for (const [f, m] of this.manualPositions) if (isHead.has(f)) claims.push({ owner: "manual", layer: "manual", order: m.order, heads: [f], base: { kind: "fixed", ...m.position }, ...(m.glide ? {} : { fade: DIRECT }) });
    return claims;
  }

  /** Whether an axis of a head glides or cuts at a change of owner: the box of the channel that axis drives (T5, ResolvedTracks.motion). */
  private axisMode(head: string, axis: Axis): AxisMode {
    const r = this.venue.resolve(head);
    if ("error" in r || !r.tracks) return "glide";
    const channel: Axis = r.patch.orientation?.swapPanTilt ? (axis === "pan" ? "tilt" : "pan") : axis;
    return r.tracks.motion[channel] ?? "glide";
  }

  /** The logical position each moving head has in `buffers`; an axis a head does not have keeps the layer's own value. */
  private readBack(buffers: readonly Uint8Array[]): Map<string, Position> {
    const sent = new Map<string, Position>();
    for (const id of this.movingHeads()) {
      const r = this.venue.resolve(id);
      const buf = "error" in r ? undefined : buffers[r.patch.universe - 1];
      if ("error" in r || !buf) continue;
      const at = this.venue.sentPosition(r, buf);
      const status = this.lastMotion.get(id);
      sent.set(id, { pan: at.pan ?? status?.pan.position ?? 0.5, tilt: at.tilt ?? status?.tilt.position ?? 0.5 });
    }
    return sent;
  }

  /** Points fixtures at a point of the stage (metres); returns per-fixture results. */
  aim(fixtures: string[], target: { x: number; y: number; z: number }): { fixture: string; pan?: number; tilt?: number; error?: string }[] {
    return fixtures.map((id) => {
      const f = this.venue.fixtures.get(id);
      const r = this.venue.resolve(id);
      if (!f || "error" in r) return { fixture: id, error: f ? (r as { error: string }).error : say(`fixture inconnue : ${id}`, `unknown fixture: ${id}`) };
      if (!r.pan && !r.tilt) return { fixture: id, error: say("pas de pan/tilt", "no pan/tilt") };
      if (!f.position) return { fixture: id, error: say("position sur la scène inconnue", "stage position unknown") };
      const res = aimAt(aimSetupOf(r)!, target);
      if ("error" in res) return { fixture: id, error: res.error };
      this.setPosition([id], res);
      return { fixture: id, pan: res.pan, tilt: res.tilt };
    });
  }

  /** Renders the playing looks into DMX buffers. */
  render(buffers: Uint8Array[]): void {
    this.withHeads(() => {
      const tempo = this.tempo.state();
      const run: MotionRun = { state: this.motionState, sent: this.sentPositions, bpm: tempo.bpm ?? FALLBACK_BPM, status: this.lastMotion };
      const errors = this.compose(buffers, this.now(), tempo.beats, this.wheels, run);
      this.motionState = run.state;
      this.lastMotion = run.status;
      // Rules mask: last stage of the show's output.
      this.lastClamps = this.mask(buffers, this.rulesInForce());
      this.lastErrors = errors;
      // what the heads were really sent (the guard reads it again after the console and its own limits)
      this.sentPositions = this.readBack(buffers);
    });
  }

  /**
   * What would bound a look on its launch, among the rules that refuse or ask rather than clamp
   * (`onViolation`): its first four seconds are played in memory, with what plays now, and compared
   * with the same seconds without it. Nothing reaches the output and no state changes.
   */
  strictBounds(lookId: string, caller: { origin?: string; role?: string } = {}): { rule: Rule; clamps: Clamp[] }[] {
    // a rule for some callers only bounds nothing on the output: on their launches, a clamp refuses
    const forCaller = this.callerRules(caller).map((r) => (r.onViolation === "clamp" ? { ...r, onViolation: "reject" as const } : r));
    const strict = [...this.rulesInForce().filter((r) => r.onViolation === "reject" || r.onViolation === "confirm"), ...forCaller];
    const look = this.looks.get(lookId);
    if (!strict.length || !look || this.active.has(lookId)) return [];
    const universes = Math.max(1, ...this.venue.fixtures.list().map((f) => f.universe));
    const zoneById = this.zoneLookup();
    const t0 = this.now();
    const { beats: b0, bpm } = { bpm: 120, ...this.tempo.state() } as { beats: number; bpm?: number };
    // speed rules that refuse or ask: the pan/tilt course of the frames sampled is measured against them
    const speedRules = strict.filter((r) => r.maxDegPerSecond);
    const sample = (): Set<string> => {
      const seen = new Set<string>();
      const wheels = new Map(this.wheels); // played in memory: the wheels held on the output stay as they are
      // and so does the motion layer: its transitions are played from the state it has now, which is not kept
      const run: MotionRun = { state: this.motionState, sent: this.sentPositions, bpm: bpm ?? FALLBACK_BPM, status: this.lastMotion };
      const blank = () => Array.from({ length: universes }, () => new Uint8Array(512));
      const eachFixture = (out: Uint8Array[], visit: (r: ResolvedFixture, buf: Uint8Array) => Clamp[]): void => {
        for (const f of this.venue.installed()) {
          const r = this.venue.resolve(f.id);
          const buf = out[f.universe - 1];
          if ("error" in r || !buf) continue;
          for (const c of visit(r, buf)) seen.add(JSON.stringify([c.rule, c.fixture, c.channel]));
        }
      };
      // where the heads are now, one frame before the first sample: what their speed is measured from
      const speeds = new Map<string, { v: number; t: number }>();
      if (speedRules.length) {
        const sent = emptyFrame();
        for (const [head, p] of this.sentPositions) sent.positions.set(head, p);
        const before = blank();
        this.venue.toDmx(sent, before, new Map(wheels), { now: t0, merge: this.settings.looksMerge });
        eachFixture(before, (r, buf) => (applySpeeds(speedRules, r, buf, t0 - STRICT_FRAME_MS, speeds, zoneById), []));
      }
      for (let k = 0; k < 20; k++) {
        const sampled = blank();
        this.compose(sampled, t0 + k * 200, b0 + (k * 0.2 * (bpm ?? 120)) / 60, wheels, run);
        run.sent = undefined; // the frames after the first follow the layer's own course
        eachFixture(sampled, (r, buf) => [...applyRules(strict, r, buf, zoneById), ...(speedRules.length ? applySpeeds(speedRules, r, buf, t0 + k * 200, speeds, zoneById) : [])]);
      }
      // and where everything lands: one frame once every fade and every glide is over, so that a long glide towards
      // a forbidden position is bounded too (not its speed: no time is measured across that leap)
      const landed = blank();
      this.compose(landed, t0 + STRICT_ARRIVAL_MS, b0 + ((STRICT_ARRIVAL_MS / 1000) * (bpm ?? 120)) / 60, wheels, run);
      eachFixture(landed, (r, buf) => applyRules(strict, r, buf, zoneById));
      return seen;
    };
    // go() drops the look's own fading copy: it belongs to neither sample (put back after)
    const fadingCopy = this.releasing.get(lookId);
    this.releasing.delete(lookId);
    // and so do the crossfades that name it, as the incoming look or one of the leaving ones
    const crossfadesAside = [...this.crossfades].filter(([key, c]) => key === lookId || c.outgoing.some((o) => o.look.id === lookId));
    for (const [key] of crossfadesAside) this.crossfades.delete(key);
    let without: Set<string>;
    let withIt: Set<string>;
    // the samples drop the shared sheets of the crossfades set aside (compose): they come back with them
    const sheets = [...this.sharedSheet];
    // the launch played in memory takes no launch order: the real one gets the same
    const launches = this.launches;
    try {
      without = this.withHeads(sample);
      const player = this.build(look);
      player.start(t0, b0);
      this.launchOrder.set(player, ++this.launches);
      this.active.set(lookId, { look, player });
      withIt = this.withHeads(sample);
    } finally {
      this.active.delete(lookId);
      this.launches = launches;
      if (fadingCopy) this.releasing.set(lookId, fadingCopy);
      for (const [key, c] of crossfadesAside) this.crossfades.set(key, c);
      this.sharedSheet.clear();
      for (const [id, key] of sheets) this.sharedSheet.set(id, key);
    }
    const byRule = new Map<string, Clamp[]>();
    for (const key of withIt) {
      if (without.has(key)) continue;
      const [rule, fixture, channel] = JSON.parse(key) as [string, string, string];
      byRule.set(rule, [...(byRule.get(rule) ?? []), { rule, fixture, channel, from: 0, to: 0 }]);
    }
    return [...byRule].map(([id, clamps]) => ({ rule: strict.find((r) => r.id === id)!, clamps }));
  }

  /** The show's output before the rules: looks, positions, levels, raw channels, channel faders. */
  private compose(buffers: Uint8Array[], now: number, beats: number, wheels: Map<string, WheelChoice>, motion: MotionRun): string[] {
    const frame = emptyFrame();
    const errors: string[] = [];
    // Fades that ended in real time go (not at a sampled future instant: strictBounds() must change nothing).
    const real = this.now();
    for (const [id, r] of this.releasing) if ((real - r.stopTime) / 1000 >= r.exitFade) this.releasing.delete(id);
    for (const [id, c] of this.crossfades) if (real >= Math.max(c.t0 + c.tIn * 1000, ...c.outgoing.map((o) => o.t + o.dur * 1000))) this.crossfades.delete(id);
    // a shared sheet lasts as long as the crossfade it is shared with, for a look still playing or leaving through its own
    for (const [id, other] of this.sharedSheet) if (!this.crossfades.has(other) || !(this.active.has(id) || this.crossfades.has(id))) this.sharedSheet.delete(id);
    /**
     * Raw channels of the looks, by fixture then offset: every look's write with its weight and its sheet — a
     * crossfade and the looks it replaces share one (`x:<incoming>`), any other look has its own — so that
     * venue.toDmx shares a channel inside a sheet and keeps the highest sheet (rawOver).
     */
    const lookChannels = new Map<string, Map<number, RawWrite[]>>();
    // who doses what on this frame (show/dca.ts): one snapshot, dropped with the frame
    const doses = this.doses();
    /**
     * The fixtures whose tracks are enabled (T5, venue/tracks.ts), with their pan/tilt offsets: the looks reach them as
     * layers (layerOf), not through the colours and raw channels below — but for pan/tilt and offsets past their mode, which stay raw and verbatim.
     */
    const trackFixtures = new Map<string, (offset: number) => boolean>();
    const trackColours = new Map<string, Set<number>>();
    for (const f of this.venue.installed()) {
      const r = this.venue.resolve(f.id);
      if ("error" in r || !r.tracks) continue;
      trackFixtures.set(f.id, verbatimOffsets(r));
      trackColours.set(f.id, new Set([...r.heads.values()].flatMap((c) => Object.values(c))));
    }
    /** Removes the fixtures with tracks from a look's colours, in place (after `paints`, which must still see them: the wheel). */
    const withoutTracks = <M extends Map<string, unknown>>(colors: M): M => {
      if (trackFixtures.size) for (const f of trackFixtures.keys()) colors.delete(f);
      return colors;
    };
    /** Whether a look's canvas reaches a fixture with tracks: only then is it painted at full for them. */
    const reachesTracks = new Map<string, boolean>();
    const touches = (canvas: string): boolean => {
      let hit = reachesTracks.get(canvas);
      if (hit === undefined) {
        try {
          hit = this.venue.cellTargets(canvas).some((cell) => cell.some((t) => trackFixtures.has(t.fixture)));
        } catch {
          hit = false; // an unknown canvas paints nothing (told by the look's own colours)
        }
        reachesTracks.set(canvas, hit);
      }
      return hit;
    };
    /**
     * A look on the fixtures with tracks, as one layer each (venue/tracks.ts): what it paints there at full (atFull,
     * its exclusions taken out), its raw channels but pan/tilt, the weight and sheet of its raw writes, and the level
     * its groups give it per light channel (Doses.lookLevel, T35: not by those already dosing the fixture).
     */
    const ranks = new Map<TrackLayer, number>();
    const layerOf = (look: Look, player: LookPlayer, weight: number, sheet: string, row: readonly number[] | undefined, rank = this.launchOrder.get(player) ?? 0): void => {
      const painted = touches(look.canvas) ? atFull(look, player) : undefined;
      const excluded = painted ? this.excludedFrom(look) : new Set<string>();
      const raw = new Map<string, Map<number, number>>();
      look.channels?.targets.forEach((t, k) => {
        const verbatim = trackFixtures.get(t.fixture);
        if (!verbatim || verbatim(t.offset)) return;
        raw.set(t.fixture, (raw.get(t.fixture) ?? new Map<number, number>()).set(t.offset, row?.[k] ?? 0));
      });
      const included = doses.isIncluded(look.id);
      for (const f of trackFixtures.keys()) {
        const colors = excluded.has(f) ? undefined : painted?.get(f);
        const own = raw.get(f);
        if (!colors && !own) continue;
        let level: Map<number, number> | undefined;
        const light = included ? doses.light(f) : undefined;
        if (light)
          for (const o of [...light.dimmers, ...light.colours]) {
            const l = doses.lookLevel(look.id, f, o);
            if (l !== 1) (level ??= new Map()).set(o, l);
          }
        const layer: TrackLayer = { look: look.id, sheet, weight, raw: own ?? new Map(), ...(colors ? { colors } : {}), ...(level ? { level } : {}) };
        ranks.set(layer, rank);
        const stack = frame.tracks.get(f);
        if (stack) stack.push(layer);
        else frame.tracks.set(f, [layer]);
      }
    };
    /**
     * `tracks`: on the fixtures with tracks, the sheet when it is not the raw writes' own (a crossfade sharing another's,
     * sharedSheet), and `leaving`: the part of a look started again while it left that still lies at the rank it had —
     * the rest of its weight is laid at its new rank, in the same sheet (venue/tracks.ts overSheets keeps their mean),
     * or in a sheet of its own (`leaving.sheet`) when the look released others as it came back.
     */
    const rawOf = (look: Look, player: LookPlayer, weight: number, sheet: string, tracks?: { sheet: string; leaving?: { weight: number; rank: number; sheet?: string } }): void => {
      const row = look.channels ? (look.channels.steps[player.rawStep(now, beats, look.channels.steps.length)] ?? []) : undefined;
      if (trackFixtures.size) {
        const left = tracks?.leaving;
        if (left && left.weight > 0) layerOf(look, player, left.weight, left.sheet ?? tracks.sheet, row, left.rank);
        layerOf(look, player, weight - (left?.weight ?? 0), tracks?.sheet ?? sheet, row);
      }
      if (!look.channels || !row) return;
      const included = doses.isIncluded(look.id);
      look.channels.targets.forEach((t, k) => {
        // a fixture with tracks keeps only its raw pan/tilt and offsets past its mode here (verbatim): the rest rides on its layers
        const verbatim = trackFixtures.get(t.fixture);
        if (verbatim && !verbatim(t.offset)) return;
        const byOffset = lookChannels.get(t.fixture) ?? new Map<number, RawWrite[]>();
        const level = included ? doses.lookLevel(look.id, t.fixture, t.offset) : 1;
        byOffset.set(t.offset, [...(byOffset.get(t.offset) ?? []), { value: row[k] ?? 0, weight, look: look.id, sheet, ...(level === 1 ? {} : { level }) }]);
        lookChannels.set(t.fixture, byOffset);
      });
    };
    /**
     * Notes the fixtures a look paints with the weight its colours carry: they dose themselves (venue.toDmx, the machine
     * fade). Not those it paints on their accent heads only (a halo): that is no full colour of the fixture.
     */
    const paints = (colors: AttributeFrame["colors"], weight: number, look: Look, player: LookPlayer, sheet: string): AttributeFrame["colors"] => {
      for (const [f, heads] of colors) {
        if (!this.venue.lightsBody(f, heads.keys())) continue;
        const byLook = frame.painted.get(f) ?? new Map<string, number>();
        frame.painted.set(f, byLook.set(look.id, Math.max(byLook.get(look.id) ?? 0, Math.max(0, weight))));
        // a lamp's colour wheel follows one look: which look paints what, on which sheet, and its colour at full
        if (this.venue.hasWheel(f)) frame.paintedBy.set(f, [...(frame.paintedBy.get(f) ?? []), { look: look.id, sheet, heads, hues: (full1.has(colors) && weight >= 1 ? heads : (atFull(look, player).get(f) ?? heads)) }]);
      }
      return colors;
    };
    /**
     * What a look paints at full, before its fades and its masters: a colour wheel pre-positions on it while the
     * light is still dark. Painted once per look and frame, and only for a look that reaches a wheel.
     */
    const full = new Map<LookPlayer, AttributeFrame["colors"]>();
    /** Colour maps painted at fade 1 and masters 1: already at full, no second paint needed. */
    const full1 = new WeakSet<AttributeFrame["colors"]>();
    const atFull = (look: Look, player: LookPlayer): AttributeFrame["colors"] => {
      let own = full.get(player);
      if (!own) {
        const sheet = emptyFrame();
        try {
          this.venue.paintCanvas(sheet, look.canvas, player.state(now, beats));
        } catch {
          // told once already, by the look's own colours
        }
        // the halo spelt out as in colorsOf, so that the same heads are read at full and now
        this.venue.followAccents(sheet.colors);
        full.set(player, (own = sheet.colors));
      }
      return own;
    };
    /**
     * A look's colours on its own sheet, scaled by `fade` and, fixture by fixture, by the masters of the groups
     * including it (lookLevelOn: not by those already dosing the fixture), its exclusions taken out.
     */
    const colorsOf = (look: Look, player: LookPlayer, fade: number): AttributeFrame["colors"] => {
      let step: Step = player.render(now, beats);
      const excluded = this.excludedFrom(look);
      if (fade < 1) step = step.map((c) => (c ? scaleColor(c, fade) : c));
      const own = emptyFrame();
      try {
        this.venue.paintCanvas(own, look.canvas, step);
      } catch (err) {
        errors.push((err as Error).message);
      }
      for (const f of excluded) own.colors.delete(f);
      // the halo as this look shows it, before any merge or fade: it then fades and merges like any head
      this.venue.followAccents(own.colors);
      // the groups including the look dose it per fixture, its halo with it: a factor per fixture (or per channel)
      // commutes with how paintCanvas merges the cells there (highest, mean), so it can come after the paint
      let dosed = false;
      if (doses.isIncluded(look.id)) for (const [f, heads] of own.colors) dosed = this.doseLookColours(doses, look.id, f, heads) || dosed;
      if (fade >= 1 && !dosed) full1.add(own.colors);
      return own.colors;
    };
    // Each look on its own sheet, then onto the others (show setting looksMerge), in this order so that a look just
    // started (or still playing) wins over the one leaving, in colours; their weight rides into the looks' raw
    // channels the same way. Where the heads go is the motion layer's, below. First the looks fading out on exit.
    for (const [id, r] of this.releasing) {
      const t = exitProgress(r, now);
      if (t >= 1) continue;
      // the exit fade composes with an entry still running (a look stopped mid-rise), like the colours read it
      const w = (1 - ease(t)) * r.player.entryWeight(now);
      mergeColors(frame.colors, withoutTracks(paints(colorsOf(r.look, r.player, 1 - ease(t)), w, r.look, r.player, `exit:${id}`)), this.settings.looksMerge);
      rawOf(r.look, r.player, w, `exit:${id}`, r.shared !== undefined && this.crossfades.has(r.shared) ? { sheet: this.trackSheet(r.shared) } : undefined);
    }
    // Then the looks leaving under an incoming look (docs/specs/engine-effects-timing.md, « Fondu enchaîné »): their
    // weights add up on one sheet; what is on the fixtures the incoming look paints waits to share them with it, the
    // rest goes under the active looks like the ones above.
    const ownOf = new Map<Crossfade, AttributeFrame["colors"]>();
    for (const { look, player } of this.active.values()) {
      const x = this.crossfades.get(look.id);
      if (x) ownOf.set(x, colorsOf(look, player, this.inWeight(x, now)));
    }
    const shared = new Map<Crossfade, WeightedColors>();
    for (const [key, x] of this.crossfades) {
      let leaving: WeightedColors = new Map();
      for (const o of x.outgoing) {
        const w = this.outWeight(o, now);
        if (w <= 0) continue; // gone: it would only paint black over the others
        leaving = addWeighted(leaving, weighted(withoutTracks(paints(colorsOf(o.look, o.player, w), w * o.player.entryWeight(now), o.look, o.player, `x:${key}`)), w));
        const whole = w * o.player.entryWeight(now);
        rawOf(o.look, o.player, whole, `x:${key}`, { sheet: this.trackSheet(key), ...(o.left ? { leaving: { weight: whole * o.left.share, rank: o.left.rank, ...(o.left.sheet ? { sheet: o.left.sheet } : {}) } } : {}) });
      }
      const { inside, outside } = splitByShown(leaving, ownOf.get(x) ?? emptyFrame().colors);
      shared.set(x, inside);
      mergeColors(frame.colors, settle(outside), this.settings.looksMerge);
    }
    for (const { look, player } of this.active.values()) {
      const x = this.crossfades.get(look.id);
      // a look rising on its own rises with its entry fade, like its colours; one coming in over another
      // (a crossfade) carries the crossfade's weight
      // a look resumed mid-rise under a crossfade keeps rising: its own entry composes with the crossfade's weight
      const inW = x ? this.inWeight(x, now) : 1;
      const w = inW * player.entryWeight(now);
      // started again while it was leaving (from > 0): what it still had there fades at the rank it had, the rest rises at its new one
      const risen = x && x.from < 1 ? (inW - x.from) / (1 - x.from) : 1;
      const leaving = x?.rank === undefined ? undefined : { weight: x.from * (1 - risen) * player.entryWeight(now), rank: x.rank, ...(x.apart ? { sheet: `was:${look.id}` } : {}) };
      const sheet = x ? `x:${look.id}` : `look:${look.id}`;
      rawOf(look, player, w, sheet, x || this.sharedSheet.has(look.id) ? { sheet: this.sharedSheet.has(look.id) ? this.trackSheet(look.id) : sheet, ...(leaving ? { leaving } : {}) } : undefined);
      const colors = x ? settle(addWeighted(shared.get(x)!, weighted(withoutTracks(paints(ownOf.get(x)!, w, look, player, `x:${look.id}`)), inW))) : withoutTracks(paints(colorsOf(look, player, 1), w, look, player, `look:${look.id}`));
      mergeColors(frame.colors, colors, this.settings.looksMerge);
    }
    // The motion layer (engine/motion.ts, T25): a position for every installed moving head, on every frame — who
    // claims it (looks, raw pan/tilt, manual), where its rest is, and how it glides there from what was really sent.
    const movers = this.movingHeads();
    if (movers.length) {
      const resolved = resolveMotion(
        {
          heads: movers,
          claims: this.motionClaims(movers, now, beats, errors),
          now,
          bpm: motion.bpm,
          ...(motion.sent ? { sent: motion.sent } : {}),
          settings: { moveFade: this.settings.moveFade, rest: this.settings.restPositions },
          lock: this.motionLock,
          axisMode: (head, axis) => this.axisMode(head, axis),
        },
        motion.state,
      );
      for (const [head, p] of resolved.positions) frame.positions.set(head, p);
      // a claim that cannot place a head (a shape in error) holds it where it is, and says so
      for (const [head, status] of resolved.status) for (const axis of [status.pan, status.tilt]) if (axis.error && !errors.includes(`${head}: ${axis.error}`)) errors.push(`${head}: ${axis.error}`);
      motion.state = resolved.next;
      motion.status = resolved.status;
    } else if (motion.status.size) motion.status = new Map();
    for (const f of this.venue.fixtures.list()) frame.intensity.set(f.id, this.intensityOf(f.id, doses.index));
    // The looks' raw channels, collected above with their weight: the venue's pass classifies and
    // emits them, by address even without a definition.
    frame.raw = lookChannels;
    // a fixture with tracks stacks its looks as they were launched: one leaving keeps its place while it fades
    for (const layers of frame.tracks.values()) layers.sort((a, b) => ranks.get(a)! - ranks.get(b)!);
    // and is lit at rest where a channel fader holds one of its colours up (the pass below): its dimmer then composes
    // from full, not from black, or that colour would go dark when a look comes in (venue/tracks.ts composeTracks)
    if (trackFixtures.size)
      for (const fader of this.faders.list()) {
        const travel = this.faderTravel(fader);
        for (const c of fader.channels) {
          if (frame.lit.has(c.fixture) || !trackColours.get(c.fixture)?.has(c.offset)) continue;
          const own = doses.faderValue(fader, travel, c.fixture, c.offset);
          if (!own.doses && Math.round(own.level * 255) > 0) frame.lit.add(c.fixture);
        }
      }
    errors.push(...this.venue.toDmx(frame, buffers, wheels, { now, merge: this.settings.looksMerge }));
    // Channel faders: highest takes precedence with the show, like QLC+ level sliders — except on the
    // master dimmer of a colour fixture, which the show holds at full (the DCAs dose it, docs/specs/
    // groups-masters.md): there the fader doses it too (at 0 the fixture is dark), several faders on
    // one dimmer by the highest. A lamp's dimmer (a dimmer pack) is its light: the fader raises it.
    // On a light channel (a dimmer, a colour) held by the highest, what the show sends there first follows
    // the DCAs the faders are linked to (a look writing a fader's channel follows its DCA, T35); the fader's
    // own value follows its DCA, and on the channel carrying the light the grand master and the DCAs covering
    // the fixture (« tout baisse »), each DCA once (Doses.faderValue, which dmx.explain reads too).
    const dimmerDoses = new Map<Uint8Array, Map<number, number>>();
    const highest = new Map<Uint8Array, Map<number, number>>();
    const showDosed = new Map<Uint8Array, Set<number>>();
    for (const fader of this.faders.list()) {
      const travel = this.faderTravel(fader);
      for (const c of fader.channels) {
        const f = this.venue.fixtures.get(c.fixture);
        const buf = f && buffers[f.universe - 1];
        const index = f ? f.address - 1 + c.offset : -1;
        if (!buf || index < 0 || index >= 512 || this.venue.absent.has(c.fixture)) continue;
        const own = doses.faderValue(fader, travel, c.fixture, c.offset);
        if (own.doses) {
          const dosed = dimmerDoses.get(buf) ?? new Map<number, number>();
          dimmerDoses.set(buf, dosed.set(index, Math.max(dosed.get(index) ?? 0, own.level)));
          continue;
        }
        // the show's byte is dosed once per slot, before any fader takes the highest there (twins on one address share it)
        const done = showDosed.get(buf) ?? new Set<number>();
        showDosed.set(buf, done);
        if (!done.has(index)) {
          done.add(index);
          const k = doses.index.product(doses.showDcas(c.fixture, c.offset));
          // a byte is whole: rounded here as toDmx rounds every byte it writes
          if (k !== 1) buf[index] = Math.round(buf[index]! * k);
        }
        // rounded to a byte like any value sent; the highest is taken on bytes
        const value = Math.round(own.level * 255);
        const top = highest.get(buf) ?? new Map<number, number>();
        highest.set(buf, top.set(index, Math.max(top.get(index) ?? 0, value)));
      }
    }
    for (const [buf, top] of highest) for (const [index, value] of top) if (buf[index]! < value) buf[index] = value;
    for (const [buf, dosed] of dimmerDoses) for (const [index, level] of dosed) buf[index] = Math.round(buf[index]! * level);
    return errors;
  }

  /** The master dimmer of a colour fixture, which the show holds at full and the DCAs dose (not a lamp's, nor one no colour paints): a channel fader on it doses it. */
  dosesDimmer(fixtureId: string, offset: number): boolean {
    const r = this.venue.resolve(fixtureId);
    return !("error" in r) && !r.levelDimmer && r.dimmers.includes(offset);
  }

  /**
   * What holds over the whole output, after the DMX console's forced channels (docs/specs/rules-
   * limits.md): forcing a channel overrides the show and the ordinary rules, never a locked one —
   * the venue's hardware limits hold whoever writes the channel; and no moving head lights a zone
   * it may not point into (the lectern), whoever aimed it, while its beam crosses that zone.
   */
  guard(buffers: Uint8Array[]): void {
    this.guardOutput(buffers);
    // what the heads are really sent, after the console and the limits above: where the motion layer starts from on the next frame
    this.sentPositions = this.readBack(buffers);
  }

  private guardOutput(buffers: Uint8Array[]): void {
    // a voluntary reset sends its value over the show and the console, the protection lifted on those slots (mask)
    for (const [universe, slots] of this.resetSlots()) {
      const buf = buffers[universe - 1];
      if (buf) for (const [index, value] of slots) buf[index] = value;
    }
    const rules = this.rulesInForce();
    const locked = rules.filter((r) => r.locked);
    if (locked.length) this.lastClamps.push(...this.mask(buffers, locked));
    // motion and machines, once a frame and over everything (forced channels too): pan/tilt speed, steady channels
    if (rules.some((r) => r.maxDegPerSecond || r.steadySeconds)) {
      const now = this.now();
      const zoneById = this.zoneLookup();
      for (const f of this.venue.installed()) {
        const r = this.venue.resolve(f.id);
        const buf = buffers[f.universe - 1];
        if ("error" in r || !buf) continue;
        this.lastClamps.push(...applySpeeds(rules, r, buf, now, this.motion, zoneById), ...applySteady(rules, r, buf, now, this.steady, zoneById));
      }
    }
    // a zone is open while one of the looks allowed into it plays
    const playing = new Set(this.activeLooks());
    const noAim = this.zones.list().filter((z) => z.noAim && !z.allowLooks.some((l) => playing.has(l)));
    if (!noAim.length) return;
    for (const f of this.venue.installed()) {
      const r = this.venue.resolve(f.id);
      const buf = buffers[f.universe - 1];
      if (!f.position || "error" in r || !buf || (!r.pan && !r.tilt)) continue;
      const d = this.venue.pointingOf(r, buf);
      const zone = noAim.find((z) => beamCrosses(f.position!, d, z));
      if (!zone) continue;
      // its dimmer, or its colours when it has none
      const offsets = r.dimmers.length ? r.dimmers : [...r.heads.values()].flatMap((h) => Object.values(h));
      for (const off of offsets) {
        const i = f.address - 1 + off;
        if (!buf[i]) continue;
        this.lastClamps.push({ fixture: f.id, channel: r.mode.channels[off] ?? String(off), from: buf[i]!, to: 0, rule: `zone:${zone.id}` });
        buf[i] = 0;
      }
    }
  }

  /** The zone each fixture stands in (by its position), for rules scoped to a zone. */
  private zoneLookup(): (id: string) => string | undefined {
    const zones = this.zones.list();
    return (id: string) => {
      const f = this.venue.fixtures.get(id);
      return f ? zoneOf(f, zones)?.id : undefined;
    };
  }

  /** Since when each channel bound by a duration rule has been above its level (rules.ts, applyHolds). */
  private readonly holdSince = new Map<string, number>();
  /** Last pan/tilt sent per axis (applySpeeds), and last value per steady channel (applySteady). */
  private readonly motion = new Map<string, { v: number; t: number }>();
  private readonly steady = new Map<string, { v: number; t: number }>();

  /** Last value of each Reset channel outside its maintenance ranges, per DMX slot: where the protection holds it (holdAtRest). */
  private readonly atRest = new Map<string, number>();

  /**
   * Applies rules to every fixture's channels in the buffers, durations included; what they bounded.
   * The built-in Reset protection comes last (a venue's « max 199 » may land in a Reset range) and
   * holds at rest rather than at the nearest value; a voluntary reset lifts it on its slots, for
   * every fixture sharing them.
   */
  private mask(buffers: Uint8Array[], rules: Rule[]): Clamp[] {
    const clamps: Clamp[] = [];
    if (!rules.length) return clamps;
    const now = this.now();
    const zoneById = this.zoneLookup();
    const ordinary = rules.filter((x) => x.id !== RESET_RULE_ID);
    const protect = ordinary.length !== rules.length;
    const lifted = protect ? this.resetSlots(now) : new Map<number, Map<number, number>>();
    // not the absent fixtures: their channel layout would bound an installed fixture sharing their addresses
    const fixtures = this.venue.installed().flatMap((f) => {
      const r = this.venue.resolve(f.id);
      const buf = buffers[f.universe - 1];
      return "error" in r || !buf ? [] : [{ f, r, buf }];
    });
    for (const { r, buf } of fixtures) clamps.push(...applyRules(ordinary, r, buf, zoneById), ...applyHolds(ordinary, r, buf, now, this.holdSince, zoneById));
    // after every ordinary rule of every fixture: one sharing the slot may write it after this one's turn
    if (protect) for (const { f, r, buf } of fixtures) clamps.push(...holdAtRest(r, buf, this.atRest, (index) => lifted.get(f.universe)?.has(index) ?? false));
    return clamps;
  }
}

/** What the type grouping proposal reads of a group. */
const existingGroup = (g: Group): ExistingGroup => ({ id: g.id, name: g.name, fixtures: g.members.fixtures, groups: g.members.groups, ...(g.selector ? { selector: g.selector } : {}) });

/**
 * Level of a group's DCA: its master level (1 without a master) within its limits — clamped, or
 * the whole travel scaled onto min..max. Mute gives 0; a flash gives the max, never beyond. Pure.
 */
export function dcaLevel(g: Pick<Group, "master" | "limits">, flash = false): number {
  const min = g.limits?.min ?? 0;
  const max = g.limits?.max ?? 1;
  if (flash) return max;
  if (g.master?.mute) return 0;
  const level = g.master?.level ?? 1;
  if (g.limits?.mode === "scale") return min + level * (max - min);
  return Math.min(max, Math.max(min, level));
}
