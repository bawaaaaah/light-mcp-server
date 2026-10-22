import { expect } from "chai";
import { canvasBlocks } from "../web/src/canvas-blocks.js";

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
      { from: 0, to: 2, label: "B1 · barre (gauche)", color: "#22c55e" },
      { from: 3, to: 5, label: "B2 · barre" },
      { from: 6, to: 6, label: "P1 · PAR" },
      { from: 7, to: 7, label: "" }, // a cell nothing drives
    ]);
  });

  it("reads a cell driving two fixtures as both, and an unknown fixture by its id", () => {
    expect(canvasBlocks(2, [{ from: 0, to: 1, targets: [{ fixture: "b2", head: 0 }, { fixture: "gone", head: 0 }] }], fixtures)).to.deep.equal([{ from: 0, to: 1, label: "B2 · barre + gone" }]);
    expect(canvasBlocks(2, [], fixtures)).to.deep.equal([{ from: 0, to: 1, label: "" }]); // no render: one block, unnamed
  });
});
