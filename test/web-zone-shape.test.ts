import { expect } from "chai";
import { ellipsePolygon, movedZone, moveZone, rectPolygon, zoneRect } from "../web/src/zone-shape.js";

describe("stage zones on the plan", () => {
  it("draws a rectangle from its sizes and reads them back", () => {
    const stage = rectPolygon(8, 4, 0, 1);
    expect(stage).to.deep.equal([[-4, 1], [4, 1], [4, 5], [-4, 5]]);
    expect(zoneRect(stage)).to.deep.equal({ width: 8, depth: 4, x: 0, y: 1 });
    expect(zoneRect([[0, 0], [2, 0], [1, 3]])).to.equal(undefined); // a triangle has no such sizes
    expect(zoneRect([[0, 0], [2, 0], [3, 2], [0, 2]])).to.equal(undefined); // nor a slanted side
  });

  it("moves a zone of any shape, to the centimetre", () => {
    expect(moveZone([[0, 0], [2, 0], [1, 3]], 0.333, -1)).to.deep.equal([[0.33, -1], [2.33, -1], [1.33, 2]]);
    expect(zoneRect(moveZone(rectPolygon(8, 4, 0, 1), 1.5, 0.5))).to.deep.equal({ width: 8, depth: 4, x: 1.5, y: 1.5 });
  });

  it("takes a zone's placed aiming point and its drawn ellipse along when it moves (T27)", () => {
    const zone = { id: "z", polygon: ellipsePolygon(0, 3, 2, 1), aim: { height: 1.5, point: [0.5, 3] as [number, number] }, outline: { kind: "ellipse" as const, cx: 0, cy: 3, rx: 2, ry: 1 } };
    const moved = movedZone(zone, 1.2, -0.5);
    expect(moved.aim.point).to.deep.equal([1.7, 2.5]);
    expect(moved.outline).to.deep.equal({ kind: "ellipse", cx: 1.2, cy: 2.5, rx: 2, ry: 1 });
    expect(moved.polygon).to.deep.equal(moveZone(zone.polygon, 1.2, -0.5));
    // a zone aimed at its centre keeps no point: its centre moves with it
    const centred = { polygon: rectPolygon(2, 2, 0, 0), aim: { height: 1 } };
    expect(movedZone(centred, 1, 1).aim).to.deep.equal({ height: 1 });
  });
});
