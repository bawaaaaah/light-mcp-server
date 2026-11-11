/**
 * Show runtime: the playing state of a show on a venue, rendered into DMX on every engine frame.
 *
 * Pipeline (docs/architecture.md): active looks → canvas colours (scaled by the masters of the
 * groups that include them, skipping fixtures of groups that exclude them) → intensity per fixture
 * = product of the masters of every group chain containing it × grand master → venue.toDmx.
 */
import type { Collection, FolderStore } from "../data/store.js";
import { Glide } from "../engine/glide.js";
import { LookPlayer, ease } from "../engine/player.js";
import { generateSteps, OFF, scaleColor, type Step, type Technique } from "../engine/techniques.js";
import { movePosition, type Position } from "../engine/move.js";
import { aimAt } from "../venue/aim.js";
import type { FixtureChannel } from "../venue/qxf-import.js";
import { addWeighted, aimSetupOf, emptyFrame, mergeColors, settle, splitByShown, weighted, type AttributeFrame, type Canvas, type RawWrite, type Venue, type WeightedColors, type WheelChoice } from "../venue/venue.js";
import { slotHex } from "../venue/color-wheel.js";
import { applyHolds, applyRules, applySpeeds, applySteady, RuleProgramSchema, RuleSchema, rulesInForce, type Clamp, type Rule, type RuleProgram } from "../rules/rules.js";
import { holdAtRest, isBuiltinRule, RESET_RULE_ID, RESET_WINDOW_MS, resetChannels, resetProtectionRule, type ResetChannel } from "../rules/reset-protection.js";
import { affectedGroups, proposeTypeGrouping, type ExistingGroup, type TypeGrouping } from "../venue/grouping.js";
import { beamCrosses, ZoneSchema, zoneOf, type Zone } from "../venue/stage.js";
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
  state(): { beats: number };
}

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
}

