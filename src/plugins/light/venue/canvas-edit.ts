/**
 * Editing a canvas cell by cell (docs/specs/venue-fixtures-stage.md, « Éditer un canevas », T13). Pure:
 * no store, no venue; the command passes what it needs (a fixture's heads, the looks on the canvas).
 *
 * A canvas is an ordered list of cells, each driving 0..n fixture heads. Its `render` stores that as
 * cell ranges, which may overlap or leave holes (old imports): an edit flattens them to one target list
 * per cell, applies its operations, and writes the ranges back compacted (consecutive cells with the same
 * targets in one range). A canvas nobody edits is read as it is, never normalised.
 *
 * Looks read the cells by their position. Each cell of the result remembers where it came from
 * (`origin`): a look of exact steps (`pas`) whose columns no longer line up with the cells is broken
 * (shifted in silence: generateSteps trims or pads each row to the cell count), and the command refuses
 * the edit unless forced, or adapts its steps (`adaptSteps`: each column follows its cell).
 */
import { z } from "zod";
import { say } from "../../../core/lang.js";
import { CellTargetSchema, type Canvas } from "./venue.js";

export type CellTarget = { fixture: string; head: number };
type Range = Canvas["render"][number];

/** The most cells a canvas holds (CanvasSchema). */
export const MAX_CELLS = 4096;

const cellList = z.array(z.number().int().min(0)).min(1);
/** One editing operation. Cell indices are 0-based, read on the canvas as the previous operations left it. */
export const CanvasOpSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("add"),
      fixtures: z.array(z.string()).min(1),
      /** Only these heads of each fixture (a halo included); without it, one cell per full head as venue.canvas.auto does. */
      heads: z.array(z.number().int().min(-1)).min(1).optional(),
      /** Where the new cells go: before the cell of this index (the end when missing). */
      at: z.number().int().min(0).optional(),
    })
    .describe("adds one cell per head of each fixture, in the order given"),
  z.object({ op: z.literal("remove"), cells: cellList }).describe("removes these cells; the next ones move up"),
  z
    .object({ op: z.literal("move"), cells: cellList, to: z.number().int().min(0).describe("the gap the cells go into: before the cell of this index, counted before the move (the cell count: at the end)") })
    .describe("moves these cells (contiguous or not, their order kept) into one block"),
  z.object({ op: z.literal("reverse"), from: z.number().int().min(0).optional(), to: z.number().int().min(0).optional() }).describe("reverses the cells from..to (inclusive; all of them by default)"),
  z.object({ op: z.literal("duplicate"), cells: cellList }).describe("copies these cells, in order, right after the last of them"),
  z.object({ op: z.literal("retarget"), cells: cellList, targets: z.array(CellTargetSchema) }).describe("gives these cells other targets (none: a cell that drives nothing); the cell count does not change, no look is shifted"),
  z
    .object({ op: z.literal("set"), name: z.string().min(1).optional(), topology: z.enum(["line", "line-mirror", "ring", "grid", "free"]).optional(), columns: z.number().int().min(1).nullable().optional(), notes: z.string().optional() })
    .describe("name, topology, columns (grid; null clears it), notes"),
]);
export type CanvasOp = z.infer<typeof CanvasOpSchema>;

/**
 * What an edit needs of the venue (Venue.canvasHeads): a fixture's heads (`full`: those venue.canvas.auto gives
 * a cell; `all`: halo included), undefined for a fixture not in the patch; `error` when its definition cannot
 * be read (its heads are unknown).
 */
export interface EditContext {
  headsOf(fixture: string): { full: number[]; all: number[]; error?: string } | undefined;
}

/** The targets of each cell (index → targets), the way the engine reads them (venue.cellTargets): ranges past the end are cut. */
export function flatten(canvas: Pick<Canvas, "cells" | "render">): CellTarget[][] {
  const cells: CellTarget[][] = Array.from({ length: canvas.cells }, () => []);
  for (const r of canvas.render) for (let i = r.from; i <= Math.min(r.to, canvas.cells - 1); i++) cells[i]!.push(...r.targets.map((t) => ({ fixture: t.fixture, head: t.head })));
  return cells;
}

