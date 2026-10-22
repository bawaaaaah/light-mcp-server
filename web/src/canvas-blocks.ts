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
    blocks.push({ from: k, to: k, label, ...(color ? { color } : {}) });
  });
  return blocks;
}
