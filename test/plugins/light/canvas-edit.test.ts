import { expect } from "chai";
import { adaptSteps, applyOps, canvasIssues, canvasProblems, compact, fits, flatten, impactOf, inPlace, MAX_CELLS, type CanvasOp, type EditContext } from "../../../src/plugins/light/venue/canvas-edit.js";
import { generateSteps, TechniqueSchema } from "../../../src/plugins/light/engine/techniques.js";
import type { Canvas } from "../../../src/plugins/light/venue/venue.js";

/** A generic kit: two 4-head bars, a spot without heads, a wash with a halo (head 2, an accent). */
const ctx: EditContext = {
  headsOf: (f) =>
    ({
      "bar-a": { full: [0, 1, 2, 3], all: [0, 1, 2, 3] },
      "bar-b": { full: [0, 1, 2, 3], all: [0, 1, 2, 3] },
      spot: { full: [-1], all: [-1] },
      wash: { full: [0, 1], all: [0, 1, 2] },
      broken: { full: [], all: [], error: "définition manquante" },
    })[f],
};
const one = (fixture: string, head: number) => [{ fixture, head }];
/** bar-a's 4 heads, one cell each, then the spot. */
const base = (): Canvas => ({
  id: "wall",
  name: "Wall",
  topology: "line",
  cells: 5,
  render: [0, 1, 2, 3].map((h) => ({ from: h, to: h, targets: one("bar-a", h) })).concat([{ from: 4, to: 4, targets: one("spot", -1) }]),
});
const targetsOf = (c: Canvas) => flatten(c).map((t) => t.map((x) => `${x.fixture}:${x.head}`).join("+"));
const edit = (ops: CanvasOp[], c = base()) => applyOps(c, ops, ctx);

