import { expect } from "chai";
import { addOrder, cellsInFrame, cellTargets, EditHistory, gapAt, isNoMove, isRun, movedOrder, pickCells, pickedAfterMove, runsOf, shiftOps, shownIn } from "../web/src/canvas-edit-view.js";

describe("canvas editor view (web, pure)", () => {
  it("reads each cell's targets as the server does", () => {
    const render = [
      { from: 0, to: 2, targets: [{ fixture: "a", head: -1 }] },
      { from: 2, to: 9, targets: [{ fixture: "b", head: 0 }] },
    ];
    expect(cellTargets(4, render).map((c) => c.map((t) => t.fixture).join("+"))).to.deep.equal(["a", "a", "a+b", "b"]);
  });

  it("picks cells by click, Ctrl/⌘ and Shift, in canvas order", () => {
    let s = pickCells(6, [], undefined, 2, { add: false, frame: false });
    expect(s).to.deep.equal({ selection: [2], anchor: 2 });
    s = pickCells(6, s.selection, s.anchor, 5, { add: false, frame: true });
    expect(s.selection).to.deep.equal([2, 3, 4, 5]);
    s = pickCells(6, s.selection, s.anchor, 3, { add: true, frame: false });
    expect(s.selection).to.deep.equal([2, 4, 5]);
    s = pickCells(6, s.selection, s.anchor, 0, { add: true, frame: false });
    expect(s.selection).to.deep.equal([0, 2, 4, 5]);
  });

  // two lines of three 20 px cells: 0 1 2 / 3 4 5
  const rects = [0, 1, 2, 3, 4, 5].map((i) => ({ left: (i % 3) * 20, top: Math.floor(i / 3) * 20, width: 20, height: 20 }));

  it("finds the cells framed by their centre, over wrapped lines", () => {
    expect(cellsInFrame(rects, { x1: 25, y1: 5, x2: 55, y2: 35 })).to.deep.equal([1, 2, 4, 5]);
    expect(cellsInFrame(rects, { x1: 55, y1: 35, x2: 25, y2: 5 })).to.deep.equal([1, 2, 4, 5]); // drawn the other way
    expect(cellsInFrame(rects, { x1: 0, y1: 0, x2: 5, y2: 5 })).to.deep.equal([]);
  });

  it("drops into the gap nearest the pointer, on its line", () => {
    expect(gapAt(2, 10, rects)).to.equal(0);
    expect(gapAt(15, 10, rects)).to.equal(1);
    expect(gapAt(58, 30, rects)).to.equal(6); // after the last
    expect(gapAt(200, 10, rects)).to.equal(3); // past the end of the first line: after its last cell
    expect(gapAt(5, 100, rects)).to.equal(3); // below everything: the nearest cell
    expect(gapAt(5, 5, [])).to.equal(0);
  });

  it("previews a move as the server makes it, and keeps the moved cells picked", () => {
    expect(movedOrder(5, [3, 1], 0)).to.deep.equal([1, 3, 0, 2, 4]);
    expect(movedOrder(5, [0], 3)).to.deep.equal([1, 2, 0, 3, 4]);
    expect(movedOrder(5, [0, 1], 5)).to.deep.equal([2, 3, 4, 0, 1]);
    expect(pickedAfterMove(5, [3, 1], 0)).to.deep.equal([0, 1]);
    expect(pickedAfterMove(5, [0], 3)).to.deep.equal([2]);
    expect(isNoMove(5, [2], 2)).to.equal(true);
    expect(isNoMove(5, [2], 3)).to.equal(true); // just after itself
    expect(isNoMove(5, [1, 3], 2)).to.equal(false); // gathered: it moves
  });

  it("adds fixtures from jardin to cour when all are placed, else in patch order", () => {
    const a = { id: "a", universe: 1, address: 20, position: { x: 2 } };
    const b = { id: "b", universe: 1, address: 1, position: { x: -3 } };
    const c = { id: "c", universe: 2, address: 1 };
    expect(addOrder([a, b]).map((f) => f.id)).to.deep.equal(["b", "a"]);
    expect(addOrder([c, a, b]).map((f) => f.id)).to.deep.equal(["b", "a", "c"]);
  });

  it("undoes and redoes steps, a new change forgetting the redo, 100 steps at most", () => {
    const h = new EditHistory<number, string>(3);
    const step = (before: number, after: number) => ({ before, after, rowsBefore: {}, rowsAfter: {} });
    for (const n of [1, 2, 3, 4]) h.push(step(n - 1, n));
    for (const n of [4, 3, 2]) {
      expect(h.toUndo?.after).to.equal(n);
      h.undone(h.toUndo!);
    }
    expect(h.canUndo).to.equal(false); // the first step was forgotten
    expect(h.toRedo?.after).to.equal(2);
    h.redone(h.toRedo!);
    h.push(step(2, 9));
    expect(h.canRedo).to.equal(false);
  });

  it("keeps a step until the server took it: read twice it is one step, refused it stays", () => {
    const h = new EditHistory<number, string>();
    h.push({ before: 0, after: 1, rowsBefore: {}, rowsAfter: {} });
    h.push({ before: 1, after: 2, rowsBefore: { look: "a" }, rowsAfter: { look: "b" } });
    const first = h.toUndo!;
    expect(h.toUndo).to.equal(first); // a second ⌘Z while the first is on its way reads the same step
    expect(h.canRedo).to.equal(false); // refused: nothing moved
    h.undone(first);
    h.undone(first); // told twice: counted once
    expect(h.toUndo?.after).to.equal(1);
    expect(h.toRedo).to.equal(first);
  });

  it("shifts a selection in several pieces one place without gathering it, and reverses one run only", () => {
    expect(runsOf([4, 1, 2, 7])).to.deep.equal([[1, 2], [4, 4], [7, 7]]);
    const apply = (count: number, ops: { cells: number[]; to: number }[]) => ops.reduce((order, op) => movedOrder(count, op.cells, op.to).map((i) => order[i]!), Array.from({ length: count }, (_, i) => i));
    // cells 1, 2 and 4 of six, one earlier: 1 2 0 4 3 5
    expect(apply(6, shiftOps(6, [1, 2, 4], -1))).to.deep.equal([1, 2, 0, 4, 3, 5]);
    expect(apply(6, shiftOps(6, [1, 2, 4], 1))).to.deep.equal([0, 3, 1, 2, 5, 4]);
    expect(shiftOps(6, [0, 3], -1)).to.deep.equal([]); // already at the start
    expect(shiftOps(6, [2, 5], 1)).to.deep.equal([]);
    expect(isRun([2, 3, 4])).to.equal(true);
    expect(isRun([2])).to.equal(false);
    expect(isRun([1, 3])).to.equal(false);
  });

  it("leaves the squares a scrolled strip hides out of a frame", () => {
    const shown = shownIn(rects, { left: 0, top: 0, right: 60, bottom: 20 });
    expect(shown.map(Boolean)).to.deep.equal([true, true, true, false, false, false]);
    expect(cellsInFrame(shown, { x1: 0, y1: 0, x2: 60, y2: 40 })).to.deep.equal([0, 1, 2]);
  });
});