const keyOf = (targets: readonly CellTarget[]) => targets.map((t) => `${t.fixture}\u0000${t.head}`).join("\u0001");

/** Cell ranges back from the cells: consecutive cells with the same targets in one range; a cell that drives nothing has none. */
export function compact(cells: readonly (readonly CellTarget[])[]): Range[] {
  const out: Range[] = [];
  let last: string | undefined;
  cells.forEach((targets, i) => {
    const key = keyOf(targets);
    if (targets.length && key === last) out[out.length - 1]!.to = i;
    else if (targets.length) out.push({ from: i, to: i, targets: targets.map((t) => ({ ...t })) });
    last = targets.length ? key : undefined;
  });
  return out;
}

/** A cell of the canvas being edited: its targets and the cell of the original canvas it comes from (null: added). */
interface Cell {
  targets: CellTarget[];
  origin: number | null;
}

export interface Edited {
  canvas: Canvas;
  /** For each cell of the result, the cell of the original canvas it comes from (null for an added one; a duplicate names its source). */
  origin: (number | null)[];
  /** Whether the cells were touched at all (only `set`: the stored ranges are kept as they were). */
  cellsTouched: boolean;
}

const fail = (fr: string, en: string): never => {
  throw new Error(say(fr, en));
};

/** Applies the operations in order, all or nothing: the first one that cannot apply throws, naming it. */
export function applyOps(canvas: Canvas, ops: readonly CanvasOp[], ctx: EditContext): Edited {
  let cells: Cell[] = flatten(canvas).map((targets, i) => ({ targets, origin: i }));
  let touched = false;
  const meta: { name: string; topology: Canvas["topology"]; columns?: number; notes?: string } = { name: canvas.name, topology: canvas.topology, ...(canvas.columns !== undefined ? { columns: canvas.columns } : {}), ...(canvas.notes !== undefined ? { notes: canvas.notes } : {}) };
  const headsOf = (fixture: string) => ctx.headsOf(fixture) ?? fail(`projecteur inconnu : ${fixture}`, `unknown fixture: ${fixture}`);
  const checkTarget = (t: CellTarget) => {
    const heads = headsOf(t.fixture);
    if (t.head !== -1 && !heads.error && !heads.all.includes(t.head)) fail(`${t.fixture} n'a pas de tête ${t.head}`, `${t.fixture} has no head ${t.head}`);
  };
  ops.forEach((op, n) => {
    const where = say(`opération ${n + 1} (${op.op})`, `operation ${n + 1} (${op.op})`);
    const indices = (list: readonly number[]) => {
      const bad = list.find((i) => i >= cells.length);
      if (bad !== undefined) fail(`${where} : la cellule ${bad} n'existe pas (${cells.length} cellules)`, `${where}: cell ${bad} does not exist (${cells.length} cells)`);
      return [...new Set(list)].sort((a, b) => a - b);
    };
    const gap = (at: number | undefined) => {
      if (at !== undefined && at > cells.length) fail(`${where} : position ${at} au-delà de la fin (${cells.length} cellules)`, `${where}: position ${at} past the end (${cells.length} cells)`);
      return at ?? cells.length;
    };
    switch (op.op) {
      case "add": {
        const added: Cell[] = [];
        for (const fixture of op.fixtures) {
          const heads = headsOf(fixture);
          if (heads.error) fail(`${where} : ${heads.error}`, `${where}: ${heads.error}`);
          let chosen = heads.full;
          if (op.heads) {
            const missing = op.heads.filter((h) => h !== -1 && !heads.all.includes(h));
            if (missing.length) fail(`${where} : ${fixture} n'a pas de tête ${missing.join(", ")}`, `${where}: ${fixture} has no head ${missing.join(", ")}`);
            chosen = [...new Set(op.heads)];
          }
          if (!chosen.length) fail(`${where} : ${fixture} n'a que des têtes d'accent, qui n'ont pas de cellule (les nommer dans heads)`, `${where}: ${fixture} has accent heads only, which get no cell (name them in heads)`);
          for (const head of chosen) added.push({ targets: [{ fixture, head }], origin: null });
        }
        const at = gap(op.at);
        cells = [...cells.slice(0, at), ...added, ...cells.slice(at)];
        break;
      }
      case "remove": {
        const gone = new Set(indices(op.cells));
        cells = cells.filter((_, i) => !gone.has(i));
        break;
      }
      case "move": {
        const moved = indices(op.cells);
        const to = gap(op.to);
        const set = new Set(moved);
        const block = moved.map((i) => cells[i]!);
        const rest = cells.filter((_, i) => !set.has(i));
        const at = to - moved.filter((i) => i < to).length;
        const next = [...rest.slice(0, at), ...block, ...rest.slice(at)];
        if (next.every((c, i) => c === cells[i])) return; // dropped where they were: the stored ranges are kept
        cells = next;
        break;
      }
      case "reverse": {
        const from = op.from ?? 0;
        const to = op.to ?? cells.length - 1;
        indices([from, to]);
        if (from > to) fail(`${where} : début ${from} après la fin ${to}`, `${where}: start ${from} after end ${to}`);
        cells = [...cells.slice(0, from), ...cells.slice(from, to + 1).reverse(), ...cells.slice(to + 1)];
        break;
      }
      case "duplicate": {
        const list = indices(op.cells);
        const copies = list.map((i) => ({ targets: cells[i]!.targets.map((t) => ({ ...t })), origin: cells[i]!.origin }));
        const after = list[list.length - 1]! + 1;
        cells = [...cells.slice(0, after), ...copies, ...cells.slice(after)];
        break;
      }
      case "retarget": {
        const list = indices(op.cells);
        op.targets.forEach(checkTarget);
        for (const i of list) cells[i] = { ...cells[i]!, targets: op.targets.map((t) => ({ fixture: t.fixture, head: t.head })) };
        break;
      }
      case "set": {
        if (op.name !== undefined) meta.name = op.name;
        if (op.topology !== undefined) meta.topology = op.topology;
        if (op.columns === null) delete meta.columns;
        else if (op.columns !== undefined) meta.columns = op.columns;
        if (op.columns != null && op.columns > cells.length) fail(`${where} : ${op.columns} colonnes pour ${cells.length} cellules`, `${where}: ${op.columns} columns for ${cells.length} cells`);
        // a grid needs its columns: the nearest square until they are given
        if (op.topology === "grid" && meta.columns === undefined) meta.columns = Math.ceil(Math.sqrt(cells.length));
        if (op.notes !== undefined) meta.notes = op.notes;
        return; // the cells are left alone
      }
    }
    touched = true;
    if (cells.length < 1) fail(`${where} : un canevas garde au moins une cellule (le supprimer plutôt : venue.canvas.delete)`, `${where}: a canvas keeps at least one cell (delete it instead: venue.canvas.delete)`);
    if (cells.length > MAX_CELLS) fail(`${where} : ${cells.length} cellules, au-delà de ${MAX_CELLS}`, `${where}: ${cells.length} cells, more than ${MAX_CELLS}`);
  });
  const { columns: _c, notes: _n, ...base } = canvas;
  const out: Canvas = { ...base, ...meta, cells: cells.length, render: touched ? compact(cells.map((c) => c.targets)) : canvas.render };
  return { canvas: out, origin: cells.map((c) => c.origin), cellsTouched: touched };
}

