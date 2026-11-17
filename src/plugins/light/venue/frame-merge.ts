/**
 * How the looks playing on one fixture combine into a frame (docs/specs/engine-effects-timing.md): raw channels
 * laid as layers over what the show holds (`rawOver`), colours merged « last » or « highest » (`mergeColors`), and
 * weighted colour sheets added up and shared out in a crossfade (`addWeighted`, `settle`). Pure: no venue, no
 * DMX, so the venue (toDmx) and the fadeable tracks (tracks.ts) read the same rules without importing each other.
 */
import type { ColorComponent } from "./qxf-import.js";

export type Color = Partial<Record<ColorComponent, number>>; // components 0..1

/**
 * One look's write on a raw channel (docs/specs/engine-effects-timing.md, « Fondu des canaux bruts d'un
 * look »): its DMX value, the fade weight of its look, the look, and the sheet it rides on — a crossfade
 * and the looks it replaces share one sheet, every other look has its own. `level` (1 when absent): what
 * the groups including the look give it on this fixture (ShowRuntime.lookLevelOn, T35) — it doses the
 * look's light once, like its weight: its dimmer, or its colours when it doses itself by them.
 */
export interface RawWrite {
  value: number;
  weight: number;
  look: string;
  sheet: string;
  level?: number;
}

/**
 * A dosed raw channel (a dimmer or colour offset) over what the show holds there, composed like layers.
 * Each sheet is a layer: its opacity is its weight (at most 1) and its value the weighted mean of its
 * writes (a crossfade inside it goes from one value to the other without a dip). The `held` byte
 * lies under all of them: the result is held × (1 − combined opacity) + combined opacity × the highest
 * layer value, each value weighted by its opacity against the most opaque layer. So a look fading in
 * or out crosses from the held byte to its level and back instead of starting from black; looks that
 * do not cross keep the highest at full (HTP), a look just arriving cannot jump over one already
 * there, and an unrelated look writing 0 does not dig into a crossfade.
 */
export function rawOver(writes: readonly RawWrite[], held: number): number {
  const sheets = new Map<string, { dosed: number; weight: number }>();
  for (const x of writes) {
    const w = Math.max(0, x.weight);
    const sheet = sheets.get(x.sheet) ?? { dosed: 0, weight: 0 };
    sheet.dosed += x.value * w;
    sheet.weight += w;
    sheets.set(x.sheet, sheet);
  }
  const layers = [...sheets.values()].filter((l) => l.weight > 0).map((l) => ({ opacity: Math.min(1, l.weight), value: l.dosed / l.weight }));
  if (!layers.length) return held;
  const opacity = 1 - layers.reduce((clear, l) => clear * (1 - l.opacity), 1);
  const top = Math.max(...layers.map((l) => l.opacity));
  const value = Math.max(...layers.map((l) => (l.value * l.opacity) / top));
  return held * (1 - opacity) + opacity * value;
}

/**
 * The byte held under a raw dimmer: the show's own (`kept`) unless a look dosing by its dimmer writes
 * it — that one rises from what else lights the fixture (`underOwnDimmer`), and the held byte goes
 * back up to the show's as the looks dosing by their colours on that dimmer gain weight. In absolute
 * terms, never a mean of the writers: two looks of each kind started in the same frame do not jump.
 */
export function heldUnderDimmer(writes: readonly RawWrite[], kept: number, underOwnDimmer: number | undefined, byColour: (look: string) => boolean): number {
  if (underOwnDimmer === undefined || writes.every((x) => byColour(x.look))) return kept;
  const colourWeight = Math.min(1, writes.reduce((sum, x) => sum + (byColour(x.look) ? Math.max(0, x.weight) : 0), 0));
  return underOwnDimmer + (kept - underOwnDimmer) * colourWeight;
}

/**
 * The dimmer of a fixture driven by machine channels (a wheel, a macro: a colour that cannot scale),
 * from the looks' machine weight `machine` and the weight `selfDosed` (at most 1) of the looks that
 * dose themselves there (painting it, or writing its own dimmer or colours). Continuous everywhere
 * but at the origin (a machine look and a self-dosing look started together jump to about half in
 * one frame: no formula without memory avoids it, docs/specs/engine-effects-timing.md):
 * 1 while the machine weight is 0 and something doses itself (a look coming in over a lit fixture
 * takes nothing from it), the machine weight alone when nothing else is there, 1 when what doses
 * itself is at full — in between, the machine's share eases from one to the other.
 */
export function machineFade(machine: number, selfDosed: number): number {
  if (machine + selfDosed <= 0) return 0;
  return 1 - (1 - machine) * (1 - selfDosed) * (machine / (machine + selfDosed));
}

/**
 * Whether a look's `level` (the groups including it, T35) doses its raw write on a channel, given how the look
 * doses its light on that fixture — once, like its weight: on the dimmer of a look dosing itself by it (it writes
 * the dimmer, no colour, paints nothing there), on the colours of any other; never on a machine channel.
 * venue.toDmx and dmx.explain read this one rule.
 */
export function rawLevelApplies(channel: "dimmer" | "colour" | "machine", look: { byColour: boolean; byDimmer: boolean }): boolean {
  if (channel === "dimmer") return !look.byColour;
  if (channel === "colour") return look.byColour || !look.byDimmer;
  return false;
}

/** The strongest value written on a raw channel: a machine channel holds it verbatim. */
export const rawValue = (writes: readonly RawWrite[]): number => writes.reduce((top, x) => Math.max(top, x.value), 0);

/** fixtureId → head (-1 = whole fixture) → colour: the colours of a frame (AttributeFrame.colors) or of one look. */
export type FrameColors = Map<string, Map<number, Color>>;

