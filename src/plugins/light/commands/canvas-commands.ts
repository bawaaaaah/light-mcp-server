/**
 * Canvases: read, put, edit, delete; every write over an existing canvas checks what it does to the looks on it (venue/canvas-edit.ts).
 * Part of the show commands (show-commands.ts registers them all, with the scope they share: show-command-scope.ts).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { CommandError } from "./registry.js";
import { CanvasSchema, type Canvas } from "../venue/venue.js";
import { adaptLook, applyOps, CanvasOpSchema, canvasProblems, fits, impactMessage, impactOf, paintedRows, putMoves, rowsOfTechnique, withRows, type AffectedLook, type CanvasOp, type EditContext, type Impact, type LookRows } from "../venue/canvas-edit.js";
import type { Look } from "../show/model.js";
import { stableStringify } from "../data/store.js";
import { say } from "../../../core/lang.js";
import type { ShowCommandScope } from "./show-command-scope.js";
import type { LookCommands } from "./look-commands.js";

/** How a canvas write is let through: `force` whatever it breaks, `shared` knowing the venue's other shows are not checked. */
export interface Passes {
  force: boolean;
  shared: boolean;
}

/** A look of exact steps a canvas edit can adapt: its first rows before and after, painted, and all of them as stored. */
export interface AdaptableLook {
  id: string;
  name: string;
  rows: number;
  before: string[][];
  after: string[][];
  stored: { before: LookRows; after: LookRows };
}

/** What the canvas commands lend the stage, history and proposal commands: a canvas write checked as venue.canvas.put checks it. */
export interface CanvasCommands {
  checkCanvasPut: (canvas: Canvas, rows: ReadonlyMap<string, LookRows>, pass: Passes, how?: "put" | "restore") => void;
  looksOn: (canvasId: string) => Look[];
  planEdit: (current: Canvas, ops: CanvasOp[]) => { canvas: Canvas; impact: Impact; broken: AffectedLook[]; adaptable: AdaptableLook[] };
  putCanvas: (value: unknown, opts: Passes & { steps?: Record<string, LookRows>; revision?: string | undefined; how?: "put" | "restore" }) => Promise<Canvas & { warnings?: string[] | undefined; revision: string }>;
  refuseUnlessPassed: (name: string, impact: Impact, broken: AffectedLook[], pass: Passes, how: "edit" | "put" | "restore", adaptable?: { id: string }[]) => void;
  revisionOf: (canvas: Canvas) => string;
  sameRevision: (i: string, current: Canvas | undefined, revision: string | undefined) => void;
  sharedFlag: z.ZodDefault<z.ZodBoolean>;
  unknownCanvas: (i: string) => CommandError;
}