/** Whether the cells kept their place: the same count, each cell from the same index. */
export function inPlace(origin: readonly (number | null)[], before: number): boolean {
  return origin.length === before && origin.every((o, i) => o === i);
}

/**
 * Whether a whole canvas put over another moves cells (venue.canvas.put, a restore: nothing says where each
 * cell went). The count changes, or a cell now holds what another changed cell held (the same cells in
 * another order). A cell given targets no changed cell had is aimed elsewhere, not moved: no look shifts.
 */
export function putMoves(before: Pick<Canvas, "cells" | "render">, after: Pick<Canvas, "cells" | "render">): boolean {
  if (before.cells !== after.cells) return true;
  const [was, now] = [flatten(before).map(keyOf), flatten(after).map(keyOf)];
  const changed = was.flatMap((k, i) => (k === now[i] ? [] : [i]));
  const left = new Set(changed.map((i) => was[i]!));
  return changed.some((i) => left.has(now[i]!));
}

/** A look as the impact reads it. */
export interface LookOnCanvas {
  id: string;
  name: string;
  /** The look's own mirror, over the canvas's topology. */
  mirror?: boolean | undefined;
  technique: { kind: string; steps?: unknown; masks?: unknown; patterns?: unknown; block?: unknown; map?: unknown; colors?: unknown };
}
/** What of a canvas the looks read: its cell count, and whether it mirrors (line-mirror). */
export type CanvasShape = Pick<Canvas, "cells" | "topology">;
const mirrors = (l: LookOnCanvas, c: CanvasShape) => l.mirror ?? c.topology === "line-mirror";

