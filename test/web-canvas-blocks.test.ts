import { expect } from "chai";
import { canvasBlocks, fixtureColors, stageOrder } from "../web/src/canvas-blocks.js";

const fixtures = [
  { id: "b1", name: "B1 · barre (gauche)", color: "#22c55e" },
  { id: "b2", name: "B2 · barre" },
  { id: "par", name: "P1 · PAR" },
];

describe("look editor: the fixtures behind a canvas's cells", () => {
  it("names each run of cells after its fixture, with its marker colour", () => {
    const render = [
      ...[0, 1, 2].map((k) => ({ from: k, to: k, targets: [{ fixture: "b1", head: k }] })),
      { from: 3, to: 5, targets: [{ fixture: "b2", head: -1 }] },
      { from: 6, to: 6, targets: [{ fixture: "par", head: -1 }] },
    ];
    expect(canvasBlocks(8, render, fixtures)).to.deep.equal([
      { from: 0, to: 2, label: "B1 · barre (gauche)", fixtures: ["b1"], color: "#22c55e" },
      { from: 3, to: 5, label: "B2 · barre", fixtures: ["b2"] },
      { from: 6, to: 6, label: "P1 · PAR", fixtures: ["par"] },
      { from: 7, to: 7, label: "", fixtures: [] }, // a cell nothing drives
    ]);
  });

  it("reads a cell driving two fixtures as both, and an unknown fixture by its id", () => {
    expect(canvasBlocks(2, [{ from: 0, to: 1, targets: [{ fixture: "b2", head: 0 }, { fixture: "gone", head: 0 }] }], fixtures)).to.deep.equal([{ from: 0, to: 1, label: "B2 · barre + gone", fixtures: ["b2", "gone"] }]);
    expect(canvasBlocks(2, [], fixtures)).to.deep.equal([{ from: 0, to: 1, label: "", fixtures: [] }]); // no render: one block, unnamed
  });

  it("shows the blocks from jardin to cour, the steps keeping the canvas's order", () => {
    const blocks = canvasBlocks(7, [
      { from: 0, to: 2, targets: [{ fixture: "b1", head: -1 }] },
      { from: 3, to: 5, targets: [{ fixture: "b2", head: -1 }] },
      { from: 6, to: 6, targets: [{ fixture: "par", head: -1 }] },
    ], fixtures);
    // on stage: the PAR between the bars, b2 on the jardin side
    const { order, blocks: shown } = stageOrder(blocks, new Map([["b1", 1], ["b2", -2], ["par", 0]]));
    expect(order).to.deep.equal([3, 4, 5, 6, 0, 1, 2]);
    expect(shown.map((b) => [b.label, b.from, b.to])).to.deep.equal([["B2 · barre", 0, 2], ["P1 · PAR", 3, 3], ["B1 · barre (gauche)", 4, 6]]);
    expect(stageOrder(blocks, new Map([["par", 0]])).order).to.deep.equal([6, 0, 1, 2, 3, 4, 5]); // the unplaced after, in the canvas's order
  });

  it("turns a frame of cells into each fixture's heads, for the stage plan", () => {
    const render = [
      { from: 0, to: 0, targets: [{ fixture: "b1", head: 0 }] },
      { from: 1, to: 1, targets: [{ fixture: "b1", head: 2 }] },
      { from: 2, to: 2, targets: [{ fixture: "par", head: -1 }] },
    ];
    expect(fixtureColors(["#ff0000", "#0000ff", "#ffffff"], render)).to.deep.equal({ b1: ["#ff0000", "#000000", "#0000ff"], par: ["#ffffff"] });
    expect(fixtureColors([null, null, null], render)).to.deep.equal({}); // not driven: the stage shows the live output there
  });
});
