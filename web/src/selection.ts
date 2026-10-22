/**
 * Several dashboard widgets selected at once while editing (docs/specs/ui-dashboards.md,
 * « Sélection multiple »), to give them the same colour or the same behaviour. Pure.
 */

/** A widget's place on the grid. */
export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The widgets framed between two: every one whose centre lies in the rectangle they span, across and down. */
export function framed(boxes: readonly Box[], a: Box, b: Box): string[] {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return boxes
    .filter((c) => {
      const cx = c.x + c.w / 2;
      const cy = c.y + c.h / 2;
      return cx > x1 && cx < x2 && cy > y1 && cy < y2;
    })
    .sort((p, q) => p.y - q.y || p.x - q.x)
    .map((c) => c.id);
}

/**
 * A click on a widget while editing: alone, it is the selection; `add` (Ctrl or ⌘, or the multiple
 * mode of a tablet) adds it or takes it out; `frame` (Shift) selects every widget framed between it
 * and the last one clicked, added to the selection with `add` too. The last one clicked stays the
 * corner a frame starts from.
 */
export function pick(boxes: readonly Box[], selection: readonly string[], anchor: string | undefined, clicked: Box, how: { add: boolean; frame: boolean }): { selection: string[]; anchor: string } {
  const from = boxes.find((b) => b.id === anchor);
  if (how.frame && from) {
    const range = framed(boxes, from, clicked);
    return { selection: how.add ? [...new Set([...selection, ...range])] : range, anchor: from.id };
  }
  if (how.add) return { selection: selection.includes(clicked.id) ? selection.filter((id) => id !== clicked.id) : [...selection, clicked.id], anchor: clicked.id };
  return { selection: [clicked.id], anchor: clicked.id };
}
