/**
 * Fadeable tracks (T5, docs/specs/engine-effects-timing.md, « Pistes fondables »): on a fixture whose tracks are
 * enabled, the user says channel by channel which ones follow the transitions (entry, exit, crossfade) and which
 * ones jump. Pure: the venue resolves the names into offsets (`tracksOf`), the runtime hands every look touching
 * the fixture as one layer (`TrackLayer`: its values at full and its weight), and `composeTracks` lays them,
 * channel by channel, with no memory from one frame to the next.
 *
 * - A fading channel is composed from the layers' opacities: the dimmer from black; a colour, under a fading
 *   dimmer, at its weighted mean (the dimmer carries the fade, so a painted look alone is dosed once); any other
 *   channel (zoom, focus, a speed) glides from one value to the other and holds while a look leaves alone.
 * - A jumping channel takes the value of the dominant layer (`dominantLayer`), the colour wheel's rule (T18): the
 *   last sheet with « last », inside one sheet (a crossfade) the heaviest — so at mid-fade in a crossfade, at once
 *   on entry, at the very end on exit.
 * - The colour wheel of a lamp always follows `wheelFrame` (T18), never interpolated: its slots between would show.
 * - Pan and tilt are never written here (T25, the motion layer, glides the logical position): their offsets are no
 *   layer's and no key of the result; `motion` only declares, per axis, whether it glides or cuts.
 */
import type { ColorComponent, FixtureDefinition, FixtureMode } from "./qxf-import.js";
import type { TrackOverrides } from "./overrides.js";
import type { WheelFrame } from "./color-wheel.js";
import { rawOver, type Color, type CoarseFine, type LooksMerge } from "./venue.js";

/** What the engine reads of a fixture's enabled tracks: the offsets that fade (coarse and fine) and, per axis, what the motion layer does. */
export interface ResolvedTracks {
  fade: ReadonlySet<number>;
  /** Read by the motion layer (T25): « glide » for a ticked axis, « cut » for an unticked one. No effect before T25. */
  motion: { pan?: "glide" | "cut"; tilt?: "glide" | "cut" };
}

/**
 * A fixture's tracks from its merged overrides: undefined unless enabled (the engine as before). A channel is named
 * as in the definition; a fine channel follows its coarse one (the last channel before it of the same attribute and
 * colour); a name the mode does not have is ignored here (the command refuses it).
 */
export function tracksOf(def: FixtureDefinition, mode: FixtureMode, tracks: TrackOverrides | undefined): ResolvedTracks | undefined {
  if (!tracks?.enabled) return undefined;
  const names = new Set(tracks.fade ?? []);
  const fade = new Set<number>();
  const motion: ResolvedTracks["motion"] = {};
  const coarse = new Map<string, string>();
  mode.channels.forEach((name, offset) => {
    const ch = def.channels.get(name);
    const kind = `${ch?.attribute ?? "other"}:${ch?.color ?? ""}`;
    const own = ch?.fine ? coarse.get(kind) : name;
    if (!ch?.fine) coarse.set(kind, name);
    if (own !== undefined && names.has(own)) fade.add(offset);
    if (ch && !ch.fine && (ch.attribute === "pan" || ch.attribute === "tilt")) motion[ch.attribute] ??= names.has(name) ? "glide" : "cut";
  });
  return { fade, motion };
}

/** What a channel is to the tracks editor: the light (dimmer, colour), the position, the colour wheel, or anything else. */
export type TrackKind = "dimmer" | "colour" | "position" | "wheel" | "other";

/** The fields of a resolved fixture the tracks read (venue.ts ResolvedFixture satisfies it). */
export interface TrackFixture {
  def: FixtureDefinition;
  mode: FixtureMode;
  heads: ReadonlyMap<number, Partial<Record<ColorComponent, number>>>;
  accent: ReadonlySet<number>;
  follow: boolean;
  dimmers: readonly number[];
  pan?: CoarseFine | undefined;
  tilt?: CoarseFine | undefined;
  wheel?: { offset: number } | undefined;
  lampOnly: boolean;
  levelDimmer: boolean;
  shutterOpen: ReadonlyMap<number, number>;
}

