import { expect } from "chai";
import * as server from "../../../src/plugins/light/venue/stage.js";
import * as web from "../../../web/src/zone-shape.js";

type Pt = [number, number];

// web/src/zone-shape.ts mirrors the shape helpers of venue/stage.ts (the web app shares no code with the server): the
// plan must draw, check and centre a zone as stage.zone.put and position.aim will.
describe("zone shapes: the web copy agrees with the server (T27)", () => {
  const polygons: Pt[][] = [
    [[-4, 1], [4, 1], [4, 5], [-4, 5]],
    [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]],
    [[0, 0], [2, 2], [2, 0], [0, 2]],
    [[0, 0], [2, 0], [2, 0], [0, 2]],
    [[0, 0], [3, 0], [1, 0], [1, 2]],
    [[0, 0], [4, 0], [4, 4], [2, 0], [0, 4]],
    [[0, 0], [1, 0], [2, 0]],
    [[0, 0], [0.05, 0], [0.05, 0.05], [0, 0.05]],
    [[0.3, -1.2], [2.71, 0.4], [1.05, 3.33], [-0.8, 1.9]],
    server.ellipsePolygon(1, 2, 3, 1.5, 30),
  ];

  polygons.forEach((poly, i) => {
    it(`agrees on polygon ${i}`, () => {
      expect(web.isSimplePolygon(poly)).to.equal(server.isSimplePolygon(poly));
      expect(web.polygonArea(poly)).to.equal(server.polygonArea(poly));
      expect(web.centroid(poly)).to.deep.equal(server.centroid(poly));
      expect(web.validZone(poly)).to.equal(server.zoneShapeError(poly) === undefined);
      expect(web.zoneCentre(poly)).to.deep.equal(server.zoneCentre(poly));
    });
  });

  it("agrees on concave and crossed zones' centres, and the plan's aiming point is the server's", () => {
    const u: Pt[] = [[0, 0], [6, 0], [6, 4], [5, 4], [5, 1], [1, 1], [1, 4], [0, 4]];
    const thinL: Pt[] = [[0, 0], [6, 0], [6, 0.5], [0.5, 0.5], [0.5, 6], [0, 6]];
    const bow: Pt[] = [[0, 0], [4, 4], [4, 0], [0, 4.02]];
    for (const polygon of [u, thinL, bow]) {
      expect(web.zoneCentre(polygon)).to.deep.equal(server.zoneCentre(polygon));
      for (const aim of [undefined, { height: 1.5 }, { height: 1, point: [2.5, -1] as Pt }]) {
        const spot = web.aimSpot({ polygon, aim });
        const p = server.zoneAimPoint({ polygon, floorHeight: 0, aim });
        expect(spot).to.deep.equal({ x: p.x, y: p.y });
      }
    }
  });

  it("agrees on thousands of random outlines (fuzz: crossed, folded, flat, concave)", () => {
    // a seeded generator: the same outlines on every run
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
    let disagreements = 0;
    for (let k = 0; k < 4000; k++) {
      const n = ri(3, 7);
      const range = ri(2, 6);
      const scale = [1, 10, 100, 37][ri(0, 3)]!;
      const offset = [0, 1000, -2500][ri(0, 2)]!;
      const poly = Array.from({ length: n }, () => [(ri(0, range) * scale + offset) / 100, (ri(0, range) * scale + offset) / 100] as Pt);
      const same =
        web.isSimplePolygon(poly) === server.isSimplePolygon(poly) &&
        web.polygonArea(poly) === server.polygonArea(poly) &&
        JSON.stringify(web.centroid(poly)) === JSON.stringify(server.centroid(poly)) &&
        JSON.stringify(web.zoneCentre(poly)) === JSON.stringify(server.zoneCentre(poly)) &&
        web.validZone(poly) === (server.zoneShapeError(poly) === undefined);
      if (!same) disagreements++;
    }
    expect(disagreements).to.equal(0);
  });

  it("draws the same ellipses", () => {
    for (const [cx, cy, rx, ry, rot] of [[0, 3, 2, 1, 0], [1.234, -0.5, 0.7, 2.25, 45], [0, 0, 1, 1, -30]] as const) {
      expect(web.ellipsePolygon(cx, cy, rx, ry, rot)).to.deep.equal(server.ellipsePolygon(cx, cy, rx, ry, rot));
    }
    expect(web.ELLIPSE_POINTS).to.equal(server.ELLIPSE_POINTS);
    expect(web.MIN_ZONE_AREA).to.equal(server.MIN_ZONE_AREA);
  });

  it("a rectangle or an ellipse dragged on the plan is a zone the server takes, its outline read back", () => {
    const rect = web.rectFromDrag({ x: 2.004, y: 4 }, { x: -1, y: 1.5 });
    expect(rect).to.deep.equal([[-1, 1.5], [2, 1.5], [2, 4], [-1, 4]]);
    expect(server.zoneOutline({ polygon: rect, outline: { kind: "rect" } })).to.deep.equal({ kind: "rect" });
    expect(web.zoneRect(rect)).to.deep.equal({ width: 3, depth: 2.5, x: 0.5, y: 1.5 });
    const e = web.ellipseFromDrag({ x: 0, y: 0 }, { x: 3, y: -2 });
    expect(e).to.deep.equal({ cx: 1.5, cy: -1, rx: 1.5, ry: 1 });
    const outline = { kind: "ellipse" as const, ...e };
    expect(server.zoneOutline({ polygon: web.ellipsePolygon(e.cx, e.cy, e.rx, e.ry), outline })).to.deep.equal(outline);
    expect(server.zoneShapeError(web.ellipsePolygon(e.cx, e.cy, e.rx, e.ry))).to.equal(undefined);
  });

  it("Shift squares a rectangle and rounds an ellipse, from the first corner", () => {
    expect(web.rectFromDrag({ x: 0, y: 0 }, { x: 2, y: -1 }, true)).to.deep.equal([[0, -2], [2, -2], [2, 0], [0, 0]]);
    expect(web.ellipseFromDrag({ x: 1, y: 1 }, { x: 0, y: 3 }, true)).to.deep.equal({ cx: 0, cy: 2, rx: 1, ry: 1 });
  });
});
