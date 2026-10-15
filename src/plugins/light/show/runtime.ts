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
import { emptyFrame, type Venue } from "../venue/venue.js";
import { applyRules, RuleProgramSchema, RuleSchema, rulesInForce, type Clamp, type Rule, type RuleProgram } from "../rules/rules.js";
import { ZoneSchema, zoneOf, type Zone } from "../venue/stage.js";
import { ChannelFaderSchema, GroupSchema, LookSchema, PaletteSchema, ShowSettingsSchema, type ChannelFader, type Group, type Look, type Palette, type ShowSettings } from "./model.js";

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
    if (!palette) throw new Error(`palette inconnue : ${look.palette}`);
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
    if (!canvas) throw new Error(`canevas inconnu : ${look.canvas}`);
    return generateSteps(this.resolvedTechnique(look), canvas.cells, look.mirror ?? canvas.topology === "line-mirror");
  }

  private build(look: Look): LookPlayer {
    const steps = this.stepsOf(look);
    // entry fade (« pas 0 d'entrée », a QLC+ scene's fade in): from black on the cells the look paints
    const entry = look.timing.entryFade > 0 ? steps[0]!.map((c) => (c ? OFF : null)) : null;
    return new LookPlayer(steps, look.timing, seedOf(look.id), entry);
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
    if (!look) throw new Error(`look inconnu : ${lookId}`);
    if (auto && look.manualOnly) throw new Error(`« ${look.name} » est en manuel seulement`);
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
    if (!this.groups.get(groupId)) throw new Error(`groupe inconnu : ${groupId}`);
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
  rulesInForce(program = this.activeProgram): Rule[] {
    return rulesInForce([...this.venueRules.list(), ...this.rules.list()], program);
  }

  /** Activates a rule program (undefined = none); returns whether it changed. */
  selectProgram(id: string | undefined): boolean {
    if (id !== undefined && !this.programs.get(id)) throw new Error(`programme inconnu : ${id}`);
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
      if (!f || "error" in r) return { fixture: id, error: f ? (r as { error: string }).error : `fixture inconnue : ${id}` };
      if (!r.pan && !r.tilt) return { fixture: id, error: "pas de pan/tilt" };
      if (!f.position) return { fixture: id, error: "position sur la scène inconnue" };
      const o = f.orientation;
      const res = aimAt({ position: f.position, hung: f.mount === "hung" || f.mount === "truss" || f.mount === "ceiling", yaw: o?.yaw ?? 0, panMax: r.panMax, tiltMax: r.tiltMax, panOffset: o?.panOffset ?? 0, tiltOffset: o?.tiltOffset ?? 0 }, target);
      if ("error" in res) return { fixture: id, error: res.error };
      this.setPosition([id], res);
      return { fixture: id, pan: res.pan, tilt: res.tilt };
    });
  }

  /** Renders the playing looks into DMX buffers. */
  render(buffers: Uint8Array[]): void {
    const now = this.now();
    const beats = this.tempo.state().beats;
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
    // Channel faders: highest takes precedence with the show, like QLC+ level sliders.
    for (const fader of this.faders.list()) {
      const level = fader.level * (fader.dca && this.groups.get(fader.dca) ? this.effectiveLevel(fader.dca) : 1);
      if (level <= 0) continue;
      const value = Math.round(level * 255);
      for (const c of fader.channels) {
        const f = this.venue.fixtures.get(c.fixture);
        const buf = f && buffers[f.universe - 1];
        const index = f ? f.address - 1 + c.offset : -1;
        if (buf && index >= 0 && index < 512 && buf[index]! < value) buf[index] = value;
      }
    }
    // Rules mask: last stage of the show's output.
    const rules = this.rulesInForce();
    const clamps: Clamp[] = [];
    if (rules.length) {
      const zones = this.zones.list();
      const zoneById = (id: string) => {
        const f = this.venue.fixtures.get(id);
        return f ? zoneOf(f, zones)?.id : undefined;
      };
      for (const f of this.venue.fixtures.list()) {
        const r = this.venue.resolve(f.id);
        const buf = buffers[f.universe - 1];
        if ("error" in r || !buf) continue;
        clamps.push(...applyRules(rules, r, buf, zoneById));
      }
    }
    this.lastClamps = clamps;
    this.lastErrors = errors;
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
