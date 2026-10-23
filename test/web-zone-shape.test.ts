import { expect } from "chai";
import { moveZone, rectPolygon, zoneRect } from "../web/src/zone-shape.js";

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
});