/** A look leaving through a crossfade: its weight goes from `start` to 0 over `dur` seconds from `t`. */
interface Leaving {
  look: Look;
  player: LookPlayer;
  start: number;
  t: number;
  dur: number;
  rev: number;
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
}

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
  intensity?: {
    grandMaster: number;
    grandMasterSent: number;
    dcas: { id: string; name: string; own: number; effective: number }[];
    factor: number;
  };
  faders: { id: string; name: string; level: number; sent: number; dca: string | undefined; effective: number }[];
  /** Looks writing the channel as a raw channel; `leaving` for one fading out (an exit fade, or under a crossfade): it still counts. */
  rawLooks: { id: string; name: string; leaving?: true }[];
  /** `name`: the rule's, when it is still in force (the built-in Reset protection's among them). */
  clamps: (Pick<Clamp, "rule" | "from" | "to"> & { name?: string })[];
  /** The fixture has Reset channels, held at rest by the built-in rule: `fixture.reset` resets it on purpose. */
  resettable?: true;
  /**
   * A colour channel: the looks whose canvas reaches its head (or the whole fixture, or, for a halo that follows, a
   * full head), in the order they compose. `leaving` for one fading out (an exit fade, or under a crossfade); `covered`
   * for a playing look a later playing look covers there (`looksMerge: "last"`): its colour does not show.
   */
  paintingLooks?: { id: string; name: string; leaving?: true; covered?: true }[];
  /** The colour wheel of a lamp-only fixture: the slot it holds (its real colour) and, while a look asks a colour of it, that colour and the gap between them (OKLab, 0 = the same). */
  wheel?: { slot: string; color: string; asked?: string; gap: number };
  /** Its Reset channels (the range a voluntary reset sends), and the seconds left while one runs. */
  reset?: { channels: ResetChannel[]; secondsLeft?: number };
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
  /** Looks stopped with an exit fade, still fading to black (not active). */
  private readonly releasing = new Map<string, ReleasingLook>();
  /** Looks coming in over the ones they replaced (by incoming look id); the leaving ones are not active. */
  private readonly crossfades = new Map<string, Crossfade>();
  /** palette id → number of edits: a queued look whose palette was edited has a stale player. */
  private readonly paletteRevs = new Map<string, number>();
  private orphans = 0;
  /** group id → flash held */
  private readonly flashes = new Set<string>();
  /** Manual positions (XY pad, aiming): override the looks' moves until released. */
  private readonly manualPositions = new Map<string, Position>();
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
    this.active.set(lookId, { look, player });
    if (crossfade) this.beginCrossfade(look, leaving, now, from);
    else fadeOut();
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
      this.startFadeOut(a.look, a.player, now);
      return;
    }
    this.crossfades.delete(a.look.id);
    const outgoing = [...crossfade.outgoing];
    if (a.look.timing.exitFade > 0) outgoing.push({ look: a.look, player: a.player, start: this.inWeight(crossfade, now), t: now, dur: a.look.timing.exitFade, rev: this.lookRev(a.look) });
    if (outgoing.length) this.crossfades.set(this.orphanKey(), { t0: now, tIn: 0, from: 0, outgoing });
  }

  private orphanKey(): string {
    return `\0${++this.orphans}`;
  }

  /** The incoming look of a crossfade is gone: what was leaving under it goes on leaving. */
  private orphan(lookId: string): void {
    const crossfade = this.crossfades.get(lookId);
    if (!crossfade) return;
    this.crossfades.delete(lookId);
    if (crossfade.outgoing.length) this.crossfades.set(this.orphanKey(), crossfade);
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
   * under it keeps going, from the weight it has now.
   */
  private beginCrossfade(look: Look, leaving: ActiveLook[], now: number, from: number): void {
    const outgoing: Leaving[] = [];
    for (const l of leaving) {
      const was = this.crossfades.get(l.look.id);
      if (was) {
        this.crossfades.delete(l.look.id);
        for (const o of was.outgoing) outgoing.push({ ...o, start: this.outWeight(o, now), t: now, dur: Math.max(0.05, o.dur - (now - o.t) / 1000) });
      }
      const exit = l.look.timing.exitFade;
      outgoing.push({ look: l.look, player: l.player, start: was ? this.inWeight(was, now) : 1, t: now, dur: exit > 0 ? exit : look.timing.entryFade, rev: this.lookRev(l.look) });
    }
    this.crossfades.set(look.id, { t0: now, tIn: look.timing.entryFade, from: Math.min(1, Math.max(0, from)), outgoing });
  }

  /**
   * A look that starts again (its queues read first by `go`, to resume from: this only lets them go) or is
   * deleted (its queue must fall) no longer leaves under another one.
   */
  private leaveCrossfades(lookId: string): void {
    for (const c of this.crossfades.values()) c.outgoing = c.outgoing.filter((o) => o.look.id !== lookId);
  }

  /** Moves a stopped look into the `releasing` fade-out, when its exitFade > 0. */
  private startFadeOut(look: Look, player: LookPlayer, stopTime = this.now()): void {
    const exitFade = look.timing?.exitFade ?? 0;
    if (exitFade <= 0) return;
    // Drop any earlier fading copy of the same look.
    this.releasing.delete(look.id);
    this.releasing.set(look.id, { look, player, stopTime, exitFade, rev: this.lookRev(look) });
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
    return ids;
  }

  /** Forgets everything live (looks, flashes, manual positions, program): another show opens. */
  resetLive(): void {
    this.active.clear();
    this.releasing.clear();
    this.crossfades.clear();
    this.playbackStarted.clear();
    this.flashes.clear();
    this.manualPositions.clear();
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

  /** Effective factor of a group: its own level × its parents' (DCA-like cascade). */
  effectiveLevel(groupId: string, seen = new Set<string>()): number {
    const g = this.groups.get(groupId);
    if (!g || seen.has(groupId)) return 1;
    seen.add(groupId);
    let level = this.ownLevel(g);
    for (const parent of this.groups.list()) if (parent.members.groups.includes(groupId)) level *= this.effectiveLevel(parent.id, seen);
    return level;
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
    const dcas = this.groups
      .list()
      .filter((g) => (g.master || this.flashes.has(g.id)) && (g.members.fixtures.includes(fixture.id) || (g.selector && this.fixturesOf(g.id).has(fixture.id) && !g.members.groups.length)))
      .map((g) => ({ id: g.id, name: g.name, own: this.ownLevel(g), effective: this.effectiveLevel(g.id) }));
    const faders = this.faders
      .list()
      .filter((f) => f.channels.some((c) => c.fixture === fixture.id && c.offset === offset))
      .map((f) => ({ id: f.id, name: f.name, level: f.level, sent: this.faderLevel(f), dca: f.dca, effective: this.faderLevel(f) * (f.dca && this.groups.get(f.dca) ? this.effectiveLevel(f.dca) : 1) }));
    const writes = (look: Look) => look.channels?.targets.some((t) => t.fixture === fixture.id && t.offset === offset) ?? false;
    const leaving = [...this.releasing.values(), ...[...this.crossfades.values()].flatMap((x) => x.outgoing)].map(({ look }) => look);
    const rawLooks = [
      ...[...this.active.values()].filter(({ look }) => writes(look)).map(({ look }) => ({ id: look.id, name: look.name })),
      ...leaving.filter((look) => writes(look) && !this.active.has(look.id)).map((look) => ({ id: look.id, name: look.name, leaving: true as const })),
    ].filter((l, i, all) => all.findIndex((x) => x.id === l.id) === i);
    const ruleNames = new Map(this.rulesInForce().map((x) => [x.id, x.name]));
    const clamps = this.lastClamps.filter((c) => c.fixture === fixture.id && c.channel === name).map(({ rule, from, to }) => ({ rule, from, to, ...(ruleNames.get(rule) ? { name: ruleNames.get(rule)! } : {}) }));
    // a lamp's colour wheel: the slot held, its real colour, and how far it is from the colour asked
    const held = !("error" in r) && r.lampOnly && r.wheel?.offset === offset ? this.wheels.get(fixture.id) : undefined;
    const slot = held && !("error" in r) ? r.wheel?.slots.find((s) => s.min === held.slot) : undefined;
    const wheel = held && slot ? { slot: slot.name, color: slotHex(slot), ...(held.asked ? { asked: held.asked } : {}), gap: held.gap } : undefined;
    // the looks painting this colour channel's head (or the whole fixture) at their current step, read only when asked;
    // on a lamp's wheel, those lighting its body (a halo alone turns no wheel)
    const onWheel = !("error" in r) && r.lampOnly && r.wheel?.offset === offset;
    const isColour = onWheel || (!("error" in r) && [...r.heads.values()].some((c) => Object.values(c).includes(offset)));
    const paintsHere = (heads: Set<number>): boolean => (onWheel ? this.venue.lightsBody(fixture.id, heads) : heads.has(-1) || (head !== undefined && heads.has(head.head)));
    const painting = isColour ? this.paintingLooks(fixture.id, paintsHere) : [];
    return {
      ...(painting.length ? { paintingLooks: painting } : {}),
      ...(wheel ? { wheel } : {}),
      fixture: { id: fixture.id, name: fixture.name, offset: offset + 1, channel: name, attribute, definition: !("error" in r), ...(head ? { head: head.head, ...(head.accent ? { accent: true as const } : {}) } : {}) },
      intensity: { grandMaster: this.settings.grandMaster, grandMasterSent: this.grandMasterLevel(), dcas, factor: this.intensityOf(fixture.id) },
      faders,
      rawLooks,
      clamps,
      ...(!("error" in r) && resetChannels(r).length
        ? { resettable: true as const, reset: { channels: resetChannels(r), ...(this.resetting(fixture.id) ? { secondsLeft: Math.ceil((this.resets.get(fixture.id)! - this.now()) / 1000) } : {}) } }
        : {}),
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

  /** Intensity per fixture: product over the groups directly holding it × grand master. */
  intensityOf(fixtureId: string): number {
    let level = this.grandMasterLevel();
    for (const g of this.groups.list()) {
      if (!g.master && !this.flashes.has(g.id)) continue;
      const direct = g.members.fixtures.includes(fixtureId) || (g.selector && this.fixturesOf(g.id).has(fixtureId) && !g.members.groups.length);
      if (direct) level *= this.effectiveLevel(g.id);
    }
    return level;
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

  /** Moving heads of the venue (fixtures with pan or tilt), in patch order. */
  movingHeads(): string[] {
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

  /** Sets a manual position (normalised pan/tilt) on fixtures; it wins over the looks until released. */
  setPosition(fixtures: string[], p: Partial<Position>): void {
    for (const f of fixtures) {
      const cur = this.manualPositions.get(f) ?? { pan: 0.5, tilt: 0.5 };
      this.manualPositions.set(f, { pan: p.pan ?? cur.pan, tilt: p.tilt ?? cur.tilt });
    }
  }

  /** Releases manual positions (all when no fixture is given); returns the released fixtures. */
  releasePositions(fixtures?: string[]): string[] {
    const ids = fixtures ?? [...this.manualPositions.keys()];
    return ids.filter((f) => this.manualPositions.delete(f));
  }

  manualPosition(fixture: string): Position | undefined {
    return this.manualPositions.get(fixture);
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
    const errors = this.compose(buffers, this.now(), this.tempo.state().beats, this.wheels);
    // Rules mask: last stage of the show's output.
    this.lastClamps = this.mask(buffers, this.rulesInForce());
    this.lastErrors = errors;
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
    const sample = (): Set<string> => {
      const seen = new Set<string>();
      const wheels = new Map(this.wheels); // played in memory: the wheels held on the output stay as they are
      for (let k = 0; k < 20; k++) {
        const buffers = Array.from({ length: universes }, () => new Uint8Array(512));
        this.compose(buffers, t0 + k * 200, b0 + (k * 0.2 * (bpm ?? 120)) / 60, wheels);
        for (const f of this.venue.installed()) {
          const r = this.venue.resolve(f.id);
          const buf = buffers[f.universe - 1];
          if ("error" in r || !buf) continue;
          for (const c of applyRules(strict, r, buf, zoneById)) seen.add(JSON.stringify([c.rule, c.fixture, c.channel]));
        }
      }
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
    try {
      without = sample();
      const player = this.build(look);
      player.start(t0, b0);
      this.active.set(lookId, { look, player });
      withIt = sample();
    } finally {
      this.active.delete(lookId);
      if (fadingCopy) this.releasing.set(lookId, fadingCopy);
      for (const [key, c] of crossfadesAside) this.crossfades.set(key, c);
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
  private compose(buffers: Uint8Array[], now: number, beats: number, wheels: Map<string, WheelChoice>): string[] {
    const frame = emptyFrame();
    const errors: string[] = [];
    // Fades that ended in real time go (not at a sampled future instant: strictBounds() must change nothing).
    const real = this.now();
    for (const [id, r] of this.releasing) if ((real - r.stopTime) / 1000 >= r.exitFade) this.releasing.delete(id);
    for (const [id, c] of this.crossfades) if (real >= Math.max(c.t0 + c.tIn * 1000, ...c.outgoing.map((o) => o.t + o.dur * 1000))) this.crossfades.delete(id);
    /**
     * Raw channels of the looks, by fixture then offset: every look's write with its weight and its sheet — a
     * crossfade and the looks it replaces share one (`x:<incoming>`), any other look has its own — so that
     * venue.toDmx shares a channel inside a sheet and keeps the highest sheet (rawOver).
     */
    const lookChannels = new Map<string, Map<number, RawWrite[]>>();
    const rawOf = (look: Look, player: LookPlayer, weight: number, sheet: string): void => {
      if (!look.channels) return;
      const row = look.channels.steps[player.rawStep(now, beats, look.channels.steps.length)] ?? [];
      look.channels.targets.forEach((t, k) => {
        const byOffset = lookChannels.get(t.fixture) ?? new Map<number, RawWrite[]>();
        byOffset.set(t.offset, [...(byOffset.get(t.offset) ?? []), { value: row[k] ?? 0, weight, look: look.id, sheet }]);
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
    /** A look's colours on its own sheet, scaled by `fade` and the masters of its groups, its exclusions taken out. */
    const colorsOf = (look: Look, player: LookPlayer, fade: number): AttributeFrame["colors"] => {
      let step: Step = player.render(now, beats);
      let lookLevel = fade;
      for (const g of this.groups.list()) if (g.presets.included.includes(look.id)) lookLevel *= this.effectiveLevel(g.id);
      const excluded = this.excludedFrom(look);
      if (lookLevel < 1) step = step.map((c) => (c ? scaleColor(c, lookLevel) : c));
      const own = emptyFrame();
      try {
        this.venue.paintCanvas(own, look.canvas, step);
      } catch (err) {
        errors.push((err as Error).message);
      }
      for (const f of excluded) own.colors.delete(f);
      // the halo as this look shows it, before any merge or fade: it then fades and merges like any head
      this.venue.followAccents(own.colors);
      if (lookLevel >= 1) full1.add(own.colors);
      return own.colors;
    };
    const moveOf = (look: Look, player: LookPlayer): void => {
      if (!look.move) return;
      try {
        const moved = this.movedBy(look);
        const cycles = player.position(now, beats, look.move.every);
        moved.forEach((f, i) => frame.positions.set(f, movePosition(look.move!, cycles, i, moved.length)));
      } catch (err) {
        errors.push((err as Error).message);
      }
    };
    // Each look on its own sheet, then onto the others (show setting looksMerge), in this order so that a look just
    // started (or still playing) wins over the one leaving, in colours and in movement; their weight rides into the
    // looks' raw channels the same way. First the looks fading out on exit.
    for (const [id, r] of this.releasing) {
      const t = Math.min(1, Math.max(0, (now - r.stopTime) / 1000) / r.exitFade);
      if (t >= 1) continue;
      // the exit fade composes with an entry still running (a look stopped mid-rise), like the colours read it
      const w = (1 - ease(t)) * r.player.entryWeight(now);
      mergeColors(frame.colors, paints(colorsOf(r.look, r.player, 1 - ease(t)), w, r.look, r.player, `exit:${id}`), this.settings.looksMerge);
      rawOf(r.look, r.player, w, `exit:${id}`);
      moveOf(r.look, r.player);
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
        leaving = addWeighted(leaving, weighted(paints(colorsOf(o.look, o.player, w), w * o.player.entryWeight(now), o.look, o.player, `x:${key}`), w));
        rawOf(o.look, o.player, w * o.player.entryWeight(now), `x:${key}`);
        moveOf(o.look, o.player);
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
      rawOf(look, player, w, x ? `x:${look.id}` : `look:${look.id}`);
      const colors = x ? settle(addWeighted(shared.get(x)!, weighted(paints(ownOf.get(x)!, w, look, player, `x:${look.id}`), inW))) : paints(colorsOf(look, player, 1), w, look, player, `look:${look.id}`);
      mergeColors(frame.colors, colors, this.settings.looksMerge);
      moveOf(look, player);
    }
    for (const [f, p] of this.manualPositions) frame.positions.set(f, p);
    for (const f of this.venue.fixtures.list()) frame.intensity.set(f.id, this.intensityOf(f.id));
    // The looks' raw channels, collected above with their weight: the venue's pass classifies and
    // emits them, by address even without a definition.
    frame.raw = lookChannels;
    errors.push(...this.venue.toDmx(frame, buffers, wheels, { now, merge: this.settings.looksMerge }));
    // Channel faders: highest takes precedence with the show, like QLC+ level sliders — except on the
    // master dimmer of a colour fixture, which the show holds at full (the DCAs dose it, docs/specs/
    // groups-masters.md): there the fader doses it too (at 0 the fixture is dark), several faders on
    // one dimmer by the highest. A lamp's dimmer (a dimmer pack) is its light: the fader raises it.
    const doses = new Map<Uint8Array, Map<number, number>>();
    for (const fader of this.faders.list()) {
      // its travel covers its range (a QLC+ slider limited to 0..200 never goes past 200), the DCA doses that
      const { min, max } = fader.range ?? { min: 0, max: 255 };
      const level = ((min + this.faderLevel(fader) * (max - min)) / 255) * (fader.dca && this.groups.get(fader.dca) ? this.effectiveLevel(fader.dca) : 1);
      const value = Math.round(level * 255);
      for (const c of fader.channels) {
        const f = this.venue.fixtures.get(c.fixture);
        const buf = f && buffers[f.universe - 1];
        const index = f ? f.address - 1 + c.offset : -1;
        if (!buf || index < 0 || index >= 512 || this.venue.absent.has(c.fixture)) continue;
        if (this.dosesDimmer(c.fixture, c.offset)) {
          const dosed = doses.get(buf) ?? new Map<number, number>();
          doses.set(buf, dosed.set(index, Math.max(dosed.get(index) ?? 0, level)));
        } else if (buf[index]! < value) buf[index] = value;
      }
    }
    for (const [buf, dosed] of doses) for (const [index, level] of dosed) buf[index] = Math.round(buf[index]! * level);
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
