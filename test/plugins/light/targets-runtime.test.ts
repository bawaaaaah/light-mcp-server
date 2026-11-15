import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import type { Position } from "../../../src/plugins/light/engine/move.js";
import { ShowRuntime } from "../../../src/plugins/light/show/runtime.js";
import { Venue, type ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";

/**
 * Targets in the engine (T24, lot 2; docs/specs/venue-fixtures-stage.md, « Cible »): a source of the motion layer. An
 * engaged target claims its heads at the target layer (manual > soft lock > target > looks), the last engaged wins a
 * shared head (a restart too), a head it cannot place holds where it is, a look's move.at.target follows it engaged or
 * not, the point glides with its smoothing, and a show whose targets are neither engaged nor followed sends the same bytes.
 *
 * Two heads: « spot16 » (540°/270°, 16-bit, hung at x −2) and « spot8 » (360°/180°, 8-bit, hung at x +2, pan inverted
 * and axes swapped). One frame every 20 ms.
 */
interface Frame {
  buf: Uint8Array;
  spot16: Position;
  spot8: Position;
}
type Head = "spot16" | "spot8";
const INVERT_SWAP = { yaw: 0, invertPan: true, invertTilt: false, swapPanTilt: true, panOffset: 0, tiltOffset: 0 };

function setup(dir = mkdtempSync(join(tmpdir(), "light-targets-rt-")), fresh = true) {
  const defs = join(dir, "fixtures");
  if (fresh) {
    mkdirSync(defs);
    for (const f of ["spot.qxf", "par-rgb.qxf"]) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(defs, f));
  }
  const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
  if (fresh) {
    venue.fixtures.put({ id: "spot16", name: "Spot 16", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: -2, y: 2, z: 5 }, mount: "hung" });
    venue.fixtures.put({ id: "spot8", name: "Spot 8", manufacturer: "Test", model: "Spot 7", mode: "Basic", universe: 1, address: 11, position: { x: 2, y: 2, z: 5 }, mount: "hung", orientation: INVERT_SWAP });
    venue.fixtures.put({ id: "par", name: "Par", manufacturer: "Test", model: "Par RGB", mode: "3 Channel", universe: 1, address: 21 });
    venue.canvases.put({ id: "lyres", name: "Lyres", topology: "line", cells: 2, render: [{ from: 0, to: 0, targets: [{ fixture: "spot16", head: -1 }] }, { from: 1, to: 1, targets: [{ fixture: "spot8", head: -1 }] }] });
  }
  const clock = { now: 0, beats: 0, bpm: 120 };
  const store = new FolderStore(join(dir, "show"));
  const show = new ShowRuntime(store, venue, { state: () => ({ beats: clock.beats, bpm: clock.bpm }) }, () => clock.now);
  const place = (id: string, move: object, more: object = {}) => show.looks.put({ id, name: id, canvas: "lyres", technique: { kind: "aucune" }, move, ...more } as never);
  const fixed = (id: string, pan: number, tilt: number) => place(id, { shape: "fixe", center: { pan, tilt } });
  const target = (id: string, more: object = {}) => show.targets.put({ id, name: `Cible ${id}`, fixtures: ["spot16", "spot8"], point: { x: 0, y: 2, z: 0 }, ...more });
  const at = (id: string, buf: Uint8Array): Position => venue.sentPosition(venue.resolve(id) as ResolvedFixture, buf) as Position;
  const frame = (): Frame => {
    const buf = new Uint8Array(512);
    show.render([buf]);
    show.guard([buf]);
    return { buf, spot16: at("spot16", buf), spot8: at("spot8", buf) };
  };
  const run = (ms: number, events: [number, () => void][] = []): Frame[] => {
    const frames: Frame[] = [];
    let e = 0;
    for (let t = 0; t <= ms; t += 20) {
      for (; e < events.length && events[e]![0] <= t; e++) events[e]![1]();
      frames.push(frame());
      clock.now += 20;
      clock.beats += (0.02 * clock.bpm) / 60;
    }
    return frames;
  };
  /** How far (degrees) the beam a head is sent points from the point. */
  const offBy = (head: Head, f: Frame, p: { x: number; y: number; z: number }): number => {
    const r = venue.resolve(head) as ResolvedFixture;
    const d = venue.pointingOf(r, f.buf);
    const o = r.patch.position!;
    const v = { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z };
    const cos = (d.x * v.x + d.y * v.y + d.z * v.z) / (Math.hypot(d.x, d.y, d.z) * Math.hypot(v.x, v.y, v.z));
    return (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
  };
  return { dir, venue, store, show, clock, place, fixed, target, frame, run, offBy };
}

