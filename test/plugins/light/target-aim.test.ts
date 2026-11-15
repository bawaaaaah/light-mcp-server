import { expect } from "chai";
import { aimAt, aimNear, angleCandidates, rawAngles, type AimSetup } from "../../../src/plugins/light/venue/aim.js";
import { aimHead, clampPoint, followTarget, fromNormal, stageBounds, toNormal, type Point3 } from "../../../src/plugins/light/venue/target-aim.js";
import { ZoneSchema } from "../../../src/plugins/light/venue/stage.js";

/**
 * Following a 3D target (T24, lot 1; docs/specs/venue-fixtures-stage.md, « Cible »): the head keeps the solution
 * closest to where it is, so a point moving continuously never sends it the long way round; what it cannot reach, it
 * holds.
 */
const hung = (panMax: number, tiltMax: number, more: Partial<AimSetup> = {}): AimSetup => ({ position: { x: 0, y: 0, z: 5 }, hung: true, yaw: 0, panMax, tiltMax, panOffset: 0, tiltOffset: 0, ...more });

/** The pre-T24 choice (closest to the centre), kept here to check `aimAt` did not change. */
function centreChoice(f: AimSetup, target: Point3): [number, number] | undefined {
  const raw = rawAngles(f, target);
  if (!raw) return undefined;
  return angleCandidates(raw)
    .map(([p, t]) => [p - f.panOffset, t - f.tiltOffset] as [number, number])
    .filter(([p, t]) => Math.abs(p) <= f.panMax / 2 + 1e-9 && Math.abs(t) <= f.tiltMax / 2 + 1e-9)
    .sort((a, b) => {
      const d = Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1]));
      return Math.abs(d) > 1e-6 ? d : Number(a[1] < 0) - Number(b[1] < 0);
    })[0];
}

/**
 * The point sweeping on the floor every 5 cm from −3 m to +3 m: along X at depth `y`, or along Y (`across`) at `y`
 * metres to the side. The head follows it from where it is (`aimNear`), or, `fresh`, as `aimAt` aims a point alone.
 */
function sweep(f: AimSetup, y: number, opts: { across?: boolean; fresh?: boolean } = {}): { point: Point3; pan: number; tilt: number; off: number }[] {
  const out: { point: Point3; pan: number; tilt: number; off: number }[] = [];
  let prev: { pan: number; tilt: number } | undefined;
  for (let k = -60; k <= 60; k++) {
    const point = opts.across ? { x: y, y: k * 0.05, z: 0 } : { x: k * 0.05, y, z: 0 };
    const res = opts.fresh ? aimAt(f, point) : aimNear(f, point, prev);
    if ("error" in res) continue;
    prev = { pan: res.pan, tilt: res.tilt };
    // how far from the head's axis (straight down) the point lies, in degrees
    const off = (Math.atan2(Math.hypot(point.x - f.position.x, point.y - f.position.y), f.position.z - point.z) * 180) / Math.PI;
    out.push({ point, pan: res.pan, tilt: res.tilt, off });
  }
  return out;
}
const panJumps = (path: { pan: number }[], over: number): number => path.slice(1).filter((p, i) => Math.abs(p.pan - path[i]!.pan) > over).length;

