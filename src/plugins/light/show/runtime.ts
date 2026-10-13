/**
 * Show runtime: the playing state of a show on a venue, rendered into DMX on every engine frame.
 *
 * Pipeline (docs/architecture.md): active looks → canvas colours (scaled by the masters of the
 * groups that include them, skipping fixtures of groups that exclude them) → intensity per fixture
 * = product of the masters of every group chain containing it × grand master → venue.toDmx.
 */
import type { Collection, FolderStore } from "../data/store.js";
import { LookPlayer } from "../engine/player.js";
import { generateSteps, scaleColor, type Step, type Technique } from "../engine/techniques.js";
import { emptyFrame, type Venue } from "../venue/venue.js";
import { GroupSchema, LookSchema, PaletteSchema, ShowSettingsSchema, type Group, type Look, type Palette, type ShowSettings } from "./model.js";

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
  settings: ShowSettings;
  private readonly active = new Map<string, ActiveLook>();
  /** group id → flash held */
  private readonly flashes = new Set<string>();
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
    this.settings = store.readManifest("show.json", ShowSettingsSchema, ShowSettingsSchema.parse({}));
    store.onChange((e) => {
      // A look or palette edited while playing restarts with the new definition (effects stay editable live).
      if (e.collection === "looks" && this.active.has(e.id)) this.restart(e.id);
      if (e.collection === "palettes") for (const a of [...this.active.values()]) if (a.look.palette === e.id) this.restart(a.look.id);
    });
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
        return { ...t, colors: cols.length >= (t.kind === "palette" ? 3 : 1) ? cols : t.colors } as Technique;
      case "orage":
        return { ...t, base: cols[0]!, flash: cols[1] ?? t.flash };
      default:
        return t;
    }
  }

  private build(look: Look): LookPlayer {
    const canvas = this.venue.canvases.get(look.canvas);
    if (!canvas) throw new Error(`canevas inconnu : ${look.canvas}`);
    const steps = generateSteps(this.resolvedTechnique(look), canvas.cells, canvas.topology === "line-mirror");
    return new LookPlayer(steps, look.timing, seedOf(look.id));
  }

  isActive(lookId: string): boolean {
    return this.active.has(lookId);
  }

  activeLooks(): string[] {
    return [...this.active.keys()];
  }

  /** Starts a look; releases the other looks of its exclusive groups. Idempotent (« Déclencher »). */
  go(lookId: string): { started: boolean; released: string[] } {
    const look = this.looks.get(lookId);
    if (!look) throw new Error(`look inconnu : ${lookId}`);
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

  /** A group's own factor: master level (flash = 1, mute = 0), capped by its limit. */
  private ownLevel(g: Group): number {
    if (this.flashes.has(g.id)) return 1;
    const m = g.master;
    if (!m) return 1;
    const level = m.mute ? 0 : m.level;
    return Math.min(level, g.limits?.max ?? 1);
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

  /** Renders the playing looks into DMX buffers. */
  render(buffers: Uint8Array[]): void {
    const now = this.now();
    const beats = this.tempo.state().beats;
    const frame = emptyFrame();
    const errors: string[] = [];
    for (const { look, player } of this.active.values()) {
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
    }
    for (const f of this.venue.fixtures.list()) frame.intensity.set(f.id, this.intensityOf(f.id));
    errors.push(...this.venue.toDmx(frame, buffers));
    this.lastErrors = errors;
  }
}