/** Techniques that paint every cell alike: the cell count changes nothing in them. */
const UNIFORM = new Set(["plat", "flash", "aucune"]);

/** The rows a technique stores as they are: the steps of « pas » (one array per step), the masks or patterns of the mask techniques (one string per step). */
export type LookRows = string[][] | string[];
const strip = (m: string) => m.replace(/\s/g, "");
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The rows of a look that the engine reads cell by cell (generateSteps): one entry per cell, null for a row
 * read otherwise (a mask per block), left alone. « pas »: every step. « masques »: a mask at least as long as
 * the span (half the cells when mirrored: such a mask cannot follow its cells, `adaptable` false).
 * « masques-colores »: with blocks of one cell, a pattern at least as long as the canvas. Undefined: the look
 * generates its pattern, nothing in it names a cell.
 */
export function exactRows(l: LookOnCanvas, canvas: CanvasShape): { rows: (string[] | null)[]; fill: string; adaptable: boolean } | undefined {
  const t = l.technique;
  if (t.kind === "pas" && Array.isArray(t.steps)) return { rows: t.steps as string[][], fill: "", adaptable: true };
  const mirror = mirrors(l, canvas);
  if (t.kind === "masques") {
    const span = mirror ? Math.ceil(canvas.cells / 2) : canvas.cells;
    const rows = strings(t.masks).map((m) => (strip(m).length >= span ? [...strip(m)] : null));
    return rows.some(Boolean) ? { rows, fill: "-", adaptable: !mirror } : undefined;
  }
  if (t.kind === "masques-colores" && (t.block ?? 4) === 1) {
    const rows = strings(t.patterns).map((p) => (strip(p).length >= canvas.cells ? [...strip(p)] : null));
    const map = (t.map ?? {}) as Record<string, unknown>;
    // a letter without a colour is off: the cell added shows nothing
    const fill = ["-", ".", "_", "0"].find((c) => !map[c]) ?? "-";
    return rows.some(Boolean) ? { rows, fill, adaptable: true } : undefined;
  }
  return undefined;
}

/** A look's rows as its technique stores them (LookRows): undefined for a technique without any. */
export function rowsOfTechnique(t: LookOnCanvas["technique"]): LookRows | undefined {
  if (t.kind === "pas" && Array.isArray(t.steps)) return t.steps as string[][];
  if (t.kind === "masques") return strings(t.masks);
  if (t.kind === "masques-colores") return strings(t.patterns);
  return undefined;
}

