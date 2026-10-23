import { expect } from "chai";
import { arrange, dragOffset, inFrame, magnet, placeLabels, snap } from "../web/src/plan-tools.js";

describe("placing fixtures on the stage plan", () => {
  it("snaps to the magnetic grid, or to the centimetre without one", () => {
    expect(snap(1.234, 0.1)).to.equal(1.2);
    expect(snap(1.38, 0.25)).to.equal(1.5);
    expect(snap(-2.6, 1)).to.equal(-3);
    expect(snap(1.234, 0)).to.equal(1.23);
    expect(magnet(1.06, [0, 1, 2], 0.1)).to.equal(1);
    expect(magnet(1.5, [0, 1, 2], 0.1)).to.equal(undefined);
  });

  it("holds a dragged fixture on another's line or column, the grid otherwise", () => {
    const others = [{ x: 2, y: 4.5 }, { x: -3, y: 1 }];
    const opts = { step: 0.1, guides: true, reach: 0.15 };
    // near bar's row (y 4.5) and the stage's middle: held on both, the offset brings the whole selection
    expect(dragOffset({ x: 1, y: 1 }, { x: 0.08, y: 4.41 }, others, opts)).to.deep.equal({ dx: -1, dy: 3.5, guide: { x: 0, y: 4.5 } });
    // far from every line: on the grid
    expect(dragOffset({ x: 1, y: 1 }, { x: 1.33, y: 2.77 }, others, opts)).to.deep.equal({ dx: 0.3, dy: 1.8, guide: {} });
    // guides off: the grid alone
    expect(dragOffset({ x: 1, y: 1 }, { x: 0.08, y: 4.41 }, others, { ...opts, guides: false })).to.deep.equal({ dx: -0.9, dy: 3.4, guide: {} });
  });

  it("lines a selection up, or spreads it evenly between the outermost two", () => {
    const pts = [
      { id: "a", x: -3, y: 1 },
      { id: "b", x: 0.4, y: 1.3 },
      { id: "c", x: 3, y: 0.7 },
      { id: "d", x: 1, y: 2.2 },
    ];
    expect(arrange(pts, "row").map((p) => p.y)).to.deep.equal([1.3, 1.3, 1.3, 1.3]);
    expect(arrange(pts, "column").map((p) => p.x)).to.deep.equal([0.35, 0.35, 0.35, 0.35]);
    // across: -3, then 0.4 and 1, then 3 → -3, -1, 1, 3, the order kept
    expect(arrange(pts, "spreadX").map((p) => [p.id, p.x])).to.deep.equal([["a", -3], ["b", -1], ["c", 3], ["d", 1]]);
    expect(arrange(pts, "spreadY").map((p) => p.y)).to.deep.equal([1.2, 1.7, 0.7, 2.2]);
    expect(inFrame({ x: 1, y: 1 }, { x: 2, y: 0 }, { x: 0, y: 3 })).to.equal(true);
    expect(inFrame({ x: 3, y: 1 }, { x: 2, y: 0 }, { x: 0, y: 3 })).to.equal(false);
  });

  it("lays fixture names out without overlap: under, else above, else on hover only", () => {
    const at = (id: string, x: number) => ({ id, x, below: 100, above: 70, width: 60 });
    const shown = placeLabels([at("a", 100), at("b", 130), at("c", 160), at("d", 300)], 10);
    expect([...shown]).to.deep.equal([["a", 100], ["b", 70], ["d", 100]]); // c has no room left
  });
});
