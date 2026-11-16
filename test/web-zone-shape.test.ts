import { expect } from "chai";
import { ellipsePolygon, movedZone, moveZone, rectPolygon, reshapedZone, validZone, zoneRect } from "../web/src/zone-shape.js";

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

  it("reshapes a zone by a corner or places its aiming point (T27, lot Z4)", () => {
    type Pt = [number, number];
    // a rectangle keeps its opposite corner and stays upright, drawn as one or made on the Lieu page
    const rect = { polygon: rectPolygon(2, 1, 0, 0), outline: { kind: "rect" as const } };
    const wider = reshapedZone(rect, 2, { x: 2.004, y: 2 });
    expect(zoneRect(wider.polygon)).to.deep.equal({ width: 3, depth: 2, x: 0.5, y: 0 });
    expect(zoneRect(reshapedZone({ polygon: rectPolygon(2, 1, 0, 0) }, 0, { x: -2, y: -1 }).polygon)).to.deep.equal({ width: 3, depth: 2, x: -0.5, y: -1 });
    // a polygon's corner moves alone, to the centimetre; its outline is kept
    const tri = { polygon: [[0, 0], [2, 0], [1, 2]] as Pt[], outline: { kind: "polygon" as const } };
    expect(reshapedZone(tri, 2, { x: 1.234, y: 3 })).to.deep.equal({ polygon: [[0, 0], [2, 0], [1.23, 3]], outline: { kind: "polygon" } });
    // a corner dragged across: the shape is refused before it is sent (validZone)
    const square = { polygon: [[0, 0], [2, 0], [2, 2], [0, 2]] as Pt[], outline: { kind: "polygon" as const } };
    expect(validZone(reshapedZone(square, 1, { x: -1, y: 1 }).polygon)).to.equal(false);
    // the aiming point placed, its height kept; a zone with no aiming part is left as it is
    const aimed = { polygon: tri.polygon, aim: { height: 1.2 } };
    expect(reshapedZone(aimed, "aim", { x: 5.555, y: -1 }).aim).to.deep.equal({ height: 1.2, point: [5.56, -1] });
    expect(reshapedZone(tri, "aim", { x: 1, y: 1 })).to.equal(tri);
  });
});