describe("canvas edit: operations on a canvas's cells (pure)", () => {
  it("flattens overlapping ranges and compacts them back, keeping several targets per cell", () => {
    const c: Canvas = { id: "x", name: "X", topology: "line", cells: 6, render: [{ from: 0, to: 3, targets: one("bar-a", -1) }, { from: 2, to: 9, targets: one("spot", -1) }] };
    expect(targetsOf(c)).to.deep.equal(["bar-a:-1", "bar-a:-1", "bar-a:-1+spot:-1", "bar-a:-1+spot:-1", "spot:-1", "spot:-1"]); // past the end: cut
    expect(compact(flatten(c))).to.deep.equal([
      { from: 0, to: 1, targets: one("bar-a", -1) },
      { from: 2, to: 3, targets: [...one("bar-a", -1), ...one("spot", -1)] },
      { from: 4, to: 5, targets: one("spot", -1) },
    ]);
    // a cell that drives nothing has no range, and splits the ones around it
    expect(compact([one("spot", -1), [], one("spot", -1)])).to.deep.equal([{ from: 0, to: 0, targets: one("spot", -1) }, { from: 2, to: 2, targets: one("spot", -1) }]);
  });

  it("adds one cell per full head, as venue.canvas.auto does (a halo none, a head-less fixture one), at the end or at a position", () => {
    const r = edit([{ op: "add", fixtures: ["wash", "spot"] }]);
    expect(targetsOf(r.canvas).slice(5)).to.deep.equal(["wash:0", "wash:1", "spot:-1"]);
    expect(r.origin).to.deep.equal([0, 1, 2, 3, 4, null, null, null]);
    const at = edit([{ op: "add", fixtures: ["wash"], heads: [2], at: 1 }]); // the halo when named
    expect(targetsOf(at.canvas)).to.deep.equal(["bar-a:0", "wash:2", "bar-a:1", "bar-a:2", "bar-a:3", "spot:-1"]);
    expect(at.origin).to.deep.equal([0, null, 1, 2, 3, 4]);
  });

  it("removes cells, the next ones moving up", () => {
    const r = edit([{ op: "remove", cells: [3, 1, 1] }]);
    expect(targetsOf(r.canvas)).to.deep.equal(["bar-a:0", "bar-a:2", "spot:-1"]);
    expect(r.origin).to.deep.equal([0, 2, 4]);
    expect(r.canvas.cells).to.equal(3);
  });

  it("moves cells, contiguous or not, into one block before a gap counted before the move", () => {
    expect(targetsOf(edit([{ op: "move", cells: [3, 1], to: 0 }]).canvas)).to.deep.equal(["bar-a:1", "bar-a:3", "bar-a:0", "bar-a:2", "spot:-1"]);
    expect(targetsOf(edit([{ op: "move", cells: [0, 1], to: 5 }]).canvas)).to.deep.equal(["bar-a:2", "bar-a:3", "spot:-1", "bar-a:0", "bar-a:1"]);
    const r = edit([{ op: "move", cells: [0], to: 3 }]);
    expect(targetsOf(r.canvas)).to.deep.equal(["bar-a:1", "bar-a:2", "bar-a:0", "bar-a:3", "spot:-1"]);
    expect(r.origin).to.deep.equal([1, 2, 0, 3, 4]);
    // in its own place: nothing moves
    expect(inPlace(edit([{ op: "move", cells: [2], to: 2 }]).origin, 5)).to.equal(true);
  });

  it("reverses a range, duplicates cells after the last of them, retargets without moving", () => {
    expect(targetsOf(edit([{ op: "reverse", from: 1, to: 3 }]).canvas)).to.deep.equal(["bar-a:0", "bar-a:3", "bar-a:2", "bar-a:1", "spot:-1"]);
    expect(targetsOf(edit([{ op: "reverse" }]).canvas)).to.deep.equal(["spot:-1", "bar-a:3", "bar-a:2", "bar-a:1", "bar-a:0"]);
    const d = edit([{ op: "duplicate", cells: [0, 2] }]);
    expect(targetsOf(d.canvas)).to.deep.equal(["bar-a:0", "bar-a:1", "bar-a:2", "bar-a:0", "bar-a:2", "bar-a:3", "spot:-1"]);
    expect(d.origin).to.deep.equal([0, 1, 2, 0, 2, 3, 4]);
    const t = edit([{ op: "retarget", cells: [0, 1], targets: [...one("bar-b", 0), ...one("spot", -1)] }]);
    expect(targetsOf(t.canvas).slice(0, 2)).to.deep.equal(["bar-b:0+spot:-1", "bar-b:0+spot:-1"]);
    expect(t.canvas.render[0]).to.deep.equal({ from: 0, to: 1, targets: [...one("bar-b", 0), ...one("spot", -1)] }); // compacted
    expect(inPlace(t.origin, 5)).to.equal(true);
  });

  it("sets name, topology, columns and notes without touching the stored ranges", () => {
    const old: Canvas = { ...base(), render: [{ from: 0, to: 9, targets: one("spot", -1) }], columns: 2 }; // an old range past the end
    const r = applyOps(old, [{ op: "set", name: "Back", topology: "grid", columns: null, notes: "n" }], ctx);
    expect(r.cellsTouched).to.equal(false);
    expect(r.canvas.render).to.equal(old.render); // read as it is, never normalised
    expect(r.canvas).to.include({ name: "Back", topology: "grid", notes: "n" });
    expect(r.canvas).to.not.have.property("columns");
  });

  it("applies the operations in order, all or nothing, and says which one failed", () => {
    const c = base();
    const before = JSON.stringify(c);
    expect(() => applyOps(c, [{ op: "remove", cells: [0] }, { op: "remove", cells: [4] }], ctx)).to.throw(/opération 2 \(remove\).*cellule 4/);
    expect(JSON.stringify(c)).to.equal(before);
    expect(() => edit([{ op: "add", fixtures: ["ghost"] }])).to.throw(/projecteur inconnu : ghost/);
    expect(() => edit([{ op: "add", fixtures: ["bar-a"], heads: [7] }])).to.throw(/pas de tête 7/);
    expect(() => edit([{ op: "add", fixtures: ["broken"] }])).to.throw(/définition manquante/);
    expect(() => edit([{ op: "retarget", cells: [0], targets: one("bar-a", 9) }])).to.throw(/pas de tête 9/);
    expect(() => edit([{ op: "move", cells: [0], to: 6 }])).to.throw(/au-delà de la fin/);
    expect(() => edit([{ op: "reverse", from: 3, to: 1 }])).to.throw(/après la fin/);
  });

  it("keeps a canvas between 1 and 4096 cells", () => {
    expect(() => edit([{ op: "remove", cells: [0, 1, 2, 3, 4] }])).to.throw(/au moins une cellule/);
    const big: Canvas = { id: "big", name: "Big", topology: "line", cells: MAX_CELLS, render: [{ from: 0, to: MAX_CELLS - 1, targets: one("spot", -1) }] };
    expect(() => applyOps(big, [{ op: "add", fixtures: ["spot"] }], ctx)).to.throw(/4097 cellules, au-delà de 4096/);
    expect(applyOps(big, [{ op: "remove", cells: [0] }, { op: "add", fixtures: ["spot"] }], ctx).canvas.cells).to.equal(MAX_CELLS);
  });
});

