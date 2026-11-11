/**
 * The canvas editor's view of a canvas (docs/specs/venue-fixtures-stage.md, « Éditer un canevas », T13):
 * its cells one by one, which ones are picked, where a drag would drop them, the default order of the
 * fixtures added. Pure: the operations themselves are the server's (venue.canvas.edit); this only says what
 * to send and how to show it.
 */
import { pick, type Box } from "./selection.js";
import type { CanvasRender } from "./canvas-blocks.js";

export interface CellTarget {
  fixture: string;
  head: number;
}

/** The targets of each cell, as the server reads them (overlapping ranges add up; a range past the end is cut). */
export function cellTargets(cells: number, render: readonly CanvasRender[]): CellTarget[][] {
  const out: CellTarget[][] = Array.from({ length: cells }, () => []);
  for (const r of render) for (let i = Math.max(0, r.from); i <= Math.min(r.to, cells - 1); i++) out[i]!.push(...r.targets);
  return out;
}

const box = (i: number): Box => ({ id: String(i), x: i, y: 0, w: 1, h: 1 });

/**
 * A click on a cell, as on the dashboards (selection.ts `pick`): alone it is the selection; `add` (Ctrl/⌘, or the
 * multiple mode of a tablet) adds or takes it out; `frame` (Shift) takes every cell from the last one clicked.
 * Returns the cells picked, in canvas order.
 */
export function pickCells(count: number, selection: readonly number[], anchor: number | undefined, clicked: number, how: { add: boolean; frame: boolean }): { selection: number[]; anchor: number } {
  const boxes = Array.from({ length: count }, (_, i) => box(i));
  const r = pick(boxes, selection.map(String), anchor === undefined ? undefined : String(anchor), box(clicked), how);
  return { selection: r.selection.map(Number).sort((a, b) => a - b), anchor: Number(r.anchor) };
}

/** The cells whose centre lies in a frame drawn over the strip (screen rectangles: the strip wraps over lines). */
export function cellsInFrame(rects: readonly { left: number; top: number; width: number; height: number }[], frame: { x1: number; y1: number; x2: number; y2: number }): number[] {
  const [x1, x2] = [Math.min(frame.x1, frame.x2), Math.max(frame.x1, frame.x2)];
  const [y1, y2] = [Math.min(frame.y1, frame.y2), Math.max(frame.y1, frame.y2)];
  return rects.flatMap((r, i) => {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2 ? [i] : [];
  });
}

/**
 * The gap a drag drops into, from the pointer and the cells' screen rectangles (the strip wraps over lines): the
 * nearest cell on the pointer's line (else the nearest line), before it when the pointer is on its left half,
 * after it otherwise. 0 = before the first cell, `rects.length` = after the last.
 */
export function gapAt(x: number, y: number, rects: readonly { left: number; top: number; width: number; height: number }[]): number {
  if (!rects.length) return 0;
  const onLine = rects.map((r, i) => ({ r, i })).filter(({ r }) => y >= r.top && y <= r.top + r.height);
  const pool = onLine.length ? onLine : rects.map((r, i) => ({ r, i }));
  const dist = (r: { left: number; top: number; width: number; height: number }) => Math.hypot(x - (r.left + r.width / 2), onLine.length ? 0 : y - (r.top + r.height / 2));
  const nearest = pool.reduce((a, b) => (dist(b.r) < dist(a.r) ? b : a));
  return x < nearest.r.left + nearest.r.width / 2 ? nearest.i : nearest.i + 1;
}

/** The cells' order after moving `cells` into the gap `to` (counted before the move), as venue.canvas.edit does it: for the preview while dragging. */
export function movedOrder(count: number, cells: readonly number[], to: number): number[] {
  const moved = [...new Set(cells)].filter((i) => i >= 0 && i < count).sort((a, b) => a - b);
  const set = new Set(moved);
  const rest = Array.from({ length: count }, (_, i) => i).filter((i) => !set.has(i));
  const at = to - moved.filter((i) => i < to).length;
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}

/** Whether a move changes nothing (the cells dropped where they already are, in one block). */
export function isNoMove(count: number, cells: readonly number[], to: number): boolean {
  return movedOrder(count, cells, to).every((c, i) => c === i);
}

/** Where the picked cells end after a move, to keep them picked. */
export function pickedAfterMove(count: number, cells: readonly number[], to: number): number[] {
  const order = movedOrder(count, cells, to);
  const set = new Set(cells);
  return order.flatMap((c, i) => (set.has(c) ? [i] : []));
}

/**
 * The fixtures to add, in their default order (decided with the user, 2026-11-11): from jardin to cour on the
 * stage when they are all placed, otherwise in patch order (universe, address); the editor lets it be changed.
 */
export function addOrder<F extends { id: string; universe: number; address: number; position?: { x: number } }>(fixtures: readonly F[]): F[] {
  const placed = fixtures.length > 0 && fixtures.every((f) => f.position);
  return [...fixtures].sort((a, b) => (placed ? a.position!.x - b.position!.x : 0) || a.universe - b.universe || a.address - b.address);
}

/** A step of the editor's undo: the canvas, and the looks whose steps followed it, before and after. */
export interface EditStep<C, L> {
  before: C;
  after: C;
  looksBefore: L[];
  looksAfter: L[];
}

/** The editor's undo and redo stacks (as the dashboards' editor: 100 steps, a new change forgets the redo). */
export class EditHistory<C, L> {
  private past: EditStep<C, L>[] = [];
  private future: EditStep<C, L>[] = [];
  constructor(private readonly max = 100) {}
  push(step: EditStep<C, L>): void {
    this.past.push(step);
    if (this.past.length > this.max) this.past.shift();
    this.future = [];
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  /** The step to take back (moved to the redo stack): undefined when there is none. */
  undo(): EditStep<C, L> | undefined {
    const s = this.past.pop();
    if (s) this.future.push(s);
    return s;
  }
  redo(): EditStep<C, L> | undefined {
    const s = this.future.pop();
    if (s) this.past.push(s);
    return s;
  }
  /** A step that could not be taken back or redone goes back where it was. */
  restoreUndo(step: EditStep<C, L>): void {
    this.future = this.future.filter((s) => s !== step);
    this.past.push(step);
  }
  restoreRedo(step: EditStep<C, L>): void {
    this.past = this.past.filter((s) => s !== step);
    this.future.push(step);
  }
  clear(): void {
    this.past = [];
    this.future = [];
  }
}
