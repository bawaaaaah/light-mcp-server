import { expect } from "chai";
import { fittedBox, pointerToDrawing, stageFrame, stageLayout } from "../web/src/stage-frame.js";

/** The frame of the top view of the stage (T24, lot 3): what the live plan draws, and metres ↔ drawing units. */
describe("stage frame (top view)", () => {
  const zone = { polygon: [[-4, 0], [4, 0], [4, 6], [-4, 6]] as [number, number][] };

  it("frames the zones and the placed fixtures, 0.8 m around", () => {
    const l = stageLayout([{ id: "a", position: { x: 5, y: 2 } }], [zone]);
    expect([l.minX, l.maxX, l.minY, l.maxY]).to.deep.equal([-4.8, 5.8, -0.8, 6.8]);
    expect(l.pos.get("a")).to.deep.equal({ x: 5, y: 2 });
    expect(l.unplaced).to.equal(0);
  });

  it("lines the unplaced fixtures up on a row in front of the stage, widening the frame for them", () => {
    const fixtures = [{ id: "a" }, { id: "b", position: { x: 0, y: 3 } }, { id: "c" }, { id: "d" }];
    const l = stageLayout(fixtures, [{ polygon: [[-1, 1], [1, 1], [1, 4]] }]);
    expect(l.unplaced).to.equal(3);
    // three of them: 1.8 m either side, 0.8 m before the stage's front (y 0 here, the zones start behind it)
    expect([l.minX, l.maxX, l.minY, l.maxY].map((v) => Math.round(v * 100) / 100)).to.deep.equal([-2.6, 2.6, -1.9, 4.8]);
    const round = (p: { x: number; y: number }) => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 });
    expect([...l.pos.entries()].map(([id, p]) => [id, round(p)])).to.deep.equal([
      ["b", { x: 0, y: 3 }],
      ["a", { x: -1.2, y: -0.8 }],
      ["c", { x: 0, y: -0.8 }],
      ["d", { x: 1.2, y: -0.8 }],
    ]);
  });

  it("widens the frame for a 3D target outside the zones, keeping the row of the unplaced fixtures (D2)", () => {
    const l = stageLayout([{ id: "a" }, { id: "b", position: { x: 0, y: 3 } }], [zone], [{ x: 7, y: 9 }]);
    // the target at x 7, y 9: 0.8 m around it; the row of « a » still in front, at y -0.8
    expect([l.minX, l.maxX, l.minY, l.maxY].map((v) => Math.round(v * 100) / 100)).to.deep.equal([-4.8, 7.8, -1.9, 9.8]);
    expect(l.pos.get("a")).to.deep.equal({ x: 0, y: -0.8 });
    expect(l.unplaced).to.equal(1);
    // a target inside the zones changes nothing
    expect(stageLayout([], [zone], [{ x: 1, y: 1 }])).to.deep.include({ minX: -4.8, maxX: 4.8, minY: -0.8, maxY: 6.8 });
  });

  it("with nothing placed, frames the row alone", () => {
    const l = stageLayout([{ id: "a" }], []);
    expect([l.minX, l.maxX, l.minY, l.maxY]).to.deep.equal([-1.8, 1.8, -0.6, 0.6]);
    expect(l.pos.get("a")).to.deep.equal({ x: 0, y: 0 });
    expect(stageLayout([], [])).to.include({ minX: -1.8, maxX: 1.8, unplaced: 0 });
  });

  it("turns metres into drawing units and back, upstage at the top, the audience at the bottom", () => {
    const l = stageLayout([], [zone]);
    const f = stageFrame(l, 800);
    expect(f.scale).to.be.closeTo(800 / 9.6, 1e-9);
    expect(f.H).to.be.closeTo(7.6 * f.scale, 1e-9);
    expect(f.sx(l.minX)).to.equal(0);
    expect(f.sx(l.maxX)).to.be.closeTo(800, 1e-9);
    expect(f.sy(l.minY)).to.be.closeTo(f.H, 1e-9); // the front edge at the bottom
    expect(f.sy(l.maxY)).to.be.closeTo(0, 1e-9);
    for (const p of [{ x: 0, y: 0 }, { x: -3.3, y: 5.1 }, { x: 4, y: 6 }]) {
      const back = f.toStage(f.sx(p.x), f.sy(p.y));
      expect(back.x).to.be.closeTo(p.x, 1e-9);
      expect(back.y).to.be.closeTo(p.y, 1e-9);
    }
    // a shallow stage keeps a readable height
    expect(stageFrame({ minX: 0, maxX: 10, minY: 0, maxY: 0.5 }, 800).H).to.equal(160);
  });

  it("turns a pointer on the drawing shown on screen into drawing units", () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 };
    // the viewBox is twice the box on screen, starting 20 units before the stage
    expect(pointerToDrawing({ clientX: 300, clientY: 150 }, rect, 800, 400, { left: 20, top: 10 })).to.deep.equal({ px: 380, py: 190 });
    expect(pointerToDrawing({ clientX: 100, clientY: 50 }, rect, 800, 400, { left: 0, top: 0 })).to.deep.equal({ px: 0, py: 0 });
  });

  it("finds the box a drawing fitted whole takes inside a wider or a taller element", () => {
    // 800 × 400 in 600 × 600: the width fits, a band above and below
    expect(fittedBox({ left: 10, top: 20, width: 600, height: 600 }, 800, 400)).to.deep.equal({ left: 10, top: 170, width: 600, height: 300 });
    // in 1000 × 200: the height fits, a band on each side
    expect(fittedBox({ left: 0, top: 0, width: 1000, height: 200 }, 800, 400)).to.deep.equal({ left: 300, top: 0, width: 400, height: 200 });
  });
});