describe("canvas edit: what it does to the looks on the canvas", () => {
  const steps = [
    ["#ff0000", "#00ff00", "#0000ff", "-", ""],
    ["-", "-", "#ffffff", "#ffffff", "#ffffff"],
  ];
  const looks = [
    { id: "exact", name: "Exact", technique: { kind: "pas", steps } },
    { id: "wave", name: "Wave", technique: { kind: "onde" } },
    { id: "flat", name: "Flat", technique: { kind: "plat" } },
  ];

  it("names a look of exact steps once a cell moves, and a generated pattern only when the count changes", () => {
    const moved = edit([{ op: "move", cells: [4], to: 0 }]);
    expect(impactOf(5, 5, moved.origin, looks)).to.deep.equal({ cellsBefore: 5, cellsAfter: 5, shifted: true, looksAffected: [{ id: "exact", name: "Exact", technique: "pas", reason: "steps" }] });
    const removed = edit([{ op: "remove", cells: [0] }]);
    expect(impactOf(5, 4, removed.origin, looks).looksAffected.map((l) => [l.id, l.reason])).to.deep.equal([
      ["exact", "steps"],
      ["wave", "cells"],
    ]);
    // retargeting or renaming shifts nothing: no look is affected
    expect(impactOf(5, 5, edit([{ op: "retarget", cells: [0], targets: one("bar-b", 0) }]).origin, looks)).to.deep.include({ shifted: false, looksAffected: [] });
  });

  it("compares the cell count only for a whole put, and leaves a look already out of line alone", () => {
    expect(impactOf(5, 5, null, looks).looksAffected).to.deep.equal([]);
    expect(impactOf(5, 6, null, looks).looksAffected.map((l) => l.id)).to.deep.equal(["exact", "wave"]);
    const off = [{ id: "off", name: "Off", technique: { kind: "pas", steps: [["#ff0000"]] } }];
    expect(impactOf(5, 6, null, off).looksAffected).to.deep.equal([]); // not this change's doing
  });

  it("adapts exact steps so each column follows its cell", () => {
    const r = edit([{ op: "remove", cells: [1] }, { op: "move", cells: [3], to: 0 }, { op: "add", fixtures: ["spot"] }, { op: "duplicate", cells: [1] }]);
    // cells: spot(4), bar0(0), bar0 copy, bar2(2), bar3(3), new spot
    expect(r.origin).to.deep.equal([4, 0, 0, 2, 3, null]);
    expect(adaptSteps(steps, r.origin)).to.deep.equal([
      ["", "#ff0000", "#ff0000", "#0000ff", "-", ""],
      ["#ffffff", "-", "-", "#ffffff", "#ffffff", ""],
    ]);
  });

  it("property: with the steps adapted, every look of exact steps keeps one column per cell, whatever the operations", () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    for (let round = 0; round < 300; round++) {
      let c = base();
      // each original cell's column carries its own colour: it must stay in front of that cell
      const hex = (i: number) => `#0000${(i + 16).toString(16)}`;
      let rows = [Array.from({ length: c.cells }, (_, i) => hex(i))];
      let ident: (number | null)[] = rows[0]!.map((_, i) => i);
      for (let k = 0; k < 4; k++) {
        const n = c.cells;
        const some = () => [...new Set(Array.from({ length: 1 + rnd(Math.min(3, n)) }, () => rnd(n)))];
        const ops: CanvasOp[] = [{ op: "add", fixtures: ["wash"], at: rnd(n + 1) }, { op: "remove", cells: some() }, { op: "move", cells: some(), to: rnd(n + 1) }, { op: "reverse" }, { op: "duplicate", cells: some() }, { op: "retarget", cells: some(), targets: one("spot", -1) }];
        const op = ops[rnd(ops.length)]!;
        if (op.op === "remove" && op.cells.length >= n) continue;
        const r = applyOps(c, [op], ctx);
        rows = adaptSteps(rows, r.origin);
        ident = r.origin.map((o) => (o === null ? null : ident[o]!));
        c = r.canvas;
        expect(fits(rows, c.cells), JSON.stringify(op)).to.equal(true);
        expect(rows[0]).to.deep.equal(ident.map((i) => (i === null ? "" : hex(i))));
        // and the engine reads them as they are (no trimming, no padding)
        const played = generateSteps(TechniqueSchema.parse({ kind: "pas", steps: rows }), c.cells, false);
        expect(played.every((s) => s.length === c.cells)).to.equal(true);
      }
    }
  });
});