/** The pan/tilt offsets (coarse and fine) of a moving head: never a layer's, never composed here. */
export function motionOffsets(r: Pick<TrackFixture, "pan" | "tilt">): Set<number> {
  const out = new Set<number>();
  for (const p of [r.pan, r.tilt]) {
    if (!p) continue;
    out.add(p.coarse);
    if (p.fine !== undefined) out.add(p.fine);
  }
  return out;
}

/**
 * The raw writes a fixture with tracks keeps verbatim, outside its layers: pan/tilt (the motion layer's) and offsets past
 * its mode (a neighbour's addresses: written as on any fixture, never composed here).
 */
export function verbatimOffsets(r: Pick<TrackFixture, "pan" | "tilt" | "mode">): (offset: number) => boolean {
  const motion = motionOffsets(r);
  const size = r.mode.channels.length;
  return (o) => motion.has(o) || o >= size;
}

/** The channels a user ticks, in the mode's order: fine channels left out (they follow their coarse one). */
export function trackChannels(r: TrackFixture): { offset: number; name: string; attribute: string; kind: TrackKind }[] {
  const motion = motionOffsets(r);
  const colours = new Set<number>();
  for (const comps of r.heads.values()) for (const off of Object.values(comps)) colours.add(off);
  return r.mode.channels.flatMap((name, offset) => {
    const ch = r.def.channels.get(name);
    if (ch?.fine) return [];
    const kind: TrackKind = motion.has(offset) ? "position" : r.dimmers.includes(offset) ? "dimmer" : colours.has(offset) ? "colour" : r.lampOnly && r.wheel?.offset === offset ? "wheel" : "other";
    return [{ offset, name, attribute: ch?.attribute ?? "other", kind }];
  });
}

/**
 * One look on a fixture with tracks: its values at full and its weight. `sheet` and `weight` are those of its raw
 * writes (show/runtime.ts rawOf: entry × crossfade × exit; a crossfade and the looks it replaces share a sheet).
 * `level`: what the groups including the look give it, per light offset (ShowRuntime.lookLevelOn, T35; missing = 1):
 * an intensity factor, never a fade. `colors`: what it paints there at full (head → colour, -1 the whole fixture),
 * not scaled by its fade. `raw`: its raw channels there (offset → DMX value), pan/tilt left out.
 */
export interface TrackLayer {
  look: string;
  sheet: string;
  weight: number;
  level?: ReadonlyMap<number, number>;
  colors?: ReadonlyMap<number, Color>;
  raw: ReadonlyMap<number, number>;
}

/** One layer's value on one channel, with what places it: its sheet, its weight and its paint order. */
interface Carried {
  sheet: string;
  weight: number;
  value: number;
  order: number;
}

/**
 * Sheets laid from `held` (docs/specs/engine-effects-timing.md, « Pistes fondables »). Inside a sheet the weights
 * add up (opacity min(1, Σw)) and the value is their weighted mean, as in a crossfade. Between sheets: « last »
 * lays each over the ones below in paint order (v = below × (1 − op) + v × op); « highest » keeps the highest value
 * weighed by its opacity (rawOver, the raw channels' own rule). `opacity` is the combined one, 1 − Π(1 − op).
 */
export function overSheets(carried: readonly Carried[], merge: LooksMerge, held: number): { value: number; opacity: number } {
  const sheets = new Map<string, { dosed: number; weight: number; order: number }>();
  for (const c of carried) {
    const w = Math.max(0, c.weight);
    const s = sheets.get(c.sheet) ?? { dosed: 0, weight: 0, order: c.order };
    s.dosed += c.value * w;
    s.weight += w;
    s.order = Math.max(s.order, c.order);
    sheets.set(c.sheet, s);
  }
  const layers = [...sheets.values()].filter((s) => s.weight > 0).sort((a, b) => a.order - b.order);
  const opacity = 1 - layers.reduce((clear, s) => clear * (1 - Math.min(1, s.weight)), 1);
  if (merge === "highest") return { value: rawOver(carried.map((c) => ({ value: c.value, weight: c.weight, look: "", sheet: c.sheet })), held), opacity };
  let value = held;
  for (const s of layers) {
    const op = Math.min(1, s.weight);
    value = value * (1 - op) + (s.dosed / s.weight) * op;
  }
  return { value, opacity };
}