/** A technique with other rows (its steps, masks or patterns): refused when the rows are not of its kind. */
export function withRows<T extends { kind: string }>(technique: T, rows: LookRows): T {
  const perStep = rows.every((r) => Array.isArray(r));
  const perMask = rows.every((r) => typeof r === "string");
  if (technique.kind === "pas" && perStep && rows.length) return { ...technique, steps: rows };
  if (technique.kind === "masques" && perMask && rows.length) return { ...technique, masks: rows };
  if (technique.kind === "masques-colores" && perMask && rows.length) return { ...technique, patterns: rows };
  return fail(`ces pas ne vont pas à la technique ${technique.kind}`, `these steps do not fit technique ${technique.kind}`);
}

/** Whether every row of a look of exact steps has one column per cell. */
export const fits = (rows: readonly (readonly string[])[], cells: number): boolean => rows.every((r) => r.length === cells);

/** A look's exact steps following their cells: each column goes where its cell went; a removed cell's column goes, an added cell is left untouched (""), a duplicate copies its source. */
export function adaptSteps(rows: readonly (readonly string[])[], origin: readonly (number | null)[], fill = ""): string[][] {
  return rows.map((row) => origin.map((o) => (o === null ? fill : (row[o] ?? fill))));
}

/**
 * A look's rows following their cells (adaptSteps), as its technique stores them: undefined when nothing in
 * it is read by cell, or when it cannot follow (a mirrored mask).
 */
export function adaptLook(l: LookOnCanvas, before: CanvasShape, origin: readonly (number | null)[]): LookRows | undefined {
  const exact = exactRows(l, before);
  if (!exact?.adaptable) return undefined;
  if (l.technique.kind === "pas") return adaptSteps(exact.rows as string[][], origin);
  const stored = rowsOfTechnique(l.technique) as string[];
  return exact.rows.map((r, i) => (r ? adaptSteps([r], origin, exact.fill)[0]!.join("") : stored[i]!));
}

/** Rows as colours a screen can paint (hex, "-" off, "" untouched): the steps of « pas » as they are, a mask's letters as the colours they light. */
export function paintedRows(l: LookOnCanvas, rows: LookRows): string[][] {
  const t = l.technique;
  if (t.kind === "pas") return rows as string[][];
  const colors = strings(t.colors);
  const block = typeof t.block === "number" ? t.block : 4;
  const map = (t.map ?? {}) as Record<string, string | null>;
  return (rows as string[]).map((m) => [...strip(m)].map((c, k) => (t.kind === "masques" ? (c === "-" ? "-" : (colors[Math.floor(k / block) % 2] ?? "#ffffff")) : (map[c] ?? "-"))));
}

export interface AffectedLook {
  id: string;
  name: string;
  technique: string;
  /** steps: exact steps (or a mask per cell) whose columns no longer line up with the cells (refused unless forced or adapted); cells: a generated pattern that changes proportion (still plays). */
  reason: "steps" | "cells";
}

export interface Impact {
  cellsBefore: number;
  cellsAfter: number;
  /** Some cell is no longer where it was (added, removed, moved). */
  shifted: boolean;
  looksAffected: AffectedLook[];
}

/**
 * What a change does to the looks on the canvas. `origin`: an edit, which knows where each cell went.
 * `moved`: a whole canvas put over the old one (venue.canvas.put, a restore), compared cell by cell
 * (putMoves); there a look of exact steps is broken only when it fitted the old canvas (one already out of
 * line is not this change's doing; « Vérifier le show » says it).
 */
