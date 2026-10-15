/**
 * Analysis of an imported QLC+ workspace, first step of "import then rebuild"
 * (docs/specs/presets-songs-notes.md): decode each sequence step into per-cell colours, extract
 * palettes, measure attack (fade / duration) and guess which parametric technique it is.
 * Pure: works on the parsed workspace and fixture definitions.
 */
import type { QxwFixture, QxwFunction, QxwStep, QxwWorkspace } from "./qxw-import.js";
import { findDefinition, findMode, type ColorComponent, type FixtureDefinition } from "../venue/qxf-import.js";

export interface Cell {
  fixtureId: number;
  head: number; // -1 when the fixture has no heads (single cell)
  /** channel offset per colour component */
  colors: Partial<Record<ColorComponent, number>>;
}

export type Rgbw = [number, number, number, number];

export type Technique = "plat" | "respiration" | "damier" | "palette qui tourne" | "creux qui tourne" | "masques" | "masques colorés" | "orage" | "séquence libre";

export interface SequenceAnalysis {
  id: number;
  name: string;
  steps: number;
  runOrder: string;
  /** fadeIn / (fadeIn + hold) per step, QLC+ semantics duration = fadeIn + hold */
  attack: number;
  attackLabel: "claque" | "intermédiaire" | "respire";
  stepMs: number;
  colors: string[]; // distinct hex colours, most used first
  hasBlackCells: boolean;
  duplicateStepRatio: number;
  technique: Technique;
  confidence: "haute" | "moyenne" | "basse";
}

export interface WorkspaceAnalysis {
  cells: Cell[];
  missingDefinitions: string[];
  sequences: SequenceAnalysis[];
  palettes: { colors: string[]; usedBy: number }[];
  midi: { caption: string; binding: string; soloFrame?: number }[];
}

export function cellsFor(ws: QxwWorkspace, defs: FixtureDefinition[]): { cells: Cell[]; missing: string[] } {
  const cells: Cell[] = [];
  const missing = new Set<string>();
  for (const fx of ws.fixtures) {
    const def = findDefinition(defs, fx.manufacturer, fx.model);
    const mode = def ? findMode(def, fx.mode, fx.channels) : undefined;
    if (!def || !mode) {
      missing.add(`${fx.manufacturer} ${fx.model} (${fx.mode})`);
      continue;
    }
    const colorOf = (offset: number) => def.channels.get(mode.channels[offset] ?? "")?.color;
    if (mode.heads.length > 0) {
      mode.heads.forEach((head, h) => {
        const colors: Cell["colors"] = {};
        for (const off of head) {
          const c = colorOf(off);
          if (c) colors[c] = off;
        }
        if (Object.keys(colors).length > 0) cells.push({ fixtureId: fx.id, head: h, colors });
      });
    } else {
      const colors: Cell["colors"] = {};
      mode.channels.forEach((_, off) => {
        const c = colorOf(off);
        if (c && colors[c] === undefined) colors[c] = off;
      });
      if (Object.keys(colors).length > 0) cells.push({ fixtureId: fx.id, head: -1, colors });
    }
  }
  return { cells, missing: [...missing] };
}

/**
 * Per-cell colours of a step. `writtenFixtures` lists the fixtures the sequence drives: QLC+ drops
 * zero values from steps when saving, so a missing value of a driven fixture means 0 (off).
 */
export function stepColors(step: QxwStep, cells: Cell[], writtenFixtures?: Set<number>): (Rgbw | null)[] {
  return cells.map((cell) => {
    const vals = step.values.get(cell.fixtureId);
    if (!vals && !writtenFixtures?.has(cell.fixtureId)) return null; // not driven by this function
    const get = (c: ColorComponent) => (cell.colors[c] !== undefined ? (vals?.get(cell.colors[c]!) ?? 0) : 0);
    return [get("red"), get("green"), get("blue"), get("white")];
  });
}

const hex = (c: Rgbw): string => "#" + c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("") + (c[3] ? `+w${c[3]}` : "");
const isBlack = (c: Rgbw): boolean => c.every((v) => v < 8);

function attackOf(fn: QxwFunction, step: QxwStep): { fade: number; total: number } {
  const common = (mode: string | undefined) => mode === undefined || mode === "Common";
  const fade = common(fn.speedModes?.fadeIn) ? fn.speed.fadeIn : step.fadeIn;
  const total = common(fn.speedModes?.duration) ? fn.speed.duration : step.fadeIn + step.hold;
  return { fade, total: Math.max(total, 1) };
}



/** Hue class of a colour: "off", "white", or one of 24 hue buckets of 15°. */
export function colorClass(c: Rgbw | null, stepMax: number): string {
  if (!c) return "-";
  const [r, g, b, w] = c;
  const max = Math.max(r, g, b, w);
  if (max < 20 || max < stepMax * 0.3) return "off";
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sat = mx === 0 ? 0 : (mx - mn) / mx;
  if (sat < 0.25) return "white";
  let h = 0;
  if (mx === r) h = ((g - b) / (mx - mn)) % 6;
  else if (mx === g) h = (b - r) / (mx - mn) + 2;
  else h = (r - g) / (mx - mn) + 4;
  const deg = (h * 60 + 360) % 360;
  return `h${Math.floor(deg / 15)}`;
}