/**
 * The layer whose value a jumping channel takes — the colour wheel's rule (T18 wheelFrame), so that one behaviour
 * explains both: with « last » only the latest sheet carrying the channel counts (a look started over another takes
 * its jumping channels at once); inside that sheet, or among all with « highest », the heaviest, the later one on
 * equal weights. So a crossfade switches at mid-fade, an entry at once, an exit at its very end. composeTracks adds, in the
 * sheets carrying the channel, the layers lighting the fixture without it, at the channel's rest value.
 */
export function dominantLayer<T extends { sheet: string; weight: number; order: number }>(carried: readonly T[], merge: LooksMerge): T | undefined {
  const last = carried.reduce<T | undefined>((x, y) => (!x || y.order >= x.order ? y : x), undefined);
  const counting = merge === "last" && last ? carried.filter((c) => c.sheet === last.sheet) : carried;
  return counting.reduce<T | undefined>((x, y) => (!x || Math.max(0, y.weight) >= Math.max(0, x.weight) ? y : x), undefined);
}

const levelOf = (c: Color): number => Math.max(0, ...Object.values(c).map((v) => v ?? 0));

/**
 * The DMX values of one fixture with enabled tracks (`tracks`), from the layers of the looks on it in paint order
 * (bottom → top). `intensity`: the grand master and the DCAs covering the fixture (frame.intensity), on its dimmer,
 * or on its colours when it has none. `wheel`: the frame of its colour wheel (a lamp), whose slot it writes and whose
 * « au noir » factor (`dim`) doses the dimmer. Never a key for a pan/tilt offset.
 */
