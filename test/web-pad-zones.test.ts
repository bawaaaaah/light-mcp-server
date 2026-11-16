import { expect } from "chai";
import { aimAt, pointing, type AimSetup } from "../src/plugins/light/venue/aim.js";
import { projectZone } from "../src/plugins/light/venue/zone-project.js";
import { fromView, toView, zoneStateTexts, zonesView, zoneUnder } from "../web/src/pad-zones.js";
import { leftOut, reasonText } from "../web/src/leftOut.js";
import { TEXTS } from "../web/src/i18n.js";

/** T27, lots 4-5: the aiming zones on a single head's pad, in the browser (web/src/pad-zones.ts). */
describe("aiming zones on a head's pad (web, T27)", () => {
  it("finds the zone under a pad point on the stage, the last of the list on top, each at its own aiming height", () => {
    const head: AimSetup = { position: { x: 0, y: 1, z: 5 }, hung: true, yaw: 0, panMax: 540, tiltMax: 270, panOffset: 0, tiltOffset: 0 };
    const low = { id: "low", polygon: [[-3, 2], [-1, 2], [-1, 4], [-3, 4]] as [number, number][], plane: 0 };
    const high = { id: "high", polygon: [[-2.5, 2.5], [-1.5, 2.5], [-1.5, 3.5], [-2.5, 3.5]] as [number, number][], plane: 1.5 };
    const at = (x: number, y: number, z: number) => {
      const r = aimAt(head, { x, y, z });
      if ("error" in r) throw new Error(r.error);
      return r;
    };
    // (−2, 3) at 1.5 m: in « high », drawn after « low »: « high »
    const centre = at(-2, 3, 1.5);
    expect(zoneUnder(head, [low, high], centre.pan, centre.tilt)?.id).to.equal("high");
    expect(zoneUnder(head, [high, low], centre.pan, centre.tilt)?.id).to.equal("low");
    // a corner of « low » on the floor: only « low »
    const corner = at(-2.9, 2.1, 0);
    expect(zoneUnder(head, [low, high], corner.pan, corner.tilt)?.id).to.equal("low");
    // elsewhere: none; a beam going up never meets a plane below the head
    const away = at(3, 5, 0);
    expect(zoneUnder(head, [low, high], away.pan, away.tilt)).to.equal(undefined);
    expect(zoneUnder(head, [low, high], 0.5, 1)).to.equal(undefined);
  });

  it("finds a zone only on the branch its outline is drawn on, never on the mirror solution where nothing is drawn", () => {
    const head: AimSetup = { position: { x: 0, y: 0, z: 5 }, hung: true, yaw: 0, panMax: 540, tiltMax: 270, panOffset: 0, tiltOffset: 0 };
    const zone = projectZone(head, { id: "z", name: "Z", polygon: [[-1, 3], [1, 3], [1, 5], [-1, 5]], floorHeight: 0, aim: { height: 1.5 } });
    expect(zone.reach).to.equal("full");
    const [pan, tilt] = zone.aim!;
    // a point of the drawn outline's inside (its aiming point): the zone
    expect(zoneUnder(head, [zone], pan, tilt)?.id).to.equal("z");
    // the mirror solution: pan + 180°, the tilt on the other side of the axis; the same beam, but nothing drawn there
    const mirrorPan = pan + 180 / head.panMax;
    const mirrorTilt = 0.5 - (tilt - 0.5);
    expect(mirrorPan).to.be.within(0, 1);
    const [a, b] = [pointing(head, { pan, tilt }), pointing(head, { pan: mirrorPan, tilt: mirrorTilt })];
    expect(b.x).to.be.closeTo(a.x, 1e-9);
    expect(b.y).to.be.closeTo(a.y, 1e-9);
    expect(zoneUnder(head, [zone], mirrorPan, mirrorTilt)).to.equal(undefined);
  });

  it("frames the pad on the zones drawn, square and within the pad, and maps a point both ways", () => {
    const head: AimSetup = { position: { x: 0, y: 1, z: 5 }, hung: true, yaw: 0, panMax: 540, tiltMax: 270, panOffset: 0, tiltOffset: 0 };
    const zone = projectZone(head, { id: "z", name: "Z", polygon: [[-3, 2], [-1, 2], [-1, 4], [-3, 4]], floorHeight: 0, aim: { height: 1.5 } });
    const v = zonesView([zone])!;
    expect(v.x1 - v.x0).to.be.closeTo(v.y1 - v.y0, 1e-9);
    expect(v.x0).to.be.at.least(0);
    expect(v.y1).to.be.at.most(1);
    for (const [pan, tilt] of zone.paths[0]!) {
      const [x, y] = toView(v, pan, tilt);
      expect(x).to.be.within(0.05, 0.95);
      expect(y).to.be.within(0.05, 0.95);
      const back = fromView(v, x, y);
      expect(back[0]).to.be.closeTo(pan, 1e-9);
      expect(back[1]).to.be.closeTo(tilt, 1e-9);
    }
    expect(zonesView([])).to.equal(undefined);
  });

  it("says « outline out of reach » when nothing is drawn but the aiming point is in reach (the chip works)", () => {
    const t = TEXTS.fr.zoneAim;
    expect(zoneStateTexts(t, { reach: "none", aim: [0.5, 0.3] })).to.deep.equal(["contour hors de portée"]);
    expect(zoneStateTexts(t, { reach: "none" })).to.deep.equal(["hors de portée"]);
    expect(zoneStateTexts(t, { reach: "partial" })).to.deep.equal(["en partie hors de portée", "point de visée hors butée"]);
    expect(zoneStateTexts(t, { reach: "full", aim: [0.5, 0.5], axisInside: true })).to.deep.equal(["autour de l'axe de la lyre"]);
  });

  it("says what a zone chip left out: one or several frozen, unplaced apart, the reason without nested brackets", () => {
    const t = TEXTS.fr;
    const names: Record<string, string> = { b: "Lyre B", c: "Lyre C (sol)", d: "Lyre D", e: "Lyre E" };
    expect(leftOut(t, "Estrade", { refused: ["b"] }, (id) => names[id]!)).to.deep.equal(["Figée par le verrou, laissée en place : Lyre B"]);
    expect(leftOut(t, "Estrade", { refused: ["b", "d"] }, (id) => names[id]!)).to.deep.equal(["Figées par le verrou, laissées en place : Lyre B, Lyre D"]);
    expect(
      leftOut(t, "Estrade", { unreachable: [{ fixture: "c", error: "au-delà des butées (pan -120°, tilt 77°)" }, { fixture: "e", error: "position sur la scène inconnue", unplaced: true }] }, (id) => names[id]!),
    ).to.deep.equal(["Position sur la scène inconnue : Lyre E", "Hors de portée : Lyre C (sol) — au-delà des butées : pan −120°, tilt 77°"]);
    expect(reasonText(TEXTS.en, "beyond the stops (pan 12°, tilt -3°)")).to.equal("beyond the stops: pan 12°, tilt −3°");
  });
});