describe("canvas edit: a look of exact steps on a canvas whose cell count changed (engine)", () => {
  const t = TechniqueSchema.parse({ kind: "pas", steps: [["#ff0000", "-", "", "#0000ff"], []] });

  it("ignores the extra columns on fewer cells", () => {
    const s = generateSteps(t, 2, false);
    expect(s.map((r) => r.length)).to.deep.equal([2, 2]);
    expect(s[0]![0]).to.deep.include({ red: 1, green: 0, blue: 0 });
    expect(s[0]![1]).to.deep.include({ red: 0, green: 0, blue: 0 }); // "-" is off
  });

  it("leaves the missing cells untouched on more cells, and an empty row untouched everywhere, without failing", () => {
    const s = generateSteps(t, 6, false);
    expect(s[0]!.slice(2)).to.deep.equal([null, { red: 0, green: 0, blue: 1 }, null, null]);
    expect(s[1]).to.deep.equal([null, null, null, null, null, null]);
    // mirrored canvases read exact steps as written too
    expect(generateSteps(t, 6, true)[0]!.length).to.equal(6);
  });
});

describe("canvas checks: put warnings and « Vérifier le show »", () => {
  it("names reversed or out-of-bounds ranges, fixtures not in the patch, missing heads, empty cells, one head twice", () => {
    const c: Canvas = {
      id: "c",
      name: "C",
      topology: "line",
      cells: 6,
      render: [
        { from: 0, to: 0, targets: one("bar-a", 0) },
        { from: 2, to: 1, targets: one("bar-a", 1) },
        { from: 3, to: 3, targets: one("bar-a", 0) },
        { from: 4, to: 4, targets: [...one("ghost", -1), ...one("wash", 5), ...one("broken", 3)] },
        { from: 5, to: 7, targets: one("spot", -1) },
      ],
    };
    expect(canvasProblems(c, ctx)).to.deep.equal([
      { level: "attention", message: "plage 2–1 à l'envers : elle ne rend rien" },
      { level: "attention", message: "plage 5–7 au-delà des 6 cellules" },
      { level: "attention", message: "projecteur absent du patch : ghost" },
      { level: "attention", message: "tête inexistante : wash (5)" },
      { level: "info", message: "2 cellule(s) sans rendu (2–3)" },
      { level: "info", message: "même tête sur plusieurs cellules (la dernière l'emporte) : bar-a (0)" },
    ]);
    expect(canvasProblems(base(), ctx)).to.deep.equal([]);
  });

  it("names the looks of exact steps that do not have one column per cell", () => {
    const issues = canvasIssues([base()], [{ id: "l", name: "L", canvas: "wall", technique: { kind: "pas", steps: [["#ff0000"], ["-", "-", "-", "-", "-", "-", "-", "-"]] } }, { id: "ok", name: "Ok", canvas: "wall", technique: { kind: "pas", steps: [["", "", "", "", ""]] } }], ctx);
    expect(issues).to.deep.equal([{ level: "attention", where: "look l", message: "pas de longueur 1/8 sur un canevas de 5 cellules (« Wall ») : les colonnes en trop sont ignorées, les cellules sans colonne restent non touchées" }]);
  });
});
