/**
 * Rebuilds an imported look (exact steps, technique "pas") into a parametric technique that can be
 * edited (colours, block size, masks), when the recognised technique allows it. The candidate is
 * rendered again and compared cell by cell with the original steps: the fidelity score decides
 * whether the rebuild is worth proposing (docs/specs/presets-songs-notes.md, step 3).
 */
import { generateSteps, hexToColor, type Technique } from "../engine/techniques.js";
import type { Color } from "../venue/venue.js";
import { say } from "../../../core/lang.js";

type Rgbw = [number, number, number, number];
const toRgbw = (c: Color | null): Rgbw | null => (c ? [Math.round((c.red ?? 0) * 255), Math.round((c.green ?? 0) * 255), Math.round((c.blue ?? 0) * 255), Math.round((c.white ?? 0) * 255)] : null);
const fromHex = (h: string): Rgbw | null => (h === "" ? null : h === "-" ? [0, 0, 0, 0] : toRgbw(hexToColor(h)));
const isOff = (c: Rgbw | null) => !c || c.every((v) => v < 20);
const hex = (c: Rgbw) => "#" + c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("") + (c[3] ? `+w${c[3]}` : "");
const close = (a: Rgbw | null, b: Rgbw | null) => {
  if (isOff(a) && isOff(b)) return true;
  if (!a || !b) return false;
  return a.every((v, i) => Math.abs(v - b[i]!) <= 24);
};

export interface RebuildResult {
  technique: Technique | null;
  fidelity: number; // 0..1, cells matching the original
  reason: string;
}

/** Run length of the first block (cells sharing the colour of cell 0) on the first step. */
function blockSize(row: (Rgbw | null)[]): number {
  let n = 1;
  while (n < row.length && close(row[n]!, row[0]!)) n++;
  return n;
}

/** Score: fraction of cells whose rendered colour matches the original, over all steps. */
export function fidelity(original: string[][], candidate: Technique, mirror: boolean): number {
  const cells = original[0]?.length ?? 0;
  const rendered = generateSteps(candidate, cells, mirror).map((s) => s.map(toRgbw));
  const orig = original.map((r) => r.map(fromHex));
  if (rendered.length === 0) return 0;
  let ok = 0;
  let total = 0;
  // Compare each original step with the best-matching rendered step (order may differ: Random).
  for (const row of orig) {
    let best = 0;
    for (const r of rendered) {
      let m = 0;
      row.forEach((c, i) => (close(c, r[i] ?? null) ? m++ : 0));
      best = Math.max(best, m);
    }
    ok += best;
    total += row.length;
  }
  return total ? ok / total : 0;
}

export function rebuild(steps: string[][], recognised: string, mirror: boolean): RebuildResult {
  // The entry step (« pas 0 d'entrée ») was already turned into entryFade at import.
  const rows = steps.map((r) => r.map(fromHex));
  const first = rows.find((r) => r.some((c) => !isOff(c))) ?? rows[0];
  if (!first) return { technique: null, fidelity: 0, reason: "aucun pas" };
  const lit = rows.flat().filter((c): c is Rgbw => !isOff(c));
  const distinct: Rgbw[] = [];
  for (const c of lit) if (!distinct.some((d) => close(d, c))) distinct.push(c);
  const block = Math.max(1, blockSize(first));
  const half = Math.ceil(first.length / 2);
  let candidate: Technique | null = null;
  switch (recognised) {
    case "plat":
      candidate = distinct[0] ? { kind: "plat", color: hex(distinct[0]) } : null;
      break;
    case "damier":
      if (distinct.length >= 2) candidate = { kind: "damier", colors: [hex(first[0] ?? distinct[0]!), hex(distinct.find((d) => !close(d, first[0] ?? null)) ?? distinct[1]!)], block };
      break;
    case "palette qui tourne": {
      // Palette order = colours of the successive blocks on the first step (left half if mirrored).
      const order: Rgbw[] = [];
      const span = mirror ? half : first.length;
      for (let i = 0; i < span; i += block) {
        const c = first[i];
        if (c && !isOff(c) && !order.some((o) => close(o, c))) order.push(c);
      }
      if (order.length >= 3) candidate = { kind: "palette", colors: order.map(hex), block };
      break;
    }
    case "creux qui tourne": {
      // Even blocks carry the first colour, odd blocks the second: read them from lit cells.
      const ofParity = (p: number) => rows.flat().find((c, k) => !isOff(c) && Math.floor((k % first.length) / block) % 2 === p) ?? null;
      const colors = [ofParity(0), ofParity(1)].filter((c): c is Rgbw => Boolean(c));
      const width = Math.max(1, Math.round(first.filter((c) => isOff(c)).length / block));
      if (colors.length) candidate = { kind: "creux", colors: [hex(colors[0]!), hex(colors[1] ?? colors[0]!)], block, width, floor: 0 };
      break;
    }
    case "masques": {
      const colors = distinct.slice(0, 2);
      const span = mirror ? half : first.length;
      const masks = rows.map((r) => {
        let m = "";
        for (let i = 0; i < span; i += block) m += isOff(r[i] ?? null) ? "-" : "#";
        return m;
      });
      if (colors.length) candidate = { kind: "masques", colors: [hex(colors[0]!), hex(colors[1] ?? colors[0]!)], block, masks, floor: 0 };
      break;
    }
    default:
      return { technique: null, fidelity: 0, reason: `pas de reconstruction pour « ${recognised} » : le look reste en pas exacts` };
  }
  if (!candidate) return { technique: null, fidelity: 0, reason: say("paramètres introuvables", "parameters not found") };
  // Try both mirror settings implicitly via the canvas topology passed in.
  const score = fidelity(steps, candidate, mirror);
  return { technique: candidate, fidelity: score, reason: score >= 0.9 ? say("fidèle", "faithful") : say(`fidélité ${Math.round(score * 100)} % : à vérifier`, `fidelity ${Math.round(score * 100)} %: to check`) };
}
