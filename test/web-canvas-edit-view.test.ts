import { expect } from "chai";
import { addOrder, cellsInFrame, cellTargets, EditHistory, gapAt, isNoMove, movedOrder, pickCells, pickedAfterMove } from "../web/src/canvas-edit-view.js";

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
    for (const n of [1, 2, 3, 4]) h.push({ before: n - 1, after: n, looksBefore: [], looksAfter: [] });
    expect(h.undo()?.after).to.equal(4);
    expect(h.undo()?.after).to.equal(3);
    expect(h.undo()?.after).to.equal(2);
    expect(h.canUndo).to.equal(false); // the first step was forgotten
    expect(h.redo()?.after).to.equal(2);
    h.push({ before: 2, after: 9, looksBefore: [], looksAfter: [] });
    expect(h.canRedo).to.equal(false);
    // a step that failed goes back
    const s = h.undo()!;
    h.restoreUndo(s);
    expect(h.canRedo).to.equal(false);
    expect(h.undo()).to.equal(s);
  });
});
