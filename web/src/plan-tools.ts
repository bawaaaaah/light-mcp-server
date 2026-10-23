/**
 * Placing fixtures on the stage plan (docs/specs/venue-fixtures-stage.md, « Placer »): the magnetic
 * grid, the guides that hold a dragged fixture on another's line, lining up and spreading a
 * selection, the frame drawn to select, and fixture names laid out without overlap. Pure: the plan's
 * coordinates in, the plan's coordinates out (metres; the names, in the drawing's units).
 */

export type P = { x: number; y: number };

const cm = (v: number) => Math.round(v * 100) / 100;

/** A value on the grid, `step` metres apart; 0: to the centimetre. */
export function snap(v: number, step: number): number {
  const s = step > 0 ? step : 0.01;
  return cm(Math.round(v / s) * s);
}

/** The nearest of `lines` within `reach` of v, or undefined. */
export function magnet(v: number, lines: readonly number[], reach: number): number | undefined {
  let best: number | undefined;
  for (const l of lines) if (Math.abs(l - v) <= reach && (best === undefined || Math.abs(l - v) < Math.abs(best - v))) best = l;
  return best;
}

/**
 * Where a dragged selection goes: the fixture held, brought to `to`, is held on the line or the
 * column of another fixture (`others`; and the stage's middle) within `reach` when `guides` is on,
 * on the grid otherwise. The others keep their place around it.
 */
export function dragOffset(held: P, to: P, others: readonly P[], opts: { step: number; guides: boolean; reach: number; middle?: boolean }): { dx: number; dy: number; guide: { x?: number; y?: number } } {
  const xs = opts.guides ? [...others.map((p) => p.x), ...(opts.middle === false ? [] : [0])] : [];
  const ys = opts.guides ? others.map((p) => p.y) : [];
  const gx = magnet(to.x, xs, opts.reach);
  const gy = magnet(to.y, ys, opts.reach);
  const x = gx ?? snap(to.x, opts.step);
  const y = gy ?? snap(to.y, opts.step);
  return { dx: cm(x - held.x), dy: cm(y - held.y), guide: { ...(gx !== undefined ? { x: gx } : {}), ...(gy !== undefined ? { y: gy } : {}) } };
}

export type Arrange = "row" | "column" | "spreadX" | "spreadY";

/**
 * Several fixtures lined up: on one row (the same y, their average) or one column (the same x), or
 * spread evenly between the outermost two, across (x) or along (y), in their order. To the centimetre.
 */
export function arrange<T extends P & { id: string }>(points: readonly T[], how: Arrange): T[] {
  if (points.length < 2) return [...points];
  const mean = (k: "x" | "y") => cm(points.reduce((a, p) => a + p[k], 0) / points.length);
  if (how === "row") return points.map((p) => ({ ...p, y: mean("y") }));
  if (how === "column") return points.map((p) => ({ ...p, x: mean("x") }));
  const k = how === "spreadX" ? "x" : "y";
  const sorted = [...points].sort((a, b) => a[k] - b[k]);
  const [lo, hi] = [sorted[0]![k], sorted[sorted.length - 1]![k]];
  const at = new Map(sorted.map((p, i) => [p.id, cm(lo + ((hi - lo) * i) / (sorted.length - 1))]));
  return points.map((p) => ({ ...p, [k]: at.get(p.id)! }));
}

/** Inside the frame drawn from a to b (either way round). */
export function inFrame(p: P, a: P, b: P): boolean {
  return p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}

/** A name's width in the drawing, from its length (an average letter: 0.58 of the font size). */
export const textWidth = (text: string, fontSize: number) => text.length * fontSize * 0.58;

/**
 * Fixture names on the plan without overlap: each under its fixture (`below`, a baseline), else above
 * it (`above`), else left out (its name stays on hover), in the order given. `size`: the font size.
 * Returns the baseline of each name shown.
 */
export function placeLabels(items: readonly { id: string; x: number; below: number; above: number; width: number }[], size: number): Map<string, number> {
  const kept: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const shown = new Map<string, number>();
  const gap = size * 0.2;
  for (const it of items) {
    for (const y of [it.below, it.above]) {
      const box = { x0: it.x - it.width / 2 - gap, x1: it.x + it.width / 2 + gap, y0: y - size * 0.8, y1: y + size * 0.25 };
      if (kept.some((k) => box.x0 < k.x1 && k.x0 < box.x1 && box.y0 < k.y1 && k.y0 < box.y1)) continue;
      kept.push(box);
      shown.set(it.id, y);
      break;
    }
  }
  return shown;
}
