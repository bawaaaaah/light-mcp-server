import { expect } from "chai";
import * as server from "../../../src/plugins/light/venue/stage.js";
import * as web from "../../../web/src/zone-shape.js";

type Pt = [number, number];

// venue/zone-geometry.ts is the one zone geometry, imported by the server (stage.ts) and the web app (zone-shape.ts,
// T43): the plan draws, checks and centres a zone as stage.zone.put and position.aim will.
describe("zone geometry, shared by the server and the plan (T27, T43)", () => {
  it("the plan accepts a zone exactly when stage.zone.put does", () => {
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
    expect(polygons.map((poly) => web.validZone(poly))).to.deep.equal(polygons.map((poly) => server.zoneShapeError(poly) === undefined));
    expect(polygons.map((poly) => web.validZone(poly))).to.deep.equal([true, true, false, false, false, false, false, false, true, true]);
  });

  it("the plan's aiming point of a concave or crossed zone is the one position.aim aims at", () => {
    const u: Pt[] = [[0, 0], [6, 0], [6, 4], [5, 4], [5, 1], [1, 1], [1, 4], [0, 4]];
    const thinL: Pt[] = [[0, 0], [6, 0], [6, 0.5], [0.5, 0.5], [0.5, 6], [0, 6]];
    const bow: Pt[] = [[0, 0], [4, 4], [4, 0], [0, 4.02]];
    for (const polygon of [u, thinL, bow]) {
      for (const aim of [undefined, { height: 1.5 }, { height: 1, point: [2.5, -1] as Pt }]) {
        const p = server.zoneAimPoint({ polygon, floorHeight: 0, aim });
        expect(web.aimSpot({ polygon, aim })).to.deep.equal({ x: p.x, y: p.y });
      }
    }
  });

  it("centres a comb of 30 thin teeth quickly, inside (T27, review 2)", () => {
    const comb = (teeth: number, tooth: number, length: number, base: number): Pt[] => {
      const cm = (v: number) => Math.round(v * 100) / 100;
      const p: Pt[] = [[0, 0]];
      for (let k = 0; k < teeth; k++) p.push([cm(2 * k * tooth), length], [cm((2 * k + 1) * tooth), length], [cm((2 * k + 1) * tooth), base], [cm((2 * k + 2) * tooth), base]);
      p.push([cm(2 * teeth * tooth), 0]);
      return p;
    };
    for (const poly of [comb(30, 1.43, 17.93, 0.21), comb(30, 0.3, 20, 1), comb(30, 0.05, 20, 0.02)]) {
      expect(server.zoneShapeError(poly)).to.equal(undefined);
      server.zoneCentre(poly); // once compiled
      const t0 = performance.now();
      const c = server.zoneCentre(poly);
      expect(performance.now() - t0).to.be.below(50);
      expect(server.pointInPolygon(c.x, c.y, poly)).to.equal(true);
    }
  });

  it("keeps the centre of a zone a centimetre thin inside it, rather than round it onto its edge (T27, review 2)", () => {
    // a U and an L whose bars are 1 cm wide: the centimetre nearest the pole lies on the outline
    const thinU: Pt[] = [[-35.63, -27.65], [-12.97, -27.65], [-12.97, -22.12], [-12.98, -22.12], [-12.98, -27.64], [-35.62, -27.64], [-35.62, -22.12], [-35.63, -22.12]];
    const thinL: Pt[] = [[-71.78, 91.74], [-66.27, 91.74], [-66.27, 91.75], [-71.77, 91.75], [-71.77, 92.12], [-71.78, 92.12]];
    for (const poly of [thinU, thinL]) {
      const c = server.zoneCentre(poly);
      expect(server.pointInPolygon(c.x, c.y, poly)).to.equal(true);
      const pole = server.poleOfInaccessibility(poly);
      expect(server.pointInPolygon(pole.x, pole.y, poly)).to.equal(true);
    }
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
