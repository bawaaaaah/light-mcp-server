/**
 * Show runtime: the playing state of a show on a venue, rendered into DMX on every engine frame.
 *
 * Pipeline (docs/architecture.md): active looks → canvas colours (scaled by the masters of the
 * groups that include them, skipping fixtures of groups that exclude them) → intensity per fixture
 * = product of the masters of every group chain containing it × grand master → venue.toDmx.
 */
import type { Collection, FolderStore } from "../data/store.js";
import { LookPlayer } from "../engine/player.js";
import { generateSteps, OFF, scaleColor, type Step, type Technique } from "../engine/techniques.js";
import { movePosition, type Position } from "../engine/move.js";
import { aimAt } from "../venue/aim.js";
import { aimSetupOf, emptyFrame, type Venue } from "../venue/venue.js";
import { applyHolds, applyRules, applySpeeds, applySteady, RuleProgramSchema, RuleSchema, rulesInForce, type Clamp, type Rule, type RuleProgram } from "../rules/rules.js";
import { beamCrosses, ZoneSchema, zoneOf, type Zone } from "../venue/stage.js";
import { ChannelFaderSchema, GroupSchema, LookSchema, PaletteSchema, ShowSettingsSchema, SnapshotSchema, type ChannelFader, type Group, type Look, type Palette, type ShowSettings, type Snapshot } from "./model.js";
import { say } from "../../../core/lang.js";

/** How long a Panic stays undoable. */
export const PANIC_UNDO_MS = 60_000;

export interface TempoSource {
  state(): { beats: number };
}

interface ActiveLook {
  look: Look;
  player: LookPlayer;
}