function rotates(a: string[], b: string[]): boolean {
  if (a.length < 3 || a.join() === b.join()) return false;
  for (let s = 1; s < a.length; s++) if (a.every((x, i) => x === b[(i + s) % a.length])) return true;
  return false;
}

/** The off cells of a row as one circular window (wrapping around the wall), or null. */
function circularOffWindow(row: string[]): { start: number; width: number } | null {
  const n = row.length;
  const off = row.map((c) => c === "off");
  const count = off.filter(Boolean).length;
  if (count === 0 || count === n) return null;
  for (let start = 0; start < n; start++) {
    if (!off[start] || off[(start - 1 + n) % n]) continue; // window starts after a lit cell
    let w = 0;
    while (w < n && off[(start + w) % n]) w++;
    return w === count ? { start, width: w } : null;
  }
  return null;
}

/**
 * Palette shift: from one step to the next, every cell moves to "the next colour" of one cycle
 * (block b = palette[(b + step) % n]). Votes colour→colour transitions, ignores cells that keep
 * their colour (edge accents), and accepts when the majority mapping covers ≥ 80 % of the changing
 * cells and forms a cycle of at least 3 hues.
 */
function paletteShift(rows: string[][]): boolean {
  const votes = new Map<string, Map<string, number>>();
  let changing = 0;
  for (let i = 0; i + 1 < rows.length; i++) {
    for (let k = 0; k < rows[i]!.length; k++) {
      const a = rows[i]![k]!;
      const b = rows[i + 1]![k]!;
      if (a === b || a === "-" || b === "-" || a === "off" || b === "off") continue;
      changing += 1;
      const m = votes.get(a) ?? new Map<string, number>();
      m.set(b, (m.get(b) ?? 0) + 1);
      votes.set(a, m);
    }
  }
  if (changing === 0) return false;
  const next = new Map<string, string>();
  let agreeing = 0;
  for (const [a, m] of votes) {
    const [b, n] = [...m.entries()].sort((x, y) => y[1] - x[1])[0]!;
    next.set(a, b);
    agreeing += n;
  }
  if (agreeing / changing < 0.8 || next.size < 3) return false;
  const start = next.keys().next().value as string;
  let cur = start;
  for (let n = 1; n <= next.size; n++) {
    cur = next.get(cur) ?? "";
    if (cur === start) return n >= 3;
  }
  return false;
}

function classify(decoded: (Rgbw | null)[][], runOrder: string, dupRatio: number, attack: number): { technique: Technique; confidence: SequenceAnalysis["confidence"] } {
  const rows = decoded.map((step) => {
    const stepMax = Math.max(0, ...step.map((c) => (c ? Math.max(...c) : 0)));
    return step.map((c) => colorClass(c, stepMax));
  });
  // Step 0 is often the soft full-wall entry: judge the loop on the following steps.
  const loop = rows.length > 2 ? rows.slice(1) : rows;
  const distinct = new Set(loop.map((r) => r.join("|"))).size;
  const lit = loop.flat().filter((c) => c !== "off" && c !== "-");
  const hueCount = new Map<string, number>();
  for (const c of lit) hueCount.set(c, (hueCount.get(c) ?? 0) + 1);
  const hues = [...hueCount.entries()].sort((x, y) => y[1] - x[1]);
  const offFraction = loop.map((r) => r.filter((c) => c === "off").length / Math.max(1, r.length));
  const hasOff = offFraction.some((f) => f > 0.1);

  if (runOrder === "Random" && dupRatio >= 0.4) return { technique: "orage", confidence: "moyenne" };
  if (distinct <= 1) {
    const exact = new Set(decoded.map((s) => s.map((c) => (c ? c.join(",") : "-")).join("|"))).size;
    return exact <= 1 ? { technique: "plat", confidence: "haute" } : { technique: "respiration", confidence: "moyenne" };
  }
  if (hasOff) {
    // Creux qui tourne: in every step the off cells form ONE circular window of constant width.
    const windows = loop.map((r) => circularOffWindow(r));
    if (windows.every((w) => w !== null) && new Set(windows.map((w) => w!.width)).size === 1 && new Set(windows.map((w) => w!.start)).size > 1) {
      return { technique: "creux qui tourne", confidence: "haute" };
    }
    // ON/OFF masks keep each lit cell on the same colour; coloured masks repaint the cells.
    const perCell = loop[0]!.map((_, k) => new Set(loop.map((r) => r[k]).filter((c) => c !== "off" && c !== "-")).size);
    const constantColours = perCell.filter((n) => n <= 1).length / perCell.length >= 0.85;
    return constantColours ? { technique: "masques", confidence: "haute" } : { technique: "masques colorés", confidence: "moyenne" };
  }
  const half = Math.floor(loop[0]!.length / 2);
  const rotation =
    hues.length >= 3 &&
    (paletteShift(loop) || loop.slice(1).some((row, i) => rotates(loop[i]!, row) || rotates(loop[i]!.slice(0, half), row.slice(0, half))));
  if (rotation) return { technique: "palette qui tourne", confidence: "haute" };
  const top2 = hues.slice(0, 2).reduce((a, [, n]) => a + n, 0) / Math.max(1, lit.length);
  if (hues.length >= 2 && top2 >= 0.65) {
    const swaps = loop.slice(1).every((row, i) => row.filter((c, k) => c !== loop[i]![k]).length >= row.length * 0.4);
    if (swaps) return { technique: "damier", confidence: "haute" };
  }
  if (attack > 0.7) return { technique: "respiration", confidence: "moyenne" };
  // Several hues repainted without a consistent shift: coloured masks without black blocks.
  if (hues.length >= 3) return { technique: "masques colorés", confidence: "basse" };
  return { technique: "séquence libre", confidence: "basse" };
}