/** How the colours of several looks playing on the same fixture combine (show setting `looksMerge`). */
export type LooksMerge = "last" | "highest";

/** Each colour component at the higher of the two. */
export const brighter = (a: Color, b: Color): Color => {
  const out: Color = { ...a };
  for (const [k, v] of Object.entries(b) as [ColorComponent, number][]) out[k] = Math.max(out[k] ?? 0, v);
  return out;
};

/**
 * One look's colours onto what the looks before it painted: « last », the last one started covers
 * the others on every head it reaches (a whole-fixture colour: all of them); « highest », each colour component keeps the highest value (two looks
 * add up, black never darkens). A whole fixture (head -1) and its heads combine as toDmx reads them:
 * a head shows its own colour, else the whole fixture's.
 */
export function mergeColors(into: FrameColors, from: FrameColors, how: LooksMerge): void {
  for (const [fixture, heads] of from) {
    const dst = into.get(fixture);
    if (!dst || how === "last") {
      // « last »: the later look covers every head it reaches; a whole-fixture colour reaches them all (an accent it
      // does not paint was spelt out of it by Venue.followAccents, and keeps what the looks before painted there)
      if (!dst || heads.has(-1)) into.set(fixture, new Map(heads));
      else for (const [h, c] of heads) dst.set(h, c);
      continue;
    }
    const whole = heads.get(-1);
    for (const [h, c] of heads) {
      if (h === -1) continue;
      const base = dst.get(h) ?? dst.get(-1);
      dst.set(h, base ? brighter(base, whole ? brighter(c, whole) : c) : c);
    }
    if (whole) {
      for (const [h, c] of dst) if (h !== -1 && !heads.has(h)) dst.set(h, brighter(c, whole));
      const before = dst.get(-1);
      dst.set(-1, before ? brighter(before, whole) : whole);
    }
  }
}

/** Colours already scaled by their weight, with the weight that painted each cell (a crossfade's looks add up). */
export type WeightedColors = Map<string, Map<number, { color: Color; weight: number }>>;

/** A sheet of colours (already scaled by `weight`) as weighted colours. */
export function weighted(colors: FrameColors, weight: number): WeightedColors {
  return new Map([...colors].map(([fixture, heads]) => [fixture, new Map([...heads].map(([h, color]) => [h, { color, weight }]))]));
}

/**
 * Two weighted sheets laid over each other: where both paint a cell the colours and the weights add up, where
 * one paints it it stays as it is. A head shows its own colour, else the whole fixture's, as toDmx reads them:
 * the sum is taken on what each sheet shows for that head.
 */
export function addWeighted(a: WeightedColors, b: WeightedColors): WeightedColors {
  const out: WeightedColors = new Map();
  const add = (x: Color, y: Color): Color => {
    const sum: Color = {};
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)]) as Set<ColorComponent>) sum[k] = (x[k] ?? 0) + (y[k] ?? 0);
    return sum;
  };
  for (const fixture of new Set([...a.keys(), ...b.keys()])) {
    const ha = a.get(fixture);
    const hb = b.get(fixture);
    if (!ha || !hb) {
      out.set(fixture, new Map(ha ?? hb));
      continue;
    }
    const heads = new Map<number, { color: Color; weight: number }>();
    for (const h of new Set([...ha.keys(), ...hb.keys()])) {
      const x = ha.get(h) ?? (h === -1 ? undefined : ha.get(-1));
      const y = hb.get(h) ?? (h === -1 ? undefined : hb.get(-1));
      const c = x && y ? { color: add(x.color, y.color), weight: x.weight + y.weight } : (x ?? y);
      if (c) heads.set(h, c);
    }
    out.set(fixture, heads);
  }
  return out;
}

/**
 * Weighted sheets as plain colours (docs/specs/engine-effects-timing.md, « Fondu enchaîné »): a cell whose weights
 * add up past 1 is shared out, so it is never brighter than the brighter of the looks on it; below 1 it keeps its
 * weight (a dip, or the tail of a look that is leaving).
 */
export function settle(w: WeightedColors): FrameColors {
  const out: FrameColors = new Map();
  for (const [fixture, heads] of w) {
    out.set(
      fixture,
      new Map(
        [...heads].map(([h, { color, weight }]) => {
          const k = 1 / Math.max(1, weight);
          return [h, Object.fromEntries(Object.entries(color).map(([c, v]) => [c, Math.min(1, (v ?? 0) * k)])) as Color];
        }),
      ),
    );
  }
  return out;
}

/**
 * The part of a weighted sheet on the heads `of` shows (those it paints, or all of a fixture it paints whole: a head
 * shows its own colour, else the fixture's, as toDmx reads them), and the rest. A whole-fixture colour of the sheet
 * is copied to the heads `of` paints, and stays in the rest for the heads it does not.
 */
export function splitByShown(w: WeightedColors, of: FrameColors): { inside: WeightedColors; outside: WeightedColors } {
  const inside: WeightedColors = new Map();
  const outside: WeightedColors = new Map();
  for (const [fixture, heads] of w) {
    const shown = of.get(fixture);
    if (!shown) {
      outside.set(fixture, heads);
    } else if (shown.has(-1)) {
      inside.set(fixture, heads);
    } else {
      const own = new Map<number, { color: Color; weight: number }>();
      for (const h of shown.keys()) {
        const c = heads.get(h) ?? heads.get(-1);
        if (c) own.set(h, c);
      }
      if (own.size) inside.set(fixture, own);
      const rest = new Map([...heads].filter(([h]) => !shown.has(h)));
      if (rest.size) outside.set(fixture, rest);
    }
  }
  return { inside, outside };
}

/** A 8- or 16-bit channel pair. */
export interface CoarseFine {
  coarse: number;
  fine?: number;
}