/** Stable small seed from a string, so a random-order look plays the same way every time. */
function seedOf(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
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
  private readonly active = new Map<string, ActiveLook>();
  /** group id → flash held */
  private readonly flashes = new Set<string>();
  /** Manual positions (XY pad, aiming): override the looks' moves until released. */
  private readonly manualPositions = new Map<string, Position>();
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
    store.onChange((e) => {
      // A look or palette edited while playing restarts with the new definition (effects stay editable live).
      if (e.collection === "looks" && this.active.has(e.id)) this.restart(e.id);
      if (e.collection === "palettes") for (const a of [...this.active.values()]) if (a.look.palette === e.id) this.restart(a.look.id);
    });
  }

  reloadSettings(): void {
    this.settings = this.store.readManifest("show.json", ShowSettingsSchema, ShowSettingsSchema.parse({}));
  }

  saveSettings(patch: Partial<ShowSettings>): ShowSettings {
    this.settings = ShowSettingsSchema.parse({ ...this.settings, ...patch });
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

  /** The steps a look plays on its canvas (palette and mirror applied). */
  stepsOf(look: Look): Step[] {
    const canvas = this.venue.canvases.get(look.canvas);
    if (!canvas) throw new Error(say(`canevas inconnu : ${look.canvas}`, `unknown canvas: ${look.canvas}`));
    return generateSteps(this.resolvedTechnique(look), canvas.cells, look.mirror ?? canvas.topology === "line-mirror");
  }

  private build(look: Look): LookPlayer {
    const steps = this.stepsOf(look);
    // entry fade (« pas 0 d'entrée », a QLC+ scene's fade in): from black on the cells the look paints
    const entry = look.timing.entryFade > 0 ? steps[0]!.map((c) => (c ? OFF : null)) : null;
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
      if (this.looks.get(id)) this.go(id);
      else skipped.push(id);
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
    for (const g of this.groups.list()) {
      if (!g.exclusive || !g.members.looks.includes(lookId)) continue;
      for (const other of g.members.looks) if (other !== lookId && this.active.delete(other)) released.push(other);
    }
    if (this.active.has(lookId)) return { started: false, released };
    const player = this.build(look);
    player.start(this.now(), this.tempo.state().beats);
    this.active.set(lookId, { look, player });
    return { started: true, released };
  }

  stop(lookId: string): boolean {
    return this.active.delete(lookId);
  }

  stopAll(): string[] {
    const ids = [...this.active.keys()];
    this.active.clear();
    return ids;
  }

  /** Forgets everything live (looks, flashes, manual positions, program): another show opens. */
  resetLive(): void {
    this.active.clear();
    this.playbackStarted.clear();
    this.flashes.clear();
    this.manualPositions.clear();
    this.activeProgram = undefined;
  }

  private restart(lookId: string): void {
    const look = this.looks.get(lookId);
    this.active.delete(lookId);
    if (look) {
      try {
        const player = this.build(look);
        player.start(this.now(), this.tempo.state().beats);
        this.active.set(lookId, { look, player });
      } catch (err) {
        this.lastErrors = [(err as Error).message];
      }
    }
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
    return dcaLevel(g, this.flashes.has(g.id));
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
  explainChannel(universe: number, channel: number) {
    const fixture = this.venue.fixtures.list().find((f) => {
      if (f.universe !== universe || channel < f.address) return false;
      const r = this.venue.resolve(f.id);
      return channel < f.address + ("error" in r ? 1 : r.mode.channels.length);
    });
    if (!fixture) return { fixture: undefined, faders: [], rawLooks: [], clamps: [] };
    const offset = channel - fixture.address;
    const r = this.venue.resolve(fixture.id);
    const name = "error" in r ? undefined : r.mode.channels[offset];
    const attribute = name && !("error" in r) ? r.def.channels.get(name)?.attribute : undefined;
    const dcas = this.groups
      .list()
      .filter((g) => (g.master || this.flashes.has(g.id)) && (g.members.fixtures.includes(fixture.id) || (g.selector && this.fixturesOf(g.id).has(fixture.id) && !g.members.groups.length)))
      .map((g) => ({ id: g.id, name: g.name, own: this.ownLevel(g), effective: this.effectiveLevel(g.id) }));
    const faders = this.faders
      .list()
      .filter((f) => f.channels.some((c) => c.fixture === fixture.id && c.offset === offset))
      .map((f) => ({ id: f.id, name: f.name, level: f.level, dca: f.dca, effective: f.level * (f.dca && this.groups.get(f.dca) ? this.effectiveLevel(f.dca) : 1) }));
    const rawLooks = [...this.active.values()].filter(({ look }) => look.channels?.targets.some((t) => t.fixture === fixture.id && t.offset === offset)).map(({ look }) => ({ id: look.id, name: look.name }));
    const clamps = this.lastClamps.filter((c) => c.fixture === fixture.id && c.channel === name).map(({ rule, from, to }) => ({ rule, from, to }));
    return {
      fixture: { id: fixture.id, name: fixture.name, offset: offset + 1, channel: name, attribute, definition: !("error" in r) },
      intensity: { grandMaster: this.settings.grandMaster, dcas, factor: this.intensityOf(fixture.id) },
      faders,
      rawLooks,
      clamps,
    };
  }

  /** Intensity per fixture: product over the groups directly holding it × grand master. */
  intensityOf(fixtureId: string): number {
    let level = this.settings.grandMaster;
    for (const g of this.groups.list()) {
      if (!g.master && !this.flashes.has(g.id)) continue;
      const direct = g.members.fixtures.includes(fixtureId) || (g.selector && this.fixturesOf(g.id).has(fixtureId) && !g.members.groups.length);
      if (direct) level *= this.effectiveLevel(g.id);
    }
    return level;
  }

  /** Venue and show rules in force now (the active program's included). */
  /** The rules bounding the output now: those of no program or of the active one; not those for some callers only. */
  rulesInForce(program = this.activeProgram): Rule[] {
    return rulesInForce([...this.venueRules.list(), ...this.rules.list()], program).filter((r) => !r.appliesTo);
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

  /** Moving heads of the venue (fixtures with pan or tilt), in patch order. */
  movingHeads(): string[] {
    return this.venue.fixtures.list().filter((f) => {
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
    const errors = this.compose(buffers, this.now(), this.tempo.state().beats);
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
      for (let k = 0; k < 20; k++) {
        const buffers = Array.from({ length: universes }, () => new Uint8Array(512));
        this.compose(buffers, t0 + k * 200, b0 + (k * 0.2 * (bpm ?? 120)) / 60);
        for (const f of this.venue.fixtures.list()) {
          const r = this.venue.resolve(f.id);
          const buf = buffers[f.universe - 1];
          if ("error" in r || !buf) continue;
          for (const c of applyRules(strict, r, buf, zoneById)) seen.add(JSON.stringify([c.rule, c.fixture, c.channel]));
        }
      }
      return seen;
    };
    const without = sample();
    const player = this.build(look);
    player.start(t0, b0);
    this.active.set(lookId, { look, player });
    let withIt: Set<string>;
    try {
      withIt = sample();
    } finally {
      this.active.delete(lookId);
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
  private compose(buffers: Uint8Array[], now: number, beats: number): string[] {
    const frame = emptyFrame();
    const errors: string[] = [];
    /** Raw channels of the looks, by fixture then offset (highest of the looks playing them). */
    const lookChannels = new Map<string, Map<number, number>>();
    for (const { look, player } of this.active.values()) {
      if (look.channels) {
        const row = look.channels.steps[player.rawStep(now, beats, look.channels.steps.length)] ?? [];
        look.channels.targets.forEach((t, k) => {
          const byOffset = lookChannels.get(t.fixture) ?? new Map<number, number>();
          byOffset.set(t.offset, Math.max(byOffset.get(t.offset) ?? 0, row[k] ?? 0));
          lookChannels.set(t.fixture, byOffset);
        });
      }
      let step: Step = player.render(now, beats);
      let lookLevel = 1;
      const excluded = new Set<string>();
      for (const g of this.groups.list()) {
        if (g.presets.included.includes(look.id)) lookLevel *= this.effectiveLevel(g.id);
        if (g.presets.excluded.includes(look.id)) for (const f of this.fixturesOf(g.id)) excluded.add(f);
      }
      if (lookLevel < 1) step = step.map((c) => (c ? scaleColor(c, lookLevel) : c));
      try {
        this.venue.paintCanvas(frame, look.canvas, step);
      } catch (err) {
        errors.push((err as Error).message);
      }
      for (const f of excluded) frame.colors.delete(f);
      if (look.move) {
        try {
          const moved = this.movedBy(look);
          const cycles = player.position(now, beats, look.move.every);
          moved.forEach((f, i) => frame.positions.set(f, movePosition(look.move!, cycles, i, moved.length)));
        } catch (err) {
          errors.push((err as Error).message);
        }
      }
    }
    for (const [f, p] of this.manualPositions) frame.positions.set(f, p);
    for (const f of this.venue.fixtures.list()) frame.intensity.set(f.id, this.intensityOf(f.id));
    errors.push(...this.venue.toDmx(frame, buffers));
    // Raw channels of the looks: they set their channels (by address, even without a definition).
    for (const [fixtureId, byOffset] of lookChannels) {
      const f = this.venue.fixtures.get(fixtureId);
      const buf = f && buffers[f.universe - 1];
      if (!f || !buf) continue;
      for (const [offset, value] of byOffset) {
        const index = f.address - 1 + offset;
        if (index >= 0 && index < 512) buf[index] = value;
      }
    }
    // Channel faders: highest takes precedence with the show, like QLC+ level sliders — except on the
    // master dimmer of a colour fixture, which the show holds at full (the DCAs dose it, docs/specs/
    // groups-masters.md): there the fader doses it too (at 0 the fixture is dark), several faders on
    // one dimmer by the highest. A lamp's dimmer (a dimmer pack) is its light: the fader raises it.
    const doses = new Map<Uint8Array, Map<number, number>>();
    for (const fader of this.faders.list()) {
      // its travel covers its range (a QLC+ slider limited to 0..200 never goes past 200), the DCA doses that
      const { min, max } = fader.range ?? { min: 0, max: 255 };
      const level = ((min + fader.level * (max - min)) / 255) * (fader.dca && this.groups.get(fader.dca) ? this.effectiveLevel(fader.dca) : 1);
      const value = Math.round(level * 255);
      for (const c of fader.channels) {
        const f = this.venue.fixtures.get(c.fixture);
        const buf = f && buffers[f.universe - 1];
        const index = f ? f.address - 1 + c.offset : -1;
        if (!buf || index < 0 || index >= 512) continue;
        if (this.isDimmer(c.fixture, c.offset)) {
          const dosed = doses.get(buf) ?? new Map<number, number>();
          doses.set(buf, dosed.set(index, Math.max(dosed.get(index) ?? 0, level)));
        } else if (buf[index]! < value) buf[index] = value;
      }
    }
    for (const [buf, dosed] of doses) for (const [index, level] of dosed) buf[index] = Math.round(buf[index]! * level);
    return errors;
  }

  /** The master dimmer of a colour fixture, which the show holds at full and the DCAs dose (not a lamp's). */
  private isDimmer(fixtureId: string, offset: number): boolean {
    const r = this.venue.resolve(fixtureId);
    return !("error" in r) && !r.lampOnly && r.dimmers.includes(offset);
  }

  /**
   * What holds over the whole output, after the DMX console's forced channels (docs/specs/rules-
   * limits.md): forcing a channel overrides the show and the ordinary rules, never a locked one —
   * the venue's hardware limits hold whoever writes the channel; and no moving head lights a zone
   * it may not point into (the lectern), whoever aimed it, while its beam crosses that zone.
   */
  guard(buffers: Uint8Array[]): void {
    const rules = this.rulesInForce();
    const locked = rules.filter((r) => r.locked);
    if (locked.length) this.lastClamps.push(...this.mask(buffers, locked));
    // motion and machines, once a frame and over everything (forced channels too): pan/tilt speed, steady channels
    if (rules.some((r) => r.maxDegPerSecond || r.steadySeconds)) {
      const now = this.now();
      const zoneById = this.zoneLookup();
      for (const f of this.venue.fixtures.list()) {
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
    for (const f of this.venue.fixtures.list()) {
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

  /** Applies rules to every fixture's channels in the buffers, durations included; what they bounded. */
  private mask(buffers: Uint8Array[], rules: Rule[]): Clamp[] {
    const clamps: Clamp[] = [];
    if (!rules.length) return clamps;
    const now = this.now();
    const zoneById = this.zoneLookup();
    for (const f of this.venue.fixtures.list()) {
      const r = this.venue.resolve(f.id);
      const buf = buffers[f.universe - 1];
      if ("error" in r || !buf) continue;
      clamps.push(...applyRules(rules, r, buf, zoneById), ...applyHolds(rules, r, buf, now, this.holdSince, zoneById));
    }
    return clamps;
  }
}

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