export function impactOf(before: CanvasShape, after: CanvasShape, how: { origin: readonly (number | null)[] } | { moved: boolean }, looks: readonly LookOnCanvas[]): Impact {
  const shifted = "origin" in how ? !inPlace(how.origin, before.cells) : how.moved;
  const looksAffected: AffectedLook[] = [];
  for (const l of looks) {
    const kind = l.technique.kind;
    const exact = exactRows(l, before);
    const outOfLine = !("origin" in how) && kind === "pas" && !fits(exact!.rows as string[][], before.cells);
    // a generated pattern follows the cell count, and the mirror folds it in two
    const generated = !UNIFORM.has(kind) && (before.cells !== after.cells || (kind !== "pas" && mirrors(l, before) !== mirrors(l, after)));
    if (exact && shifted) {
      if (!outOfLine) looksAffected.push({ id: l.id, name: l.name, technique: kind, reason: "steps" });
    } else if (generated && kind !== "pas") looksAffected.push({ id: l.id, name: l.name, technique: kind, reason: "cells" });
  }
  return { cellsBefore: before.cells, cellsAfter: after.cells, shifted, looksAffected };
}

/**
 * The refusal of a change that breaks looks of exact steps, naming them; the shows sharing the venue are
 * named too. `edit`: venue.canvas.edit can adapt their steps itself; a put, a restore or an undo cannot
 * (nothing says where each cell went), and says how to get there.
 */
export function impactMessage(name: string, broken: readonly AffectedLook[], sharedWith: readonly string[] = [], edit = true): string {
  const looks = broken.slice(0, 6).map((l) => say(`« ${l.name} »`, `“${l.name}”`)).join(", ");
  const more = broken.length > 6 ? say(` et ${broken.length - 6} autre(s)`, ` and ${broken.length - 6} more`) : "";
  const parts: string[] = [];
  if (broken.length)
    parts.push(
      say(`les pas de ${broken.length > 1 ? "ces looks" : "ce look"} ne seraient plus en face de leurs cellules : ${looks}${more}. `, `the steps of ${broken.length > 1 ? "these looks" : "this look"} would no longer line up with their cells: ${looks}${more}. `) +
        (edit
          ? say("Adapter leurs pas (adapt: true) ou le faire quand même (force: true)", "Adapt their steps (adapt: true) or do it anyway (force: true)")
          : say(
              "Donner leurs pas avec le canevas (steps), déplacer les cellules par venue.canvas.edit (adapt: true adapte leurs pas), ou le faire quand même (force: true)",
              "Give their steps with the canvas (steps), move the cells with venue.canvas.edit (adapt: true adapts their steps), or do it anyway (force: true)",
            )),
    );
  if (sharedWith.length)
    parts.push(
      say(
        `ce lieu est partagé avec d'autres shows (${sharedWith.join(", ")}), dont les looks ne sont pas vérifiés : le faire en le sachant (shared: true)`,
        `this venue is shared with other shows (${sharedWith.join(", ")}), whose looks are not checked: do it knowingly (shared: true)`,
      ),
    );
  return say(`Canevas « ${name} » : `, `Canvas “${name}”: `) + parts.join(say(" ; ", "; "));
}

/** One problem of a canvas: level as « Vérifier le show » has them. */
export interface CanvasProblem {
  level: "attention" | "info";
  message: string;
}

/**
 * The integrity of a canvas, for a put (warnings, never a refusal: an import or an archive may name a fixture
 * not patched yet) and « Vérifier le show »: ranges reversed or past the end, fixtures not in the patch, heads a
 * fixture does not have, cells that drive nothing, one head driven by several cells.
 */
