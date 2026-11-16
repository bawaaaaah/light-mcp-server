import { expect } from "chai";
import { aimSpot, cachedZoneCentre, ellipsePolygon, movedZone, moveZone, rectPolygon, reshapedZone, validZone, zoneAt, zoneCentre, zoneRect } from "../web/src/zone-shape.js";

describe("stage zones on the plan", () => {
  it("finds the zone drawn on top at a point: the last of the list (T27, the plan and the target pad)", () => {
    const under = { id: "under", polygon: rectPolygon(4, 4, 0, 0) };
    const over = { id: "over", polygon: rectPolygon(2, 2, 0, 1) };
    expect(zoneAt([under, over], { x: 0, y: 2 })?.id).to.equal("over");
    expect(zoneAt([under, over], { x: 1.5, y: 0.5 })?.id).to.equal("under");
    expect(zoneAt([over, under], { x: 0, y: 2 })?.id).to.equal("under"); // drawn after: on top
    expect(zoneAt([under, over], { x: 5, y: 5 })).to.equal(undefined);
  });
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

  it("keeps the corner held under the pointer when a rectangle's corners come in another order (T27, review 2)", () => {
    type Pt = [number, number];
    // clockwise from the back right: not the order rectPolygon gives
    const rect = { polygon: [[2, 1], [2, 0], [0, 0], [0, 1]] as Pt[], outline: { kind: "rect" as const } };
    const once = reshapedZone(rect, 0, { x: 3, y: 2 });
    expect(once.polygon).to.deep.equal([[3, 2], [3, 0], [0, 0], [0, 2]]);
    // a second step moves the same corner, not another one (two arrow presses on the same handle)
    const twice = reshapedZone(once, 0, { x: 3.5, y: 2 });
    expect(twice.polygon).to.deep.equal([[3.5, 2], [3.5, 0], [0, 0], [0, 2]]);
    expect(zoneRect(twice.polygon)).to.deep.equal({ width: 3.5, depth: 2, x: 1.75, y: 0 });
    // every corner index, both ways round: the handle's corner is where the pointer is, the opposite one stays
    for (const polygon of [rectPolygon(2, 1, 0, 0), [[1, 0], [1, 1], [-1, 1], [-1, 0]] as Pt[]]) {
      for (let h = 0; h < 4; h++) {
        const r = reshapedZone({ polygon }, h, { x: 5, y: 7 });
        expect(r.polygon[h]).to.deep.equal([5, 7]);
        expect(r.polygon[(h + 2) % 4]).to.deep.equal(polygon[(h + 2) % 4]);
        expect(validZone(r.polygon) && zoneRect(r.polygon) !== undefined).to.equal(true);
      }
    }
  });

  it("finds a zone's centre once per polygon (T27, review 2)", () => {
    type Pt = [number, number];
    const u: Pt[] = [[0, 0], [6, 0], [6, 4], [5, 4], [5, 1], [1, 1], [1, 4], [0, 4]];
    const first = aimSpot({ polygon: u });
    expect(cachedZoneCentre(u)).to.equal(first); // the same object: not searched again
    expect(first).to.deep.equal(zoneCentre(u));
    expect(cachedZoneCentre([...u])).to.not.equal(first); // another polygon, another search
  });
});
