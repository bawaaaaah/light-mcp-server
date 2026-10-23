/**
 * The fixtures behind a canvas's cells, block by block (docs/specs/engine-effects-timing.md, « Éditeur
 * de pas »): consecutive cells of one fixture make a block named after it, so a long step row reads
 * « B1 · barre (gauche) | B2 · barre | … » above its squares. Pure.
 */

export interface CanvasRender {
  from: number;
  to: number;
  targets: { fixture: string; head: number }[];
}

export interface Block {
  /** First and last cell, 0-based, inclusive. */
  from: number;
  to: number;
  label: string;
  /** The fixtures behind it (none for cells nothing drives). */
  fixtures: string[];
  /** The fixture's marker colour, when it has one. */
  color?: string;
}

export function canvasBlocks(cells: number, render: readonly CanvasRender[], fixtures: readonly { id: string; name: string; color?: string }[]): Block[] {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  // who drives each cell (several fixtures on one cell read as one « A + B »)
  const owner: (string | undefined)[] = Array.from({ length: cells }, () => undefined);
  for (const r of render) {
    const ids = [...new Set(r.targets.map((t) => t.fixture))].join("+");
    for (let k = Math.max(0, r.from); k <= Math.min(cells - 1, r.to); k++) owner[k] = ids;
  }
  const blocks: Block[] = [];
  let key: string | undefined;
  owner.forEach((ids = "", k) => {
    if (ids === key) {
      blocks[blocks.length - 1]!.to = k;
      return;
    }
    key = ids;
    const label = ids ? ids.split("+").map((id) => byId.get(id)?.name ?? id).join(" + ") : "";
    const color = ids && !ids.includes("+") ? byId.get(ids)?.color : undefined;
    blocks.push({ from: k, to: k, label, fixtures: ids ? ids.split("+") : [], ...(color ? { color } : {}) });
  });
  return blocks;
}

/**
 * The cells as the stage shows them: blocks from jardin to cour (by their fixture's x on the stage,
 * the leftmost of several), the unplaced ones after in the canvas's order; inside a block, its cells
 * in order. Only how they are shown: the steps keep the canvas's order. `order[i]` is the canvas
 * cell shown i-th; the blocks come back with their shown positions.
 */
export function stageOrder(blocks: readonly Block[], x: ReadonlyMap<string, number>): { order: number[]; blocks: Block[] } {
  const at = (b: Block) => Math.min(...b.fixtures.map((f) => x.get(f) ?? Infinity));
  const sorted = blocks.map((b, i) => ({ b, i, x: at(b) })).sort((p, q) => (p.x === q.x ? p.i - q.i : p.x < q.x ? -1 : 1));
  const order: number[] = [];
  const shown: Block[] = [];
  for (const { b } of sorted) {
    shown.push({ ...b, from: order.length, to: order.length + (b.to - b.from) });
    for (let k = b.from; k <= b.to; k++) order.push(k);
  }
  return { order, blocks: shown };
}

/** One frame of a look's cells (canvas order) as the stage plan draws it: each fixture's heads, a whole fixture as one. */
export function fixtureColors(frame: readonly (string | null)[], render: readonly CanvasRender[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of render) {
    for (let k = r.from; k <= r.to; k++) {
      const c = frame[k];
      if (!c) continue;
      for (const t of r.targets) {
        const heads = (out[t.fixture] ??= []);
        if (t.head < 0) heads.splice(0, heads.length, c);
        else heads[t.head] = c;
      }
    }
  }
  for (const heads of Object.values(out)) for (let h = 0; h < heads.length; h++) heads[h] ??= "#000000";
  return out;
}

/**
 * The strip's columns (a CSS grid template), block by block in the order shown: a fixture of a few
 * cells, a spot, is widened to a third of the longest block (3 to 12 cells' worth), so its colour
 * still shows beside long LED bars; a long block keeps one column per cell. `width` says, per block,
 * how many cells' worth it takes.
 */
export function stripColumns(blocks: readonly Block[]): { template: string; width: number[] } {
  const longest = Math.max(1, ...blocks.map((b) => b.to - b.from + 1));
  const least = Math.min(12, Math.max(3, Math.round(longest / 3)));
  const width: number[] = [];
  const template = blocks
    .map((b) => {
      const n = b.to - b.from + 1;
      const w = Math.max(1, least / n);
      width.push(n * w);
      return `repeat(${n}, minmax(0, ${Math.round(w * 100) / 100}fr))`;
    })
    .join(" ");
  return { template, width };
}
