/**
 * The colour that sums up a look, for its button (docs/specs/ui-dashboards.md, « couleur auto »):
 * the most vivid of its technique's colours, the most frequent one on a tie. Pure.
 */
import type { Technique } from "../engine/techniques.js";

const HEX = /^#([0-9a-f]{6})$/i;

/** Every colour a technique names (raw steps: each cell of the first steps). */
function colorsOf(t: Technique): string[] {
  switch (t.kind) {
    case "plat":
    case "flash":
      return [t.color];
    case "orage":
      return [t.base, t.flash];
    case "pas":
      return t.steps.slice(0, 8).flat();
    case "aucune":
      return [];
    default:
      return "colors" in t ? [...t.colors] : [];
  }
}

/** Chroma first (a colour beats a white), then brightness; near-black does not count. */
function score(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const max = Math.max(r, g, b);
  if (max < 40) return -1;
  return (max - Math.min(r, g, b)) * 4 + max;
}

export function swatchOf(t: Technique): string | undefined {
  const counts = new Map<string, number>();
  for (const c of colorsOf(t)) if (HEX.test(c)) counts.set(c.toLowerCase(), (counts.get(c.toLowerCase()) ?? 0) + 1);
  let best: string | undefined;
  let bestKey = -Infinity;
  for (const [hex, count] of counts) {
    const s = score(hex);
    if (s < 0) continue;
    const key = s * 100 + count; // vividness first, frequency breaks ties
    if (key > bestKey) [best, bestKey] = [hex, key];
  }
  return best;
}