const AXES = ["pan", "tilt"] as const;
const steepest = (frames: Frame[], head: Head): number => Math.max(0, ...frames.slice(1).flatMap((f, i) => AXES.map((a) => Math.abs(f[head][a] - frames[i]![head][a]))));
const bytes = (f: Frame) => [...f.buf.slice(0, 24)];
const layer = (t: ReturnType<typeof setup>, head: Head) => t.show.motionStatus().get(head)!.pan;

describe("targets in the engine (T24)", () => {
  it("an engaged target claims its heads: they glide there and point at it, then follow it as it moves", () => {
    const t = setup();
    t.target("t");
    t.run(200);
    t.show.engageTarget("t", true);
    const going = t.run(1400);
    // a glide over the show's moveFade (1 s), never a jump
    expect(steepest(going, "spot16")).to.be.below(0.05);
    expect(steepest(going, "spot8")).to.be.below(0.05);
    const there = going.at(-1)!;
    for (const head of ["spot16", "spot8"] as const) {
      expect(t.offBy(head, there, { x: 0, y: 2, z: 0 })).to.be.below(0.5);
      expect(layer(t, head)).to.include({ layer: "target", owner: "target:t", moving: false });
    }
    // the same claim moving is no transition: the heads follow the point at once (bounded by the speed rules only)
    t.show.moveTarget("t", { x: 1, y: 3 });
    const moved = t.frame();
    expect(t.offBy("spot16", moved, { x: 1, y: 3, z: 0 })).to.be.below(0.5);
    expect(t.offBy("spot8", moved, { x: 1, y: 3, z: 0 })).to.be.below(0.5);
    expect(t.show.lastErrors).to.deep.equal([]);
  });

  it("sits between the manual layer and the looks; disengaged, it hands back to the look, gliding", () => {
    const t = setup();
    t.fixed("a", 0.2, 0.7);
    t.target("t", { fixtures: ["spot16"] });
    t.show.go("a");
    t.run(1200);
    expect(layer(t, "spot16").layer).to.equal("look");
    t.show.engageTarget("t", true);
    t.run(1200);
    expect(layer(t, "spot16")).to.include({ layer: "target", owner: "target:t" });
    expect(t.show.motionStatus().get("spot16")!.masked).to.deep.equal(["look:a"]);
    t.show.setPosition(["spot16"], { pan: 0.6, tilt: 0.6 });
    t.frame();
    expect(layer(t, "spot16").layer).to.equal("manual");
    expect(layer(t, "spot16").layers).to.deep.equal(["manual", "target", "look", "rest"]);
    t.show.releasePositions(["spot16"]);
    t.run(1200);
    expect(layer(t, "spot16").owner).to.equal("target:t");
    t.show.engageTarget("t", false);
    const back = t.run(1400);
    expect(steepest(back, "spot16")).to.be.below(0.05);
    expect(back.at(-1)!.spot16.pan).to.be.closeTo(0.2, 1e-4);
    expect(layer(t, "spot16").owner).to.equal("look:a");
  });

  it("the last engaged of two targets wins a head they share, after a restart too; held, it does not let the other through", () => {
    const t = setup();
    t.target("a", { fixtures: ["spot16"], point: { x: -3, y: 1, z: 0 } });
    t.target("b", { fixtures: ["spot16"], point: { x: -1, y: 3, z: 0 } });
    t.show.engageTarget("a", true, 1000);
    t.show.engageTarget("b", true, 1000); // the same millisecond: still after
    expect(t.show.targets.get("b")!.engagedAt).to.equal(1001);
    t.run(1400);
    expect(layer(t, "spot16").owner).to.equal("target:b");
    expect(t.show.motionStatus().get("spot16")!.masked).to.deep.equal(["target:a"]);
    // a restart: the engagement and its order were written (live, without a backup)
    t.store.flushLive();
    const again = setup(t.dir, false);
    const frames = again.run(1400);
    expect(layer(again, "spot16").owner).to.equal("target:b");
    expect(again.offBy("spot16", frames.at(-1)!, { x: -1, y: 3, z: 0 })).to.be.below(0.5);
    // the winner out of reach (straight above a hung head): the head holds where it is, the other target waits
    const before = frames.at(-1)!.spot16;
    again.show.moveTarget("b", { x: -2, y: 2, z: 7 });
    const held = again.run(400);
    for (const f of held) {
      expect(f.spot16.pan).to.be.closeTo(before.pan, 1e-4);
      expect(f.spot16.tilt).to.be.closeTo(before.tilt, 1e-4);
    }
    expect(layer(again, "spot16")).to.include({ owner: "target:b" });
    expect(layer(again, "spot16").error).to.match(/hors de portée|out of reach/);
    expect(again.show.lastErrors.some((e) => e.startsWith("spot16:"))).to.equal(true);
    // back in reach: it follows again, from where it held
    again.show.moveTarget("b", { x: -1, y: 1, z: 0 });
    const back = again.run(1400);
    expect(steepest(back, "spot16")).to.be.below(0.05);
    expect(again.offBy("spot16", back.at(-1)!, { x: -1, y: 1, z: 0 })).to.be.below(0.5);
  });

  it("holds the heads while the point is in a closed no-aim zone; a look the zone allows opens it", () => {
    const t = setup();
    t.show.zones.put({ id: "pupitre", name: "Pupitre", polygon: [[-0.5, 1.5], [0.5, 1.5], [0.5, 2.5], [-0.5, 2.5]], noAim: true, allowLooks: ["ouvre"] });
    t.place("ouvre", { shape: "fixe", enabled: false });
    t.target("t", { point: { x: 1, y: 3, z: 0 } });
    t.show.engageTarget("t", true);
    const there = t.run(1400).at(-1)!;
    t.show.moveTarget("t", { x: 0, y: 2, z: 1.5 });
    const held = t.run(200);
    expect(held.at(-1)!.spot16).to.deep.equal(there.spot16);
    expect(layer(t, "spot16").error).to.match(/Pupitre/);
    t.show.go("ouvre");
    const open = t.run(1400);
    expect(t.offBy("spot16", open.at(-1)!, { x: 0, y: 2, z: 1.5 })).to.be.below(0.5);
    expect(layer(t, "spot16").error).to.equal(undefined);
  });

  it("with a smoothing, the point glides there in the time asked, and starts where it is when engaged", () => {
    const t = setup();
    // 2 ms per step of 1/255 of the bounds: a whole width in 510 ms, half in 255 ms
    t.target("t", { bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } }, point: { x: 0, y: 2, z: 0 }, smoothing: { curve: "linear", msPerStep: 2 } });
    t.show.engageTarget("t", true);
    t.frame();
    expect(t.show.targetPoint(t.show.targets.get("t")!).x).to.equal(0);
    t.show.moveTarget("t", { x: 5 });
    t.frame(); // seen at its new value: the glide starts
    const start = t.clock.now;
    const xs: [number, number][] = [];
    for (let k = 0; k < 20; k++) {
      t.clock.now += 20;
      t.frame();
      xs.push([t.clock.now - start, t.show.targetPoint(t.show.targets.get("t")!).x]);
    }
    const halfway = xs.find(([ms]) => ms === 120)![1];
    expect(halfway).to.be.closeTo((5 * 120) / 255, 0.05);
    expect(xs.find(([ms]) => ms >= 260)![1]).to.equal(5);
    // a target engaged again starts on its point, no glide from where it was before
    t.show.engageTarget("t", false);
    t.show.moveTarget("t", { x: 9 });
    t.show.engageTarget("t", true);
    expect(t.show.targetPoint(t.show.targets.get("t")!).x).to.equal(9);
  });

  it("a look's move.at.target aims each head at the target, engaged or not; a target gone holds them, and says so", () => {
    const t = setup();
    t.target("t", { point: { x: 0, y: 3, z: 0 } });
    t.place("suit", { shape: "fixe", at: { target: "t" } });
    t.show.go("suit");
    const there = t.run(1400).at(-1)!;
    expect(t.offBy("spot16", there, { x: 0, y: 3, z: 0 })).to.be.below(0.5);
    expect(t.offBy("spot8", there, { x: 0, y: 3, z: 0 })).to.be.below(0.5);
    expect(layer(t, "spot16")).to.include({ layer: "look", owner: "look:suit" });
    // the target moves: the look follows it
    t.show.moveTarget("t", { x: 1 });
    expect(t.offBy("spot16", t.frame(), { x: 1, y: 3, z: 0 })).to.be.below(0.5);
    // a circle drawn around each head's aim
    t.place("cercle", { shape: "cercle", size: { pan: 0.05, tilt: 0.05 }, at: { target: "t" } });
    t.show.go("cercle");
    const turning = t.run(2000);
    expect(Math.max(...turning.slice(60).map((f) => t.offBy("spot16", f, { x: 1, y: 3, z: 0 })))).to.be.above(3);
    t.show.stop("cercle");
    t.run(1400);
    t.show.targets.delete("t");
    const gone = t.run(200);
    expect(gone.at(-1)!.spot16).to.deep.equal(gone[0]!.spot16);
    expect(t.show.lastErrors.some((e) => /cible inconnue : t|unknown target: t/.test(e))).to.equal(true);
  });

  it("a soft lock masks the target, a hard one too; « rendre la main » releases it on a head until engaged again", () => {
    const t = setup();
    t.fixed("a", 0.3, 0.6);
    t.target("t");
    t.show.go("a");
    t.show.engageTarget("t", true);
    t.run(1400);
    t.show.setMotionLock({ level: "soft", heads: {} });
    t.frame();
    expect(layer(t, "spot16").layer).to.equal("lock");
    expect(layer(t, "spot16").layers).to.deep.equal(["lock", "target", "look", "rest"]);
    t.show.setMotionLock({ level: "hard", heads: {} });
    t.frame();
    expect(layer(t, "spot16").layers).to.deep.equal(["lock", "target", "look", "rest"]);
    expect(t.show.motionStatus().get("spot16")!.masked).to.deep.equal(["target:t", "look:a"]);
    t.show.setMotionLock({ level: "off", heads: {} });
    t.run(1400);
    expect(layer(t, "spot16").owner).to.equal("target:t");
    // « rendre la main » on one head: the target goes from it, the look takes it, the other head keeps following
    expect(t.show.releaseTop(["spot16"])).to.deep.equal([{ fixture: "spot16", released: ["target:t"] }]);
    const back = t.run(1400);
    expect(steepest(back, "spot16")).to.be.below(0.05);
    expect(layer(t, "spot16").owner).to.equal("look:a");
    expect(layer(t, "spot8").owner).to.equal("target:t");
    // engaged again, without being disengaged first (decision T-a): a new claim, it takes the head again
    t.show.engageTarget("t", true);
    t.run(1400);
    expect(layer(t, "spot16").owner).to.equal("target:t");
  });

  it("engaging a target already engaged puts it back on top and lifts « Rendre la main » on it (decision T-a)", () => {
    const t = setup();
    t.target("a", { fixtures: ["spot16"], point: { x: -3, y: 1, z: 0 } });
    t.target("b", { fixtures: ["spot16"], point: { x: -1, y: 3, z: 0 } });
    t.show.engageTarget("a", true, 1000);
    t.show.engageTarget("b", true, 2000);
    t.run(1400);
    expect(layer(t, "spot16").owner).to.equal("target:b");
    expect(t.show.engageTarget("a", true, 1500).engagedAt).to.equal(2001); // never before the last engaged
    const back = t.run(1400);
    expect(layer(t, "spot16").owner).to.equal("target:a");
    expect(steepest(back, "spot16")).to.be.below(0.05);
    expect(t.offBy("spot16", back.at(-1)!, { x: -3, y: 1, z: 0 })).to.be.below(0.5);
    // released on its head twice (a, then b): « Engager » again brings the head back to it
    t.show.releaseTop(["spot16"]);
    t.show.releaseTop(["spot16"]);
    t.run(200);
    expect(layer(t, "spot16").layer).to.equal("rest");
    t.show.engageTarget("b", true, 4000);
    t.run(1400);
    expect(layer(t, "spot16")).to.include({ layer: "target", owner: "target:b" });
    // disengaging a target that is not engaged changes nothing
    const off = t.show.engageTarget("a", false);
    expect(t.show.engageTarget("a", false)).to.equal(off);
    expect(off).to.include({ engaged: false, engagedAt: 2001 });
  });

  it("a shape around a target aims from its own base: a circle right below a head stays a circle, a large one never jumps", () => {
    const t = setup();
    // right below spot16 (hung at x −2, y 2): on its axis, the pan is free; the base must not drift with the circle
    t.target("t", { point: { x: -2, y: 2, z: 0 } });
    t.place("cercle", { shape: "cercle", size: { pan: 0.05, tilt: 0.05 }, at: { target: "t" } });
    t.show.go("cercle");
    const below = t.run(8000).slice(100);
    const pans = below.map((f) => f.spot16.pan);
    expect(Math.max(...pans) - Math.min(...pans)).to.be.below(0.11);
    expect(steepest(below, "spot16")).to.be.below(0.02);
    t.show.stop("cercle");
    t.run(1500);
    // a large circle around a point beside the axis: no half turn of the base
    t.target("t", { point: { x: -2, y: 2.6, z: 0 } });
    for (const size of [0.2, 0.3, 0.4]) {
      const id = `c${size * 10}`;
      t.place(id, { shape: "cercle", size: { pan: size, tilt: 0.02 }, at: { target: "t" } });
      t.show.go(id);
      const turning = t.run(6000).slice(100);
      const range = turning.map((f) => f.spot16.pan);
      expect(steepest(turning, "spot16"), `size ${size}`).to.be.below(0.03);
      expect(Math.max(...range) - Math.min(...range), `size ${size}`).to.be.closeTo(2 * size, 0.01);
      t.show.stop(id);
      t.run(1500);
    }
  });

  it("a look restarted on a smoothed target starts where its point is, not from the glide it left (deleted and re-created too)", () => {
    const t = setup();
    const bounds = { min: { x: -5, y: 0, z: 0 }, max: { x: 5, y: 8, z: 4 } };
    t.target("t", { bounds, point: { x: -4, y: 2, z: 0 }, smoothing: { curve: "linear", msPerStep: 20 } });
    t.place("suit", { shape: "fixe", at: { target: "t" }, fade: { seconds: 0 } });
    t.show.go("suit");
    t.run(1500);
    t.show.stop("suit");
    t.run(3000);
    t.show.moveTarget("t", { x: 4 });
    t.run(3000);
    t.show.go("suit");
    t.frame();
    expect(t.show.targetPoint(t.show.targets.get("t")!).x).to.equal(4);
    // deleted while followed, then created again elsewhere with the same id
    t.run(200);
    t.show.targets.delete("t");
    t.run(200);
    t.target("t", { bounds, point: { x: -3, y: 2, z: 0 }, smoothing: { curve: "linear", msPerStep: 20 } });
    t.frame();
    expect(t.show.targetPoint(t.show.targets.get("t")!).x).to.equal(-3);
  });

  it("a target crossing the line where the two aims swap: neither head jumps (the closest to where it is)", () => {
    const t = setup();
    const bounds = { min: { x: -5, y: -5, z: 0 }, max: { x: 5, y: 8, z: 4 } };
    // one metre beside each head, along Y through its foot (target-aim.test.ts `sweep(…, 1, { across: true })`)
    t.target("g", { fixtures: ["spot16"], bounds, point: { x: -1, y: -1, z: 0 } });
    t.target("d", { fixtures: ["spot8"], bounds, point: { x: 3, y: -1, z: 0 } });
    t.show.engageTarget("g", true, 1);
    t.show.engageTarget("d", true, 2);
    t.run(1400);
    const path: Frame[] = [];
    for (let k = -60; k <= 60; k++) {
      t.show.moveTarget("g", { y: 2 + k * 0.05 });
      t.show.moveTarget("d", { y: 2 + k * 0.05 });
      path.push(t.frame());
      t.clock.now += 20;
    }
    expect(steepest(path, "spot16")).to.be.below(0.1);
    expect(steepest(path, "spot8")).to.be.below(0.1);
    expect(t.offBy("spot16", path.at(-1)!, { x: -1, y: 5, z: 0 })).to.be.below(0.5);
    expect(t.offBy("spot8", path.at(-1)!, { x: 3, y: 5, z: 0 })).to.be.below(0.5);
  });

  it("target.fade sets how its heads take over when it is engaged", () => {
    const t = setup();
    t.target("vite", { fixtures: ["spot16"], fade: { seconds: 0 } });
    t.target("lent", { fixtures: ["spot8"], fade: { seconds: 3 } });
    t.run(200);
    t.show.engageTarget("vite", true, 1);
    t.show.engageTarget("lent", true, 2);
    const going = t.run(1400);
    // direct: there on the first frames; over 3 s: still on its way after the show's 1 s
    expect(t.offBy("spot16", going[1]!, { x: 0, y: 2, z: 0 })).to.be.below(0.5);
    expect(t.offBy("spot8", going.at(-1)!, { x: 0, y: 2, z: 0 })).to.be.above(2);
    const there = t.run(2000);
    expect(t.offBy("spot8", there.at(-1)!, { x: 0, y: 2, z: 0 })).to.be.below(0.5);
  });

  it("a snapshot's point outside the target's bounds is put back bounded", () => {
    const t = setup();
    t.target("t", { bounds: { min: { x: -2, y: 0, z: 0 }, max: { x: 2, y: 4, z: 3 } } });
    t.show.applySnapshot({ id: "s", name: "S", looks: [], groups: {}, faders: {}, targets: { t: { point: { x: 9, y: -9, z: 9 }, engaged: false } } } as never);
    expect(t.show.targets.get("t")!.point).to.deep.equal({ x: 2, y: 0, z: 3 });
  });

  it("sends the same bytes when its targets are neither engaged nor followed", () => {
    const play = (withTargets: boolean) => {
      const t = setup();
      t.fixed("a", 0.2, 0.7);
      t.place("cercle", { shape: "cercle", size: { pan: 0.2, tilt: 0.1 } });
      if (withTargets) {
        t.target("t", { smoothing: { curve: "ease", msPerStep: 5 } });
        t.target("u", { fixtures: [], group: "nobody" });
      }
      return t
        .run(4000, [
          [0, () => t.show.go("a")],
          [1000, () => (withTargets ? t.show.moveTarget("t", { x: 3 }) : undefined)],
          [1500, () => t.show.go("cercle")],
          [2500, () => t.show.setPosition(["spot8"], { pan: 0.4 })],
          [3000, () => t.show.holdPositions()],
        ])
        .map(bytes);
    };
    expect(play(true)).to.deep.equal(play(false));
  });

  it("strictBounds changes nothing while a target is engaged and its point glides", () => {
    const play = (check: boolean): number[][] => {
      const t = setup();
      t.show.rules.put({ id: "pan-max", name: "Pan max", level: "show", scope: { fixture: "spot16" }, target: { channel: "Pan" }, max: 250, onViolation: "reject" });
      t.fixed("a", 0.2, 0.3);
      t.target("t", { smoothing: { curve: "ease", msPerStep: 4 } });
      const checked = () => {
        if (check) t.show.strictBounds("a");
      };
      return t
        .run(3000, [
          [0, () => t.show.engageTarget("t", true, 1)],
          [300, checked],
          [600, () => t.show.moveTarget("t", { x: 2, y: 4 })],
          [700, checked],
          [760, checked],
          [1500, () => t.show.go("a")],
          [1600, checked],
        ])
        .map(bytes);
    };
    expect(play(true)).to.deep.equal(play(false));
  });
});