describe("following a target (T24)", () => {
  describe("aimNear", () => {
    it("without a previous position, chooses as aimAt always did: closest to the centre", () => {
      const setups = [hung(540, 270), hung(360, 180), { ...hung(540, 270), hung: false, position: { x: 1, y: 2, z: 0.5 }, yaw: 30, panOffset: 12, tiltOffset: -7 }];
      for (const f of setups)
        for (let k = 0; k < 40; k++) {
          const point = { x: -4 + (k % 9), y: -2 + ((k * 7) % 11) * 0.7, z: (k * 3) % 6 };
          const best = centreChoice(f, point);
          const near = aimNear(f, point);
          expect(aimAt(f, point)).to.deep.equal(near);
          if (!best) expect(near).to.have.property("error");
          else expect(near).to.deep.include({ panDeg: best[0], tiltDeg: best[1] });
        }
    });

    it("keeps the branch the head is on instead of swinging it half a turn (pan ± 180°, tilt opposite)", () => {
      const f = hung(540, 270);
      const point = { x: 1, y: -1, z: 0 };
      const centre = aimAt(f, point) as { pan: number; tilt: number; panDeg: number; tiltDeg: number };
      // the head is on the other branch, a little off: it stays on it
      const other = { pan: (centre.panDeg + 180 > 270 ? centre.panDeg - 180 : centre.panDeg + 180) / 540 + 0.5, tilt: -centre.tiltDeg / 270 + 0.5 };
      const near = aimNear(f, point, { pan: other.pan + 0.01, tilt: other.tilt }) as { pan: number; tilt: number };
      expect(near.pan).to.be.closeTo(other.pan, 1e-9);
      expect(near.tilt).to.be.closeTo(other.tilt, 1e-9);
      // both point the same way
      expect(Math.abs(near.pan - centre.pan) * 540).to.be.closeTo(180, 1e-6);
    });

    for (const [panMax, tiltMax] of [[540, 270], [360, 270], [360, 180]] as const) {
      it(`follows a sweep under a ${panMax}/${tiltMax} head with no half turn, through its axis too`, () => {
        for (const [y, across] of [[0, false], [0.3, false], [-0.5, false], [0, true], [1, true], [-0.7, true]] as const) {
          const path = sweep(hung(panMax, tiltMax), y, { across });
          expect(path.length).to.equal(121); // every point in reach
          // 5 cm apart: the pan never moves more than 10 % of its travel
          expect(panJumps(path, 0.1), `${across ? "x" : "y"} = ${y}`).to.equal(0);
          // and it does aim at each point
          for (const p of path) expect(aimHead(hung(panMax, tiltMax), p.point, { pan: p.pan, tilt: p.tilt })).to.deep.include({ pan: p.pan, tilt: p.tilt });
        }
      });
    }

    it("is what aimAt alone would get wrong: the closest to the centre swings half a turn where the pan passes ±90°", () => {
      for (const [panMax, tiltMax] of [[540, 270], [360, 270], [360, 180]] as const) expect(panJumps(sweep(hung(panMax, tiltMax), 1, { across: true, fresh: true }), 0.1)).to.equal(1);
    });

    it("passing just beside the axis, turns the pan fast as it must, but always the same way", () => {
      for (const [panMax, tiltMax] of [[540, 270], [360, 180]] as const) {
        const pans = sweep(hung(panMax, tiltMax), 0.02).map((p) => p.pan);
        const up = pans.every((v, i) => i === 0 || v >= pans[i - 1]! - 1e-12);
        const down = pans.every((v, i) => i === 0 || v <= pans[i - 1]! + 1e-12);
        expect(up || down, `${panMax}/${tiltMax}`).to.equal(true);
        // half a turn around the axis, not more
        expect(Math.abs(pans.at(-1)! - pans[0]!) * panMax).to.be.closeTo(180, 10);
      }
    });

    it("where the tilt cannot pass through the axis, turns the pan once, never back and forth", () => {
      // tilt offset 92°: the head tilts from 2° to 182° of its base axis, never through it (a head mounted askew)
      const f = hung(540, 180, { tiltOffset: 92 });
      for (const y of [0.05, 0.2]) {
        const path = sweep(f, y).filter((p) => p.off > 5); // outside a 5° cone around the axis
        expect(path.length).to.be.above(100);
        expect(panJumps(path, 0.1), `y = ${y}`).to.equal(1);
      }
    });
  });

  describe("aimHead and followTarget", () => {
    const zone = (more: object = {}) => ZoneSchema.parse({ id: "pupitre", name: "Pupitre", polygon: [[-1, -1], [1, -1], [1, 1], [-1, 1]], noAim: true, ...more });

    it("holds a head out of reach, or without a stage position, and says why", () => {
      const narrow = { ...hung(90, 90), hung: false, position: { x: 0, y: 0, z: 0 } };
      expect(aimHead(narrow, { x: 0, y: 5, z: -1 }, undefined)).to.deep.include({ held: true, reason: "out-of-reach" });
      expect(aimHead(undefined, { x: 0, y: 0, z: 0 }, undefined)).to.deep.include({ held: true, reason: "no-position" });
      expect(aimHead(hung(540, 270), { x: 0, y: 0, z: 5 }, undefined)).to.deep.include({ held: true, reason: "out-of-reach" }); // on the head itself
    });

    it("holds every head while the point is in a closed no-aim zone, up to 2.5 m above its floor", () => {
      const setups = new Map([["a", hung(540, 270)], ["b", { ...hung(540, 270), position: { x: 3, y: 0, z: 5 } }], ["c", undefined]]);
      const inside = followTarget({ point: { x: 0.5, y: 0, z: 1.5 }, heads: ["a", "b", "c"], setups, noAim: [zone()] });
      for (const head of ["a", "b", "c"]) expect(inside.get(head)).to.deep.include({ held: true, reason: "no-aim" });
      expect((inside.get("a") as { message: string }).message).to.contain("Pupitre");
      // above the zone's head height, beside it, or no zone closed: the heads follow
      expect(followTarget({ point: { x: 0.5, y: 0, z: 3 }, heads: ["a"], setups, noAim: [zone()] }).get("a")).to.have.property("pan");
      expect(followTarget({ point: { x: 2, y: 0, z: 1 }, heads: ["a"], setups, noAim: [zone()] }).get("a")).to.have.property("pan");
      expect(followTarget({ point: { x: 0.5, y: 0, z: 1.5 }, heads: ["a"], setups }).get("a")).to.have.property("pan");
      // a raised zone: its floor counts
      expect(followTarget({ point: { x: 0, y: 0, z: 0.5 }, heads: ["a"], setups, noAim: [zone({ floorHeight: 1 })] }).get("a")).to.have.property("pan");
      expect(followTarget({ point: { x: 0, y: 0, z: 3 }, heads: ["a"], setups, noAim: [zone({ floorHeight: 1 })] }).get("a")).to.deep.include({ reason: "no-aim" });
    });

    it("chooses from where each head really is", () => {
      const f = hung(540, 270);
      const point = { x: 1, y: -1, z: 0 };
      const a = aimAt(f, point) as { pan: number; tilt: number };
      const flipped = { pan: a.pan > 0.5 ? a.pan - 1 / 3 : a.pan + 1 / 3, tilt: 1 - a.tilt };
      const out = followTarget({ point, heads: ["a"], setups: new Map([["a", f]]), sent: new Map([["a", flipped]]) });
      expect((out.get("a") as { pan: number }).pan).to.be.closeTo(flipped.pan, 1e-9);
    });
  });

  describe("stageBounds", () => {
    it("is the zones' box with a margin, from the floor to above the highest fixture", () => {
      const zones = [{ polygon: [[-3, 0], [3, 0], [3, 4], [-3, 4]] as [number, number][] }, { polygon: [[-1, -2], [1, -2], [1, -1]] as [number, number][] }];
      const b = stageBounds(zones, [{ position: { x: 0, y: 2, z: 6 } }, {}, { position: { x: 9, y: 9, z: 4 } }]);
      expect(b).to.deep.equal({ min: { x: -3.5, y: -2.5, z: 0 }, max: { x: 3.5, y: 4.5, z: 6.5 } });
      // low fixtures: at least 2 m, a standing person's face fits
      expect(stageBounds(zones, [{ position: { x: 0, y: 0, z: 0.5 } }]).max.z).to.equal(2);
    });

    it("without a zone, is a 10 × 8 m stage widened to the placed fixtures", () => {
      expect(stageBounds([], [])).to.deep.equal({ min: { x: -5, y: 0, z: 0 }, max: { x: 5, y: 8, z: 4 } });
      // a row of fixtures alone would leave no depth: the default stage keeps it
      expect(stageBounds([], [{ position: { x: -2, y: 1, z: 5 } }, { position: { x: 2, y: 3, z: 4 } }])).to.deep.equal({ min: { x: -5, y: 0, z: 0 }, max: { x: 5, y: 8, z: 5.5 } });
      expect(stageBounds([], [{ position: { x: -7, y: -1, z: 3 } }, { position: { x: 1, y: 9, z: 2 } }])).to.deep.equal({ min: { x: -7.5, y: -1.5, z: 0 }, max: { x: 5, y: 9.5, z: 4 } });
    });

    it("bounds a point, and turns 0..1 into metres and back", () => {
      const b = { min: { x: -2, y: 0, z: 0 }, max: { x: 2, y: 4, z: 5 } };
      expect(clampPoint({ x: -9, y: 2, z: 7 }, b)).to.deep.equal({ x: -2, y: 2, z: 5 });
      expect(fromNormal("x", 1, b)).to.equal(2);
      expect(fromNormal("x", 1.5, b)).to.equal(2);
      expect(fromNormal("z", 0.5, b)).to.equal(2.5);
      expect(toNormal("y", 1, b)).to.equal(0.25);
      expect(toNormal("y", 9, b)).to.equal(1);
      expect(toNormal("x", 0, { min: { x: 1, y: 0, z: 0 }, max: { x: 1, y: 0, z: 0 } })).to.equal(0);
    });
  });
});