export function canvasProblems(canvas: Pick<Canvas, "cells" | "render">, ctx: EditContext): CanvasProblem[] {
  const out: CanvasProblem[] = [];
  for (const r of canvas.render) {
    if (r.from > r.to) out.push({ level: "attention", message: say(`plage ${r.from}–${r.to} à l'envers : elle ne rend rien`, `range ${r.from}–${r.to} is reversed: it renders nothing`) });
    else if (r.to >= canvas.cells) out.push({ level: "attention", message: say(`plage ${r.from}–${r.to} au-delà des ${canvas.cells} cellules`, `range ${r.from}–${r.to} past the ${canvas.cells} cells`) });
  }
  const unknown = new Set<string>();
  const noHead = new Set<string>();
  for (const t of canvas.render.flatMap((r) => r.targets)) {
    const heads = ctx.headsOf(t.fixture);
    if (!heads) unknown.add(t.fixture);
    else if (t.head !== -1 && !heads.error && !heads.all.includes(t.head)) noHead.add(`${t.fixture} (${t.head})`);
  }
  if (unknown.size) out.push({ level: "attention", message: say(`projecteur absent du patch : ${[...unknown].join(", ")}`, `fixture not in the patch: ${[...unknown].join(", ")}`) });
  if (noHead.size) out.push({ level: "attention", message: say(`tête inexistante : ${[...noHead].join(", ")}`, `no such head: ${[...noHead].join(", ")}`) });
  const cells = flatten(canvas);
  const empty = cells.flatMap((c, i) => (c.length ? [] : [i]));
  if (empty.length) out.push({ level: "info", message: say(`${empty.length} cellule(s) sans rendu (${listCells(empty)})`, `${empty.length} cell(s) render nothing (${listCells(empty)})`) });
  const seen = new Map<string, number>();
  const twice = new Set<string>();
  cells.forEach((c, i) => {
    for (const t of c) {
      if (t.head === -1) continue; // a whole fixture spread over a few cells is an old, common way to write it
      const key = `${t.fixture} (${t.head})`;
      const at = seen.get(key);
      if (at !== undefined && at !== i) twice.add(key);
      seen.set(key, i);
    }
  });
  if (twice.size) out.push({ level: "info", message: say(`même tête sur plusieurs cellules (la dernière l'emporte) : ${[...twice].join(", ")}`, `one head on several cells (the last one wins): ${[...twice].join(", ")}`) });
  return out;
}

/** « 0, 1, 2, 5 » → « 1–3, 6 » (1-based, as a person counts cells). */
function listCells(list: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < list.length; i++) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j]! + 1) j++;
    parts.push(i === j ? `${list[i]! + 1}` : `${list[i]! + 1}–${list[j]! + 1}`);
    i = j;
  }
  return parts.length > 8 ? `${parts.slice(0, 8).join(", ")}…` : parts.join(", ");
}

/**
 * « Vérifier le show » on the canvases: each canvas's problems (canvasProblems), and the looks of exact steps
 * whose rows do not have one column per cell (a canvas changed under them with force, an import): their extra
 * columns are dropped, the missing cells left untouched.
 */
export function canvasIssues(canvases: readonly Canvas[], looks: readonly (LookOnCanvas & { canvas: string })[], ctx: EditContext): { level: CanvasProblem["level"]; where: string; message: string }[] {
  const out: { level: CanvasProblem["level"]; where: string; message: string }[] = [];
  for (const c of canvases) for (const p of canvasProblems(c, ctx)) out.push({ level: p.level, where: say(`canevas ${c.id}`, `canvas ${c.id}`), message: p.message });
  const byId = new Map(canvases.map((c) => [c.id, c]));
  for (const l of looks) {
    const canvas = byId.get(l.canvas);
    const rows = l.technique.kind === "pas" && Array.isArray(l.technique.steps) ? (l.technique.steps as string[][]) : undefined;
    if (!rows || !canvas || fits(rows, canvas.cells)) continue;
    const lengths = [...new Set(rows.map((r) => r.length))].sort((a, b) => a - b).join("/");
    out.push({
      level: "attention",
      where: `look ${l.id}`,
      message: say(
        `pas de longueur ${lengths} sur un canevas de ${canvas.cells} cellules (« ${canvas.name} ») : les colonnes en trop sont ignorées, les cellules sans colonne restent non touchées`,
        `steps of length ${lengths} on a canvas of ${canvas.cells} cells (“${canvas.name}”): extra columns are ignored, cells without a column are left untouched`,
      ),
    });
  }
  return out;
}