export function composeTracks(r: TrackFixture, tracks: ResolvedTracks, layers: readonly TrackLayer[], opts: { merge: LooksMerge; intensity: number; wheel?: WheelFrame }): Map<number, number> {
  const out = new Map<number, number>();
  const motion = motionOffsets(r);
  const dimmers = r.dimmers.filter((d) => !motion.has(d));
  const hasDimmer = dimmers.length > 0;
  const colourOf = new Map<number, { head: number; comp: ColorComponent }>();
  for (const [head, comps] of r.heads) for (const [comp, off] of Object.entries(comps) as [ColorComponent, number][]) colourOf.set(off, { head, comp });
  const wheelOffset = r.lampOnly && r.wheel && opts.wheel ? r.wheel.offset : undefined;
  const size = r.mode.channels.length;
  // the offsets this path composes: in the fixture's mode, pan/tilt left out (toDmx writes the others verbatim)
  const own = (o: number) => o < size && !motion.has(o);
  const levelAt = (l: TrackLayer, o: number) => l.level?.get(o) ?? 1;
  // a layer lights the fixture when it paints it or writes a raw channel other than pan/tilt (a position alone lights nothing)
  const lits = new Map(layers.map((l) => [l, (l.colors?.size ?? 0) > 0 || [...l.raw.keys()].some(own)]));
  const lit = (l: TrackLayer) => lits.get(l) ?? false;
  /**
   * The groups' level of a look on a fixture with a dimmer (T35): the dimmer carries the highest of its light channels'
   * levels, each colour the rest of its own (its level / that highest, at most 1) — a channel fader linked to a group
   * that holds one colour doses that colour once, as on a fixture without tracks.
   */
  const lightOffsets = [...dimmers, ...colourOf.keys()];
  const topLevel = new Map(layers.map((l) => [l, l.level ? Math.max(0, ...lightOffsets.map((o) => levelAt(l, o))) : 1]));
  const bodyLevel = (l: TrackLayer): number | undefined => {
    const body = [...(l.colors ?? [])].filter(([h]) => !r.accent.has(h));
    if (!body.length) return undefined;
    const c = body.find(([h]) => h === -1)?.[1] ?? body[0]![1];
    return levelOf(c);
  };
  /** A layer's value on a channel at full, or undefined when it carries nothing there. */
  const valueOf = (l: TrackLayer, o: number): number | undefined => {
    const raw = l.raw.get(o);
    if (dimmers.includes(o)) {
      // the show holds a colour fixture's dimmer at full (« scènes sans intensité »): the layer lighting it brings it
      // up; a lamp's dimmer is its painted level
      let v = raw;
      if (v === undefined && lit(l)) {
        const body = r.levelDimmer ? bodyLevel(l) : 1;
        if (body !== undefined) v = body * 255;
      }
      return v === undefined ? undefined : v * (topLevel.get(l) ?? 1);
    }
    const colour = colourOf.get(o);
    if (colour) {
      let v = raw;
      if (v === undefined) {
        const c = l.colors?.get(colour.head) ?? (r.accent.has(colour.head) && !r.follow ? undefined : l.colors?.get(-1));
        if (c) v = (c[colour.comp] ?? 0) * 255;
      }
      if (v === undefined) return undefined;
      if (!hasDimmer) return v * levelAt(l, o);
      const top = topLevel.get(l) ?? 1;
      return top > 0 ? v * Math.min(1, levelAt(l, o) / top) : 0;
    }
    return raw;
  };
  const offsets = new Set<number>([...dimmers, ...colourOf.keys()]);
  for (const l of layers) for (const o of l.raw.keys()) if (own(o)) offsets.add(o);
  if (wheelOffset !== undefined) offsets.add(wheelOffset);
  const ordered = layers.map((l, order) => ({ l, order }));
  // the combined opacity of the layers lighting the fixture: what a colour under a fading dimmer is shared against
  const intensity = overSheets(ordered.filter(({ l }) => lit(l)).map(({ l, order }) => ({ sheet: l.sheet, weight: l.weight, value: 1, order })), opts.merge, 0).opacity;
  const dimmerFades = dimmers.some((d) => tracks.fade.has(d));
  for (const o of offsets) {
    const carried: Carried[] = ordered.flatMap(({ l, order }) => {
      const v = valueOf(l, o);
      return v === undefined ? [] : [{ sheet: l.sheet, weight: l.weight, value: v, order }];
    });
    const isDimmer = dimmers.includes(o);
    const isColour = colourOf.has(o);
    if (o === wheelOffset && !carried.length) {
      // the wheel follows T18, faded or not: never interpolated
      if (opts.wheel?.pick) out.set(o, opts.wheel.pick.value);
      continue;
    }
    if (!carried.length) {
      // at rest: a colour fixture's dimmer held at full (dark under black colours), a lamp's dark, a shutter open
      if (isDimmer) out.set(o, r.levelDimmer ? 0 : 255);
      else if (isColour) out.set(o, 0);
      else if (r.shutterOpen.has(o)) out.set(o, r.shutterOpen.get(o)!);
      continue;
    }
    if (!tracks.fade.has(o) || o === wheelOffset) {
      // in the sheets carrying the channel, a layer lighting the fixture without it counts at the channel's rest value:
      // a crossfade from a look writing a mode channel to one that does not switches it back at mid-fade too
      const sheets = new Set(carried.map((c) => c.sheet));
      const rest = isDimmer ? (r.levelDimmer ? 0 : 255) : isColour ? 0 : (r.shutterOpen.get(o) ?? 0);
      const resting = ordered.flatMap(({ l, order }) => (sheets.has(l.sheet) && lit(l) && valueOf(l, o) === undefined ? [{ sheet: l.sheet, weight: l.weight, value: rest, order }] : []));
      out.set(o, dominantLayer([...carried, ...resting], opts.merge)!.value);
      continue;
    }
    const { value, opacity } = overSheets(carried, opts.merge, 0);
    if (isDimmer) out.set(o, value);
    else if (isColour) out.set(o, hasDimmer && dimmerFades ? (intensity > 0 ? Math.min(255, value / intensity) : 0) : value);
    else if (opacity > 0) out.set(o, value / opacity);
    else if (r.shutterOpen.has(o)) out.set(o, r.shutterOpen.get(o)!);
  }
  // then the fixture's intensity (grand master, DCAs) and « au noir », as toDmx does on the other fixtures
  const dim = opts.wheel?.dim ?? 1;
  for (const d of dimmers) out.set(d, (out.get(d) ?? 0) * opts.intensity * dim);
  if (!hasDimmer) for (const o of colourOf.keys()) out.set(o, (out.get(o) ?? 0) * opts.intensity);
  for (const [o, v] of out) out.set(o, Math.max(0, Math.min(255, v)));
  return out;
}