export function analyzeSequence(fn: QxwFunction, cells: Cell[]): SequenceAnalysis {
  const written = new Set<number>(fn.steps.flatMap((s) => [...s.values.keys()]));
  const decoded = fn.steps.map((s) => stepColors(s, cells, written));
  const counts = new Map<string, number>();
  const representative = new Map<string, { color: Rgbw; count: number }>();
  let hasBlack = false;
  for (const step of decoded)
    for (const c of step) {
      if (!c) continue;
      if (isBlack(c)) {
        hasBlack = true;
        continue;
      }
      counts.set(hex(c), (counts.get(hex(c)) ?? 0) + 1);
      // Palette colour of the hue class: its brightest occurrence (gradients and masks dim it).
      const cls = colorClass(c, 0);
      const best = representative.get(cls);
      if (!best || Math.max(...c) > Math.max(...best.color)) representative.set(cls, { color: c, count: (best?.count ?? 0) + 1 });
      else best.count += 1;
    }
  const colors = [...representative.values()].sort((a, b) => b.count - a.count).map((r) => hex(r.color));
  const signatures = decoded.map((s) => s.map((c) => (c ? hex(c) : "-")).join("|"));
  const distinctSteps = new Set(signatures).size;
  const duplicateStepRatio = fn.steps.length ? 1 - distinctSteps / fn.steps.length : 0;
  // Ignore an entry step 0 (long fade, used as "pas 0 d'entrée") for the attack of the loop.
  const loopSteps = fn.steps.length > 1 ? fn.steps.slice(1) : fn.steps;
  const ratios = loopSteps.map((s) => {
    const a = attackOf(fn, s);
    return Math.min(1, a.fade / a.total);
  });
  const attack = ratios.length ? ratios.reduce((x, y) => x + y, 0) / ratios.length : 0;
  const stepMs = loopSteps.length ? loopSteps.map((s) => attackOf(fn, s).total).reduce((x, y) => x + y, 0) / loopSteps.length : 0;
  const runOrder = fn.runOrder ?? "Loop";

  const { technique, confidence } = classify(decoded, runOrder, duplicateStepRatio, attack);
  return {
    id: fn.id,
    name: fn.name,
    steps: fn.steps.length,
    runOrder,
    attack,
    attackLabel: attack < 0.2 ? "claque" : attack > 0.8 ? "respire" : "intermédiaire",
    stepMs,
    colors,
    hasBlackCells: hasBlack,
    duplicateStepRatio,
    technique,
    confidence,
  };
}

function describeBinding(b: NonNullable<QxwWorkspace["widgets"][number]["input"]>["midi"]): string {
  switch (b.kind) {
    case "note":
      return `note ${b.note} (canal ${b.channel})`;
    case "cc":
      return `CC ${b.controller} (canal ${b.channel})`;
    case "programchange":
      return `PC ${b.program} (canal ${b.channel})`;
    case "polyaftertouch":
      return `aftertouch note ${b.note}`;
    case "clock":
      return `horloge MIDI (${b.what})`;
    default:
      return `canal QLC+ ${b.raw}`;
  }
}

export function analyzeWorkspace(ws: QxwWorkspace, defs: FixtureDefinition[]): WorkspaceAnalysis {
  const { cells, missing } = cellsFor(ws, defs);
  const sequences = [...ws.functions.values()].filter((f) => f.type === "Sequence" || (f.type === "Scene" && f.steps.length > 0)).map((f) => analyzeSequence(f, cells));
  const paletteCounts = new Map<string, number>();
  for (const s of sequences) {
    if (s.colors.length === 0) continue;
    const key = [...s.colors].sort().join(" ");
    paletteCounts.set(key, (paletteCounts.get(key) ?? 0) + 1);
  }
  const palettes = [...paletteCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ colors: k.split(" "), usedBy: n }));
  const midi = ws.widgets.filter((w) => w.input).map((w) => ({ caption: w.caption, binding: describeBinding(w.input!.midi), soloFrame: w.soloFrame }));
  return { cells, missingDefinitions: missing, sequences, palettes, midi };
}

export type { QxwFixture };
