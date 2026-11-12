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
import { say } from "../../../core/lang.js";

/** What the engine reads of a fixture's enabled tracks: the offsets that fade (coarse and fine) and, per axis, what the motion layer does. */
export interface ResolvedTracks {
  fade: ReadonlySet<number>;
  /** A coarse channel's fine one (offsets), when the mode has it: a ticked pair glides as one 16-bit value. */
  fine: ReadonlyMap<number, number>;
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
  const coarse = new Map<string, { name: string; offset: number }>();
  const fine = new Map<number, number>();
  mode.channels.forEach((name, offset) => {
    const ch = def.channels.get(name);
    const kind = `${ch?.attribute ?? "other"}:${ch?.color ?? ""}`;
    const of = ch?.fine ? coarse.get(kind) : undefined;
    if (of && !fine.has(of.offset)) fine.set(of.offset, offset);
    const own = ch?.fine ? of?.name : name;
    if (!ch?.fine) coarse.set(kind, { name, offset });
    if (own !== undefined && names.has(own)) fade.add(offset);
    if (ch && !ch.fine && (ch.attribute === "pan" || ch.attribute === "tilt")) motion[ch.attribute] ??= names.has(name) ? "glide" : "cut";
  });
  return { fade, fine, motion };
}

/**
 * Why a list of channel names cannot be ticked on a model, in words, or undefined: a name its definition does not have,
 * or a fine channel (it follows its coarse one). venue.tracks.put and venue.fixture.put refuse it alike.
 */