export function registerCanvasCommands(common: ShowCommandScope, { checkLook }: Pick<LookCommands, "checkLook">): CanvasCommands {
  const { reg, show, sharedWith, venue, idSchema, removable, canvasDeletable } = common;
  // ---- canvases: every write over an existing canvas checks what it does to the looks on it (venue/canvas-edit.ts)
  const canvasCtx: EditContext = { headsOf: (f) => venue.canvasHeads(f) };
  const looksOn = (canvasId: string) => show.looks.list().filter((l) => l.canvas === canvasId);
  const unknownCanvas = (i: string) => new CommandError("failed", say(`canevas inconnu : ${i}`, `unknown canvas: ${i}`), { unknown: "canvas" });
  /** The other shows on the venue, for a change that moves cells (their looks are not checked); one that cannot be read counts. */
  const othersOnVenue = (): string[] => {
    try {
      return sharedWith();
    } catch (err) {
      return [say(`autres shows illisibles (${(err as Error).message})`, `other shows unreadable (${(err as Error).message})`)];
    }
  };
  /** First rows of a look's steps, before and after an adaptation: enough to see it, not a whole imported look. */
  const PREVIEW_ROWS = 8;
  const revisionOf = (canvas: Canvas) => createHash("sha1").update(stableStringify(canvas)).digest("hex").slice(0, 12);
  /** Refused when the canvas is not the one an earlier answer gave: changed elsewhere (`detail.stale`), or gone (`detail.unknown`). */
  const sameRevision = (i: string, current: Canvas | undefined, revision: string | undefined) => {
    if (revision === undefined) return;
    if (!current) throw unknownCanvas(i);
    if (revision !== revisionOf(current)) throw new CommandError("failed", say(`le canevas « ${current.name} » a changé ailleurs depuis : le recharger`, `canvas “${current.name}” changed elsewhere since: reload it`), { stale: true, revision: revisionOf(current) });
  };
  const warningsOf = (canvas: Canvas) =>
    canvasProblems(canvas, canvasCtx)
      .filter((p) => p.level === "attention")
      .map((p) => p.message);
  /**
   * Refuses a change that breaks looks of exact steps (unless forced) or moves cells of a shared venue (unless
   * forced or `shared`); `detail.impact` lets a screen ask. The other shows are read only when they matter.
   */
  const refuseUnlessPassed = (name: string, impact: Impact, broken: AffectedLook[], pass: Passes, how: "edit" | "put" | "restore", adaptable: { id: string }[] = []) => {
    if (pass.force) return;
    const others = impact.shifted && !pass.shared ? othersOnVenue() : [];
    if (!broken.length && !others.length) return;
    // only the looks still broken can be adapted: one already adapted is not offered again
    const can = adaptable.filter((a) => broken.some((l) => l.id === a.id));
    throw new CommandError("invalid", impactMessage(name, broken, others, how, new Set(can.map((a) => a.id))), { impact, broken: broken.map((l) => l.id), shared: others, adaptable: can });
  };
  /** What an edit would do: the canvas, its impact, the looks it breaks and how their rows would follow. */
  const planEdit = (current: Canvas, ops: CanvasOp[]) => {
    const edited = applyOps(current, ops, canvasCtx);
    const canvas = venue.canvases.parse(edited.canvas);
    const impact = impactOf(current, canvas, { origin: edited.origin }, looksOn(current.id));
    const broken = impact.looksAffected.filter((l) => l.reason === "steps");
    const adaptable = broken.flatMap((a) => {
      const look = show.looks.get(a.id);
      const before = look && rowsOfTechnique(look.technique);
      const after = look && adaptLook(look, current, edited.origin);
      if (!look || !before || !after) return [];
      return [{ id: a.id, name: a.name, rows: before.length, before: paintedRows(look, before.slice(0, PREVIEW_ROWS) as LookRows), after: paintedRows(look, after.slice(0, PREVIEW_ROWS) as LookRows), stored: { before, after } }];
    });
    return { canvas, impact, broken, adaptable };
  };
  /** What putting a whole canvas would do; over an existing one, compared cell by cell (a put says nothing of where each cell went). Looks whose steps come with it follow. */
  const checkCanvasPut = (canvas: Canvas, rows: ReadonlyMap<string, LookRows>, pass: Passes, how: "put" | "restore" = "put") => {
    const old = venue.canvases.get(canvas.id);
    if (!old) return;
    const impact = impactOf(old, canvas, { moved: putMoves(old, canvas) }, looksOn(canvas.id));
    refuseUnlessPassed(
      canvas.name,
      impact,
      impact.looksAffected.filter((l) => l.reason === "steps" && !rows.has(l.id)),
      pass,
      how,
    );
  };
  /**
   * Writes a canvas and the rows of the looks that follow it, all or nothing: every look is checked on the
   * canvas as it will be before the first write, and what was written is put back if a write fails. Only the
   * rows change in a look (its steps, masks or patterns): a rename made meanwhile stays.
   */
  const writeCanvas = (canvas: Canvas, rows: ReadonlyMap<string, LookRows>): Canvas => {
    const next = [...rows].map(([lookId, r]) => {
      const look = show.looks.get(lookId);
      if (!look) throw new Error(say(`look inconnu : ${lookId}`, `unknown look: ${lookId}`));
      if (look.canvas !== canvas.id) throw new Error(say(`« ${look.name} » ne joue pas sur le canevas ${canvas.id}`, `“${look.name}” does not play on canvas ${canvas.id}`));
      const changed = show.looks.parse({ ...look, technique: withRows(look.technique, r) });
      if (changed.technique.kind === "pas" && !fits(changed.technique.steps, canvas.cells))
        throw new Error(say(`« ${look.name} » : chaque pas doit avoir ${canvas.cells} colonne(s), une par cellule`, `“${look.name}”: each step must have ${canvas.cells} column(s), one per cell`));
      try {
        return { before: look, after: checkLook(changed, canvas) };
      } catch (err) {
        throw new Error(say(`« ${look.name} » (${look.id}) : ${(err as Error).message}`, `“${look.name}” (${look.id}): ${(err as Error).message}`));
      }
    });
    // the steps first, then the canvas they follow; written straight to the store (every check is made, and the
    // command that writes is the one line of the activity), so a failed write leaves nothing to explain
    const written: Look[] = [];
    try {
      for (const l of next) {
        show.looks.put(l.after);
        written.push(l.before);
      }
      return venue.canvases.put(canvas);
    } catch (err) {
      for (const l of written) show.looks.put(l); // the canvas is written last: it did not change
      throw err;
    }
  };
  const rowsSchema = z
    .record(z.string(), z.union([z.array(z.array(z.string())), z.array(z.string())]))
    .default({})
    .describe("the looks whose steps follow the canvas, by look id: the steps of a look of exact steps (technique pas, one column per cell), or the masks / patterns of a mask technique; written with the canvas, all or nothing");
  const sharedFlag = z.boolean().default(false).describe("the venue is shared with other shows and that is known: move cells without checking their looks");
  /** Puts a whole canvas (venue.canvas.put, venue.canvas.auto): checked, then written with the looks' rows. */
  const putCanvas = async (value: unknown, opts: Passes & { steps?: Record<string, LookRows>; revision?: string | undefined; how?: "put" | "restore" }) => {
    const canvas = venue.canvases.parse(value);
    sameRevision(canvas.id, venue.canvases.get(canvas.id), opts.revision);
    const rows = new Map(Object.entries(opts.steps ?? {}));
    checkCanvasPut(canvas, rows, opts, opts.how);
    const stored = writeCanvas(canvas, rows);
    const warnings = warningsOf(stored);
    return { ...stored, revision: revisionOf(stored), ...(warnings.length ? { warnings } : {}) };
  };
  reg.register({
    name: "venue.canvas.get",
    title: "Canevas",
    titleEn: "Canvas",
    description: "One canvas and its revision (to give back to venue.canvas.edit or venue.canvas.put, which refuse a canvas changed since).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: idSchema,
    run: ({ id: i }) => {
      const canvas = venue.canvases.get(i);
      if (!canvas) throw unknownCanvas(i);
      const warnings = warningsOf(canvas);
      return { canvas, revision: revisionOf(canvas), ...(warnings.length ? { warnings } : {}) };
    },
  });
  reg.register({
    name: "venue.canvas.put",
    title: "Définir un canevas",
    titleEn: "Define a canvas",
    hints: "I",
    description:
      "Creates or updates a canvas (topology, cell count) and its rendering onto the venue's fixtures (cell ranges → fixture heads). Over an existing canvas, compared cell by cell: when cells move (another count, or the same cells in another order), refused unless force when a look of exact steps on it (technique pas, or a mask read cell by cell) would no longer line up (the error names them) — or give their steps with the canvas (steps), written together, all or nothing — and refused unless shared (or force) when the venue is shared with other shows (their looks are not checked). revision: the one venue.canvas.get gave; refused if the canvas changed since or is gone. warnings: ranges reversed or past the end, fixtures not in the patch, heads they do not have (written anyway: an import may come before the patch). To change a few cells, venue.canvas.edit says what moves and adapts the steps itself.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ canvas: CanvasSchema, steps: rowsSchema, force: z.boolean().default(false).describe("write even if looks of exact steps no longer line up with the cells"), shared: sharedFlag, revision: z.string().optional() }),
    run: ({ canvas, ...opts }) => putCanvas(canvas, opts),
  });
  reg.register({
    name: "venue.canvas.edit",
    title: "Éditer un canevas",
    titleEn: "Edit a canvas",
    hints: "",
    description:
      "Edits a canvas cell by cell, all operations at once or none: add (fixtures, one cell per full head as venue.canvas.auto, or the heads named, at a position), remove (cells), move (cells, contiguous or not, into the gap before cell `to`), reverse (from..to), duplicate (cells), retarget (cells → other fixture heads, the count unchanged), set (name, topology, columns, notes). Cells are 0-based, read as the previous operations left them; the ranges are written back compacted. impact: cell count before and after, whether cells moved (shifted), and the looks on the canvas it affects: reason steps for a look read cell by cell (technique pas, or a mask as long as the canvas) whose columns no longer line up — refused unless adapt (their columns follow their cells: a removed cell's column goes, an added cell is left untouched; adaptable shows the first rows before and after; the looks and the canvas are written together, all or nothing; steps gives the rows of each adapted look before and after) or force — and reason cells for a generated pattern that changes proportion (it still plays). On a venue shared with other shows, moving cells is refused unless shared (or force). dryRun: what it would do, nothing written. revision: the one an earlier answer (or venue.canvas.get) gave; refused if the canvas changed since.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({
      id: z.string(),
      ops: z.array(CanvasOpSchema).max(200),
      dryRun: z.boolean().default(false),
      force: z.boolean().default(false).describe("write even if looks of exact steps no longer line up with the cells, or the venue is shared"),
      shared: sharedFlag,
      adapt: z.union([z.boolean(), z.array(z.string())]).default(false).describe("adapt the steps of the looks of exact steps it breaks (true: all of them; or their ids)"),
      revision: z.string().optional(),
    }),
    dry: (args) => args.dryRun,
    run: ({ id: i, ops, dryRun, force, shared, adapt, revision }) => {
      const current = venue.canvases.get(i);
      if (!current) throw unknownCanvas(i);
      sameRevision(i, current, revision);
      const { canvas, impact, broken, adaptable: plan } = planEdit(current, ops);
      const chosen = plan.filter((a) => adapt === true || (Array.isArray(adapt) && adapt.includes(a.id)));
      const adapted = chosen.map((a) => a.id);
      const adaptable = plan.map(({ stored: _s, ...a }) => a);
      const warnings = warningsOf(canvas);
      const answer = { canvas, revision: revisionOf(canvas), impact, adaptable, adapted, ...(warnings.length ? { warnings } : {}) };
      if (dryRun) return { ...answer, dryRun: true };
      refuseUnlessPassed(
        canvas.name,
        impact,
        broken.filter((l) => !adapted.includes(l.id)),
        { force, shared },
        "edit",
        adaptable,
      );
      writeCanvas(canvas, new Map(chosen.map((a) => [a.id, a.stored.after])));
      return { ...answer, steps: Object.fromEntries(chosen.map((a) => [a.id, a.stored])) };
    },
  });
  reg.register({
    name: "venue.canvas.delete",
    title: "Supprimer un canevas",
    titleEn: "Delete a canvas",
    hints: "DI",
    description: "Deletes a canvas. Refused while a look uses it (the error names the looks, the snapshots and the Panic or startup recall that rely on it), unless force. With force, the looks playing on it are stopped.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: canvasDeletable,
    run: ({ id: i, force }) => {
      const canvas = venue.canvases.get(i);
      if (!canvas) throw new Error(say(`canevas inconnu : ${i}`, `unknown canvas: ${i}`));
      removable("canvas", i, canvas.name, force);
      // Looks still playing on it would stay « active » as ghosts and could not be relaunched.
      for (const l of show.looks.list()) if (l.canvas === i) show.stop(l.id);
      return { deleted: venue.canvases.delete(i) };
    },
  });
  return { checkCanvasPut, looksOn, planEdit, putCanvas, refuseUnlessPassed, revisionOf, sameRevision, sharedFlag, unknownCanvas };
}