export function trackNamesProblem(def: FixtureDefinition, names: readonly string[]): string | undefined {
  const coarse = [...def.channels.values()].filter((c) => !c.fine).map((c) => c.name);
  const unknown = names.filter((n) => !coarse.includes(n));
  if (!unknown.length) return undefined;
  return say(
    `pas un canal de ${def.manufacturer} ${def.model} (ou un canal fin, qui suit son canal) : ${unknown.join(", ")} ; canaux : ${coarse.join(", ")}`,
    `not a channel of ${def.manufacturer} ${def.model} (or a fine channel, which follows its coarse one): ${unknown.join(", ")}; channels: ${coarse.join(", ")}`,
  );
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
 * lays every layer at its own place in paint order (v = below × (1 − op) + v × op), the layers of one sheet sharing
 * its opacity: op = w ÷ (1 − the weights of the later layers of that sheet), the weights brought back to 1 when they
 * pass it. Laid next to each other they give the sheet's weighted mean exactly; with another look launched in
 * between, a look leaving through a crossfade stays under it instead of being lifted over it with the incoming one.
 * « highest » keeps the highest value weighed by its opacity (rawOver, the raw channels' own rule). `opacity` is the
 * combined one, 1 − Π(1 − op).
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
  const inOrder = [...carried].sort((a, b) => a.order - b.order);
  const later = new Map<string, number>();
  const ops: number[] = [];
  for (let i = inOrder.length - 1; i >= 0; i--) {
    const c = inOrder[i]!;
    const w = Math.max(0, c.weight) / Math.max(1, sheets.get(c.sheet)!.weight);
    const above = later.get(c.sheet) ?? 0;
    later.set(c.sheet, above + w);
    ops[i] = above >= 1 ? 0 : Math.min(1, w / (1 - above));
  }
  let value = held;
  inOrder.forEach((c, i) => {
    value = value * (1 - ops[i]!) + c.value * ops[i]!;
  });
  return { value, opacity };
}

/**
 * The layer whose value a jumping channel takes — the colour wheel's rule (T18 wheelFrame), so that one behaviour
 * explains both: with « last » only the latest sheet carrying the channel counts (a look started over another takes
 * its jumping channels at once); inside that sheet, or among all with « highest », the heaviest, the later one on
 * equal weights. So a crossfade switches at mid-fade, an entry at once, an exit at its very end. With « last », while
 * the heaviest of the latest sheet is a look leaving under looks of other sheets launched after it, those still
 * cover it (overSheets): the channel stays theirs until the incoming look outweighs it — one jump, not two.
 * `ties: "value"` (a light channel with « highest »): on equal weights the higher value, so that the steady state is
 * the highest as on a fixture without tracks. composeTracks adds, in the sheets carrying the channel, the layers
 * lighting the fixture without it, at the channel's rest value.
 */
export function dominantLayer<T extends { sheet: string; weight: number; order: number; value?: number }>(carried: readonly T[], merge: LooksMerge, ties: "later" | "value" = "later"): T | undefined {
  const heavier = (x: T | undefined, y: T): T => {
    if (!x) return y;
    const wx = Math.max(0, x.weight);
    const wy = Math.max(0, y.weight);
    if (wy !== wx) return wy > wx ? y : x;
    if (ties === "value" && (y.value ?? 0) !== (x.value ?? 0)) return (y.value ?? 0) > (x.value ?? 0) ? y : x;
    return y.order >= x.order ? y : x;
  };
  if (merge !== "last") return carried.reduce<T | undefined>(heavier, undefined);
  const last = carried.reduce<T | undefined>((x, y) => (!x || y.order >= x.order ? y : x), undefined);
  if (!last) return undefined;
  const top = carried.filter((c) => c.sheet === last.sheet).reduce<T | undefined>(heavier, undefined)!;
  const over = carried.filter((c) => c.sheet !== last.sheet && c.order > top.order);
  return over.length ? dominantLayer(over, merge, ties) : top;
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
  /**
   * A layer lights the fixture by itself (`lit`) when it paints it or writes one of its light channels (a dimmer, a
   * colour): only such a layer carries the dimmer. A layer writing machine channels only (a mode, a gobo, a speed) is
   * there too (`present`): it counts in what the colours are shared against and in a jumping channel's rest, and on a
   * fading dimmer it fills, at full, what the lighting layers leave uncovered (below) — it fades in and out like any
   * look, and never raises the dimmer over another look's. A position alone is no layer.
   */
  const lightChannel = (o: number) => dimmers.includes(o) || colourOf.has(o);
  const lits = new Map(layers.map((l) => [l, (l.colors?.size ?? 0) > 0 || [...l.raw.keys()].some(lightChannel)]));
  const lit = (l: TrackLayer) => lits.get(l) ?? false;
  const presents = new Map(layers.map((l) => [l, (l.colors?.size ?? 0) > 0 || [...l.raw.keys()].some(own)]));
  const present = (l: TrackLayer) => presents.get(l) ?? false;
  /**
   * The groups' level of a look (T35), as on a fixture without tracks (rawLevelApplies): a look that doses its light by its
   * colours (it paints the fixture or writes a raw colour) has each colour dosed by its own level and leaves the dimmer
   * as it is — the dimmer is shared by every look, it cannot carry one look's level; a channel fader linked to the group
   * already gives that look 1 on the channel it holds. A look lighting it by its raw dimmer only, or a lamp (its dimmer is
   * its painted level), has its dimmer dosed.
   */
  const byColour = new Map(layers.map((l) => [l, (l.colors?.size ?? 0) > 0 || [...l.raw.keys()].some((o) => colourOf.has(o))]));
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
      if (v === undefined) return undefined;
      return r.levelDimmer || !byColour.get(l) ? v * levelAt(l, o) : v;
    }
    const colour = colourOf.get(o);
    if (colour) {
      let v = raw;
      if (v === undefined) {
        const c = l.colors?.get(colour.head) ?? (r.accent.has(colour.head) && !r.follow ? undefined : l.colors?.get(-1));
        if (c) v = (c[colour.comp] ?? 0) * 255;
      }
      return v === undefined ? undefined : v * levelAt(l, o);
    }
    return raw;
  };
  const offsets = new Set<number>([...dimmers, ...colourOf.keys()]);
  for (const l of layers) for (const o of l.raw.keys()) if (own(o)) offsets.add(o);
  if (wheelOffset !== undefined) offsets.add(wheelOffset);
  const ordered = layers.map((l, order) => ({ l, order }));
  const opacityOf = (keep: (l: TrackLayer) => boolean) => overSheets(ordered.filter(({ l }) => keep(l)).map(({ l, order }) => ({ sheet: l.sheet, weight: l.weight, value: 1, order })), opts.merge, 0).opacity;
  // the combined opacity of the layers on the fixture, machine ones included: what a colour under a fading dimmer is shared against
  const intensity = opacityOf(present);
  // what the layers writing machine channels only add to it: the share of a fading dimmer they hold at full. Never on a
  // lamp (its dimmer is its painted level). In a crossfade the sheet is shared, so the dimmer does not dip between a
  // machine look and a painted one; between sheets it is (1 − the lighting layers' opacity) × the machine layers' own
  const machineFill = r.levelDimmer ? 0 : Math.max(0, intensity - opacityOf(lit));
  const dimmerFades = dimmers.some((d) => tracks.fade.has(d));
  // a ticked 16-bit pair (a zoom, a focus): the coarse channel glides with its fine one as one value, written by the coarse
  const glides = (o: number) => tracks.fade.has(o) && !dimmers.includes(o) && !colourOf.has(o) && o !== wheelOffset;
  const pairs = new Map([...tracks.fine].filter(([c, f]) => offsets.has(c) && glides(c) && own(f)));
  const paired = new Set(pairs.values());
  for (const o of offsets) {
    if (paired.has(o)) continue;
    const fine = pairs.get(o);
    if (fine !== undefined) {
      // a layer writing only the fine byte of the pair carries nothing here: the coarse byte says where the value is
      const wide: Carried[] = ordered.flatMap(({ l, order }) => {
        const v = l.raw.get(o);
        return v === undefined ? [] : [{ sheet: l.sheet, weight: l.weight, value: v * 256 + (l.raw.get(fine) ?? 0), order }];
      });
      const glide = overSheets(wide, opts.merge, 0);
      if (glide.opacity > 0) {
        const v16 = Math.max(0, Math.min(65535, Math.round(glide.value / glide.opacity)));
        out.set(o, v16 >> 8);
        out.set(fine, v16 & 255);
      } else if (r.shutterOpen.has(o)) out.set(o, r.shutterOpen.get(o)!);
      continue;
    }
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
      // at rest: a colour fixture's dimmer held at full (dark under black colours), a lamp's dark, a shutter open; under
      // machine layers only, a fading dimmer follows them from black (a jumping one is at full at once)
      if (isDimmer) out.set(o, r.levelDimmer ? 0 : tracks.fade.has(o) && layers.some(present) ? machineFill * 255 : 255);
      else if (isColour) out.set(o, 0);
      else if (r.shutterOpen.has(o)) out.set(o, r.shutterOpen.get(o)!);
      continue;
    }
    if (!tracks.fade.has(o) || o === wheelOffset) {
      // in the sheets carrying the channel, a layer lighting the fixture without it counts at the channel's rest value:
      // a crossfade from a look writing a mode channel to one that does not switches it back at mid-fade too
      const sheets = new Set(carried.map((c) => c.sheet));
      const rest = isDimmer ? (r.levelDimmer ? 0 : 255) : isColour ? 0 : (r.shutterOpen.get(o) ?? 0);
      const resting = ordered.flatMap(({ l, order }) => (sheets.has(l.sheet) && present(l) && valueOf(l, o) === undefined ? [{ sheet: l.sheet, weight: l.weight, value: rest, order }] : []));
      out.set(o, dominantLayer([...carried, ...resting], opts.merge, isDimmer || isColour ? "value" : "later")!.value);
      continue;
    }
    const { value, opacity } = overSheets(carried, opts.merge, 0);
    if (isDimmer) out.set(o, value + machineFill * 255);
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
