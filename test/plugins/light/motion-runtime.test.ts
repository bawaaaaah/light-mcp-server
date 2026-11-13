import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import type { Position } from "../../../src/plugins/light/engine/move.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { ShowRuntime } from "../../../src/plugins/light/show/runtime.js";
import { emptyFrame, Venue, type ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";

/**
 * The motion layer in the engine (T25, lot 2; docs/specs/engine-effects-timing.md, « Couche Mouvement »): the claims
 * the runtime builds (looks, raw pan/tilt, manual), the position read back after the guard, and no jump, frame by
 * frame, through launches, stops, crossfades, relaunches, manual positions, releases and a Panic. One frame every
 * 20 ms, like the fades of T2.
 *
 * Two heads: « spot16 » (16-bit pan/tilt, channels 1-4, dimmer 6) and « spot8 » (8-bit, channels 11-12, dimmer 13),
 * the second with its pan inverted and its axes swapped.
 */
/** One frame: the output, and where each head is in it (logical position, inversions and swap undone). */
interface Frame {
  buf: Uint8Array;
  spot16: Position;
  spot8: Position;
}
const INVERT_SWAP = { yaw: 0, invertPan: true, invertTilt: false, swapPanTilt: true, panOffset: 0, tiltOffset: 0 };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "light-motion-rt-"));
  const defs = join(dir, "fixtures");
  mkdirSync(defs);
  for (const f of ["spot.qxf", "par-rgb.qxf"]) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(defs, f));
  const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
  venue.fixtures.put({ id: "spot16", name: "Spot 16", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: -2, y: 2, z: 5 }, mount: "hung" });
  venue.fixtures.put({ id: "spot8", name: "Spot 8", manufacturer: "Test", model: "Spot 7", mode: "Basic", universe: 1, address: 11, position: { x: 2, y: 2, z: 5 }, mount: "hung", orientation: INVERT_SWAP });
  venue.fixtures.put({ id: "par", name: "Par", manufacturer: "Test", model: "Par RGB", mode: "3 Channel", universe: 1, address: 21 });
  venue.canvases.put({ id: "lyres", name: "Lyres", topology: "line", cells: 2, render: [{ from: 0, to: 0, targets: [{ fixture: "spot16", head: -1 }] }, { from: 1, to: 1, targets: [{ fixture: "spot8", head: -1 }] }] });
  const clock = { now: 0, beats: 0, bpm: 120 };
  const show = new ShowRuntime(new FolderStore(join(dir, "show")), venue, { state: () => ({ beats: clock.beats, bpm: clock.bpm }) }, () => clock.now);
  /** A look that only places the heads: a fixed position, or any move. */
  const place = (id: string, move: object, more: object = {}) => show.looks.put({ id, name: id, canvas: "lyres", technique: { kind: "aucune" }, move, ...more } as never);
  const fixed = (id: string, pan: number, tilt: number, more: object = {}) => place(id, { shape: "fixe", center: { pan, tilt } }, more);
  const at = (id: string, buf: Uint8Array): Position => venue.sentPosition(venue.resolve(id) as ResolvedFixture, buf) as Position;
  /** `guarded`: the guard runs on the frame, as in the engine; `force`: what the DMX console writes before it. */
  const frame = (opts: { guarded?: boolean; force?: (b: Uint8Array) => void } = {}): Frame => {
    const buf = new Uint8Array(512);
    show.render([buf]);
    opts.force?.(buf);
    if (opts.guarded || opts.force) show.guard([buf]);
    return { buf, spot16: at("spot16", buf), spot8: at("spot8", buf) };
  };
  const tick = () => {
    clock.now += 20;
    clock.beats += (0.02 * clock.bpm) / 60;
  };
  /** Frames every 20 ms for `ms`, `events` played at their time (ms from the start of the run) before the frame. */
  const run = (ms: number, events: [number, () => void][] = [], opts: { guarded?: boolean } = {}): Frame[] => {
    const frames: Frame[] = [];
    let e = 0;
    for (let t = 0; t <= ms; t += 20) {
      for (; e < events.length && events[e]![0] <= t; e++) events[e]![1]();
      frames.push(frame(opts));
      tick();
    }
    return frames;
  };
  return { venue, show, clock, place, fixed, frame, run, tick };
}

type Rig = ReturnType<typeof setup>;
type Head = "spot16" | "spot8";
const AXES = ["pan", "tilt"] as const;
/** The largest change of a head's position from one frame to the next, either axis. */
const steepest = (frames: Frame[], head: Head): number => Math.max(0, ...frames.slice(1).flatMap((f, i) => AXES.map((a) => Math.abs(f[head][a] - frames[i]![head][a]))));
/** The values an axis takes, in order, without repeats. */
const path = (frames: Frame[], head: Head, axis: "pan" | "tilt"): number[] => frames.map((f) => f[head][axis]).filter((v, i, all) => i === 0 || v !== all[i - 1]);
const monotonic = (values: number[]): boolean => values.every((v, i) => i === 0 || v >= values[i - 1]!) || values.every((v, i) => i === 0 || v <= values[i - 1]!);
/** A glide over `gap` in `seconds` moves at most 1.5 × gap / seconds a second (smoothstep): per 20 ms frame, plus one step of an 8-bit axis. */
const slope = (gap: number, seconds: number): number => (1.5 * gap * 0.02) / seconds + 1 / 255;
const bytes = (f: Frame, from: number, count: number): number[] => [...f.buf.slice(from, from + count)];
/** A head at its rest, the centre: 0.5 written is 32768 of 65535 (or 128 of 255) read. */
const centred = (p: { pan: number; tilt: number }, eps = 1e-4): void => {
  expect(p.pan).to.be.closeTo(0.5, eps);
  expect(p.tilt).to.be.closeTo(0.5, eps);
};

describe("motion layer in the engine (T25)", () => {
  describe("rest", () => {
    it("holds every head at the centre when nothing claims it, to the byte", () => {
      const t = setup();
      const frames = t.run(1500);
      for (const f of frames) {
        expect(bytes(f, 0, 4)).to.deep.equal([128, 0, 128, 0]);
        expect(bytes(f, 10, 2)).to.deep.equal([128, 128]);
      }
    });

    it("sends a head to its rest position from the show, and ignores the ids that are no moving head", () => {
      const t = setup();
      t.show.saveSettings({ restPositions: { spot16: { pan: 0.3, tilt: 0.6 }, par: { pan: 0, tilt: 0 }, ghost: { pan: 1, tilt: 1 } } });
      const frames = t.run(400);
      expect(frames[0]!.spot16.pan).to.be.closeTo(0.3, 1e-4);
      expect(frames[0]!.spot16.tilt).to.be.closeTo(0.6, 1e-4);
      expect(steepest(frames, "spot16")).to.be.below(1e-4);
      expect(bytes(frames.at(-1)!, 20, 3)).to.deep.equal([0, 0, 0]); // the par has no rest: nothing is written there
      expect(t.show.lastErrors).to.deep.equal([]);
      // a rest position changed while the head is there: it glides to the new one
      t.show.saveSettings({ restPositions: { spot16: { pan: 0.7, tilt: 0.6 } } });
      const moved = t.run(1500);
      expect(steepest(moved, "spot16")).to.be.at.most(slope(0.4, 1));
      expect(moved.at(-1)!.spot16.pan).to.be.closeTo(0.7, 1e-4);
    });
  });

  describe("looks", () => {
    it("glides to a look's position on launch and back to rest when it stops, never a jump", () => {
      const t = setup();
      t.fixed("a", 0.2, 0.8);
      const frames = t.run(4000, [
        [200, () => t.show.go("a")],
        [2000, () => t.show.stop("a")],
      ]);
      for (const head of ["spot16", "spot8"] as const) {
        expect(steepest(frames, head), head).to.be.at.most(slope(0.3, 1));
        expect(frames[10]![head].pan, head).to.be.closeTo(0.5, 1 / 255); // the frame of the launch: still where it was
        expect(frames[75]![head].pan, head).to.be.closeTo(0.2, 1 / 255); // 1.3 s later: there
        expect(frames[75]![head].tilt, head).to.be.closeTo(0.8, 1 / 255);
        expect(frames.at(-1)![head].pan, head).to.be.closeTo(0.5, 1 / 255); // back to rest
        expect(monotonic(path(frames.slice(0, 100), head, "pan")), head).to.equal(true);
        expect(monotonic(path(frames.slice(100), head, "pan")), head).to.equal(true);
      }
      expect(bytes(frames[75]!, 0, 4)).to.deep.equal([51, 51, 204, 204]); // 0.2 and 0.8 in 16 bits
      // the swapped head: its pan channel carries the tilt, its tilt channel the pan, inverted
      expect(bytes(frames[75]!, 10, 2)).to.deep.equal([204, 204]);
    });

    it("uses the fine channel on the way: a slow glide never steps a whole coarse value", () => {
      const t = setup();
      t.show.saveSettings({ moveFade: { seconds: 4 } });
      t.fixed("a", 0.6, 0.5);
      const frames = t.run(4200, [[0, () => t.show.go("a")]]);
      const pan16 = frames.map((f) => f.buf[0]! * 256 + f.buf[1]!);
      expect(Math.max(...pan16.slice(1).map((v, i) => v - pan16[i]!))).to.be.below(256);
      expect(new Set(pan16).size).to.be.greaterThan(150);
      expect(pan16.at(-1)).to.equal(Math.round(0.6 * 65535));
    });

    it("takes the look's own `move.fade`, in seconds or in beats at the tempo of the show; 0 cuts", () => {
      const t = setup();
      t.fixed("slow", 0.9, 0.5, { move: { shape: "fixe", center: { pan: 0.9, tilt: 0.5 }, fade: { seconds: 3 } } });
      t.fixed("beats", 0.1, 0.5, { move: { shape: "fixe", center: { pan: 0.1, tilt: 0.5 }, fade: { beats: 2 } } });
      t.fixed("cut", 0.5, 0.2, { move: { shape: "fixe", center: { pan: 0.5, tilt: 0.2 }, fade: { seconds: 0 } } });
      const slow = t.run(3200, [[0, () => t.show.go("slow")]]);
      expect(slow[75]!.spot16.pan).to.be.closeTo(0.7, 0.01); // half-way at 1.5 s
      expect(slow.at(-1)!.spot16.pan).to.be.closeTo(0.9, 1e-4);
      // two beats at 60 BPM: two seconds
      t.clock.bpm = 60;
      const beats = t.run(2200, [[0, () => t.show.go("beats")]]);
      expect(beats[50]!.spot16.pan).to.be.closeTo(0.5, 0.01); // half-way at 1 s
      expect(beats[99]!.spot16.pan).to.be.above(0.1 + 1e-4); // not there before the two seconds
      expect(beats.at(-1)!.spot16.pan).to.be.closeTo(0.1, 1e-4);
      t.show.go("cut");
      const cut = t.frame().spot16;
      expect(cut.pan).to.be.closeTo(0.5, 1e-4);
      expect(cut.tilt).to.be.closeTo(0.2, 1e-4);
    });

    it("glides onto a shape that turns, and off it", () => {
      const t = setup();
      t.place("circle", { shape: "cercle", size: { pan: 0.2, tilt: 0.1 }, every: { beats: 8 } });
      const frames = t.run(6000, [
        [0, () => t.show.go("circle")],
        [4000, () => t.show.stop("circle")],
      ]);
      // the circle itself moves 2π × 0.2 every 4 s; the glide adds its own slope at most
      const turning = (2 * Math.PI * 0.2 * 0.02) / 4;
      expect(steepest(frames, "spot16")).to.be.at.most(turning + slope(0.2, 1));
      expect(frames[100]!.spot16.pan).to.be.closeTo(0.5 + 0.2 * Math.sin((2 * Math.PI * 2) / 4), 1e-3); // on the circle after 2 s
      centred(frames.at(-1)!.spot16);
    });

    it("keeps a leaving look's move to the end of its exit fade, then glides", () => {
      const t = setup();
      t.fixed("a", 0.2, 0.5, { timing: { exitFade: 1 } });
      const frames = t.run(4500, [
        [0, () => t.show.go("a")],
        [1500, () => t.show.stop("a")],
      ]);
      expect(frames[120]!.spot16.pan).to.be.closeTo(0.2, 1e-4); // 0.9 s into its exit fade: still its position
      expect(steepest(frames, "spot16")).to.be.at.most(slope(0.3, 1));
      centred(frames.at(-1)!.spot16);
    });

    it("crosses from a look to the next of its exclusive group without a jump, colours fading or not", () => {
      for (const fades of [{}, { timing: { entryFade: 2, exitFade: 2 } }]) {
        const t = setup();
        t.fixed("a", 0.2, 0.3, fades);
        t.fixed("b", 0.8, 0.7, fades);
        t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
        const frames = t.run(5000, [
          [0, () => t.show.go("a")],
          [1500, () => t.show.go("b")],
        ]);
        for (const head of ["spot16", "spot8"] as const) {
          expect(steepest(frames, head), head).to.be.at.most(slope(0.6, 1));
          expect(frames.at(-1)![head].pan, head).to.be.closeTo(0.8, 1 / 255);
          expect(monotonic(path(frames.slice(75), head, "pan")), head).to.equal(true);
        }
      }
    });

    for (const share of [0.25, 0.5, 0.75])
      it(`starts a look again ${share * 100} % into the glide to the next: from where the head is, between the two`, () => {
        const t = setup();
        t.fixed("a", 0.2, 0.5);
        t.fixed("b", 0.8, 0.5);
        t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
        const frames = t.run(5000, [
          [0, () => t.show.go("a")],
          [1500, () => t.show.go("b")],
          [1500 + share * 1000, () => t.show.go("a")],
        ]);
        // a head turned back first brakes: the cubic leaves at the speed it had, at most twice the slope of a glide from rest
        expect(steepest(frames, "spot16")).to.be.at.most(2 * slope(0.6, 1));
        const after = frames.slice(75).map((f) => f.spot16.pan);
        expect(Math.min(...after)).to.be.at.least(0.2 - 1e-4);
        expect(Math.max(...after)).to.be.at.most(0.8 + 1e-4);
        expect(frames.at(-1)!.spot16.pan).to.be.closeTo(0.2, 1e-4);
      });

    it("lets the last look launched win, head by head, and hands back to the one below when it stops", () => {
      const t = setup();
      t.fixed("ambiance", 0.2, 0.5);
      t.show.groups.put({ id: "jardin", name: "Jardin", members: { fixtures: ["spot16"] } });
      t.place("accent", { shape: "fixe", center: { pan: 0.9, tilt: 0.5 }, group: "jardin", fade: { seconds: 0 } });
      const frames = t.run(5000, [
        [0, () => t.show.go("ambiance")],
        [1500, () => t.show.go("accent")],
        [2500, () => t.show.stop("accent")],
      ]);
      expect(frames[76]!.spot16.pan).to.be.closeTo(0.9, 1e-4); // the accent cuts in (its own fade of 0)
      expect(frames[76]!.spot8.pan).to.be.closeTo(0.2, 1 / 255); // the other head stays with the ambiance
      expect(t.show.motionStatus().get("spot16")!.pan).to.include({ layer: "look", owner: "look:ambiance" });
      // handing back is a release: it glides over the show's moveFade, even though the accent cut
      expect(steepest(frames.slice(100), "spot16")).to.be.at.most(slope(0.7, 1));
      expect(frames.at(-1)!.spot16.pan).to.be.closeTo(0.2, 1e-4);
    });
  });

  describe("manual positions", () => {
    it("follows the pad at once, axis by axis, and glides back to the look on release", () => {
      const t = setup();
      t.fixed("a", 0.2, 0.3);
      t.run(1500, [[0, () => t.show.go("a")]]);
      t.show.setPosition(["spot16"], { tilt: 0.9 });
      const held = t.frame();
      expect(held.spot16.tilt).to.be.closeTo(0.9, 1e-4); // direct (R8)
      expect(held.spot16.pan).to.be.closeTo(0.2, 1e-4); // the pan stays the look's
      expect(t.show.manualPosition("spot16")).to.deep.equal({ pan: held.spot16.pan, tilt: 0.9 });
      const status = t.show.motionStatus().get("spot16")!;
      expect([status.pan.layer, status.tilt.layer]).to.deep.equal(["look", "manual"]);
      expect(status.masked).to.deep.equal([]);
      t.show.setPosition(["spot16"], { pan: 0.6 }); // the second axis joins the claim
      t.tick();
      expect(t.frame().spot16).to.deep.include({ pan: 0.6 });
      expect(t.show.motionStatus().get("spot16")!.masked).to.deep.equal(["look:a"]);
      const frames = t.run(1500, [[100, () => t.show.releasePositions(["spot16"])]]);
      expect(steepest(frames, "spot16")).to.be.at.most(slope(0.6, 1));
      expect(frames.at(-1)!.spot16.pan).to.be.closeTo(0.2, 1e-4);
      expect(frames.at(-1)!.spot16.tilt).to.be.closeTo(0.3, 1e-4);
      expect(t.show.manualPosition("spot16")).to.equal(undefined);
    });

    it("glides to a destination recalled (« glide »), each command a new claim", () => {
      const t = setup();
      const frames = t.run(3000, [
        [0, () => t.show.setPosition(["spot16", "spot8"], { pan: 0.9, tilt: 0.1 }, "glide")],
        [1500, () => t.show.setPosition(["spot16", "spot8"], { pan: 0.1, tilt: 0.1 }, "glide")],
      ]);
      for (const head of ["spot16", "spot8"] as const) {
        expect(steepest(frames, head), head).to.be.at.most(slope(0.8, 1));
        expect(frames[70]![head].pan, head).to.be.closeTo(0.9, 1 / 255);
        expect(frames.at(-1)![head].pan, head).to.be.closeTo(0.1, 1 / 255);
      }
    });

    it("stays on a head the timeline launches a look over", () => {
      const t = setup();
      t.fixed("a", 0.2, 0.3);
      t.show.setPosition(["spot16"], { pan: 0.7, tilt: 0.7 });
      const frames = t.run(1500, [[200, () => t.show.go("a")]]);
      expect(steepest(frames, "spot16")).to.equal(0);
      expect(frames.at(-1)!.spot8.pan).to.be.closeTo(0.2, 1 / 255); // the other head follows the look
    });
  });

  describe("handing back (the hooks of the commands)", () => {
    it("releases what holds a head, one layer at a time, down to its rest", () => {
      const t = setup();
      t.fixed("a", 0.2, 0.3);
      t.show.go("a");
      t.show.setPosition(["spot16"], { pan: 0.7, tilt: 0.7 });
      t.run(1500);
      expect(t.show.releaseTop(["spot16"])).to.deep.equal([{ fixture: "spot16", released: ["manual"] }]);
      expect(t.show.manualPosition("spot16")).to.equal(undefined); // the manual claim is gone, not only hidden
      const toLook = t.run(1500);
      expect(steepest(toLook, "spot16")).to.be.at.most(slope(0.5, 1));
      expect(toLook.at(-1)!.spot16.pan).to.be.closeTo(0.2, 1e-4);
      expect(t.show.releaseTop(["spot16"])).to.deep.equal([{ fixture: "spot16", released: ["look:a"] }]);
      const toRest = t.run(1500);
      expect(steepest(toRest, "spot16")).to.be.at.most(slope(0.3, 1));
      centred(toRest.at(-1)!.spot16);
      expect(toRest.at(-1)!.spot8.pan).to.be.closeTo(0.2, 1 / 255); // the look still plays on the other head
      expect(t.show.motionStatus().get("spot16")!.released).to.have.length(1);
      expect(t.show.releaseTop(["spot16"])).to.deep.equal([{ fixture: "spot16", released: [] }]); // nothing left to release
      // started again, the look claims the head again
      t.show.stop("a");
      t.show.go("a");
      expect(t.run(1500).at(-1)!.spot16.pan).to.be.closeTo(0.2, 1e-4);
    });

    it("sends heads home: every claim released, they glide to rest; all the heads when none is named", () => {
      const t = setup();
      t.show.saveSettings({ restPositions: { spot16: { pan: 0.4, tilt: 0.6 } } });
      t.fixed("a", 0.2, 0.3);
      t.show.go("a");
      t.show.setPosition(["spot16"], { pan: 0.9, tilt: 0.9 });
      t.run(1500);
      const homed = t.show.homePositions();
      expect(homed.map((h) => [h.fixture, h.released.sort()])).to.deep.equal([
        ["spot16", ["look:a", "manual"]],
        ["spot8", ["look:a"]],
      ]);
      const frames = t.run(1500);
      expect(steepest(frames, "spot16")).to.be.at.most(slope(0.5, 1));
      expect(frames.at(-1)!.spot16.pan).to.be.closeTo(0.4, 1e-4);
      expect(frames.at(-1)!.spot16.tilt).to.be.closeTo(0.6, 1e-4);
      centred(frames.at(-1)!.spot8, 1 / 255);
      expect(t.show.manualPosition("spot16")).to.equal(undefined);
      expect(t.show.homePositions(["par", "ghost"])).to.deep.equal([]); // not moving heads
    });

    it("freezes a head under the lock hook (T26): « off » until then", () => {
      const t = setup();
      t.fixed("a", 0.2, 0.3);
      expect(t.show.motionLock("spot16")).to.equal("off");
      t.show.motionLock = (head) => (head === "spot16" ? "hard" : "off");
      const frames = t.run(1500, [[0, () => t.show.go("a")]]);
      expect(steepest(frames, "spot16")).to.equal(0);
      expect(frames.at(-1)!.spot8.pan).to.be.closeTo(0.2, 1 / 255);
      expect(t.show.motionStatus().get("spot16")!.lock).to.equal("hard");
    });
  });

  describe("Panic", () => {
    it("moves no head by itself: they hold where they are, mid-glide included", () => {
      const t = setup();
      t.place("circle", { shape: "cercle", size: { pan: 0.2, tilt: 0.1 }, every: { beats: 4 } }, { timing: { exitFade: 2 } });
      t.run(1700, [[0, () => t.show.go("circle")]]);
      t.show.setPosition(["spot8"], { pan: 0.9, tilt: 0.9 }, "glide");
      const before = t.run(300).at(-1)!; // spot8 is gliding to its manual position, spot16 turns
      t.show.holdPositions();
      t.show.stopAll();
      t.show.releasePositions();
      const frames = t.run(3000);
      for (const f of frames) {
        expect(bytes(f, 0, 4)).to.deep.equal(bytes(before, 0, 4));
        expect(bytes(f, 10, 2)).to.deep.equal(bytes(before, 10, 2));
      }
      expect(t.show.motionStatus().get("spot16")!.pan.layer).to.equal("hold");
    });

    it("lets the safe look glide in from where the heads hold", () => {
      const t = setup();
      t.fixed("a", 0.2, 0.3);
      t.fixed("safe", 0.5, 0.9);
      t.run(1500, [[0, () => t.show.go("a")]]);
      t.show.holdPositions();
      t.show.stopAll();
      t.show.go("safe");
      const frames = t.run(1500);
      expect(frames[0]!.spot16.pan).to.be.closeTo(0.2, 1e-4);
      expect(steepest(frames, "spot16")).to.be.at.most(slope(0.6, 1));
      expect(frames.at(-1)!.spot16.tilt).to.be.closeTo(0.9, 1e-4);
      // the hold is over once claimed: stopped, the head goes to rest
      t.show.stop("safe");
      centred(t.run(1500).at(-1)!.spot16);
    });

    it("holds a head where it really is under a speed rule, not where it was asked to go", () => {
      const t = setup();
      t.show.saveSettings({ moveFade: { seconds: 0 } });
      t.show.rules.put({ id: "doux", name: "Doux", level: "venue", scope: { fixture: "spot16" }, target: {}, maxDegPerSecond: 90, locked: false });
      t.fixed("far", 1, 0.5);
      t.run(100, [], { guarded: true }); // the rule has seen the head at rest
      const going = t.run(1000, [[0, () => t.show.go("far")]], { guarded: true });
      const reached = going.at(-1)!.spot16.pan;
      expect(reached).to.be.closeTo(0.5 + 90 / 540, 0.01); // 90° of its 540 in a second: far from the 1 asked
      expect(t.show.sentPosition("spot16")!.pan).to.equal(reached);
      t.show.holdPositions();
      t.show.stopAll();
      const held = t.run(2000, [], { guarded: true });
      expect(steepest(held, "spot16")).to.equal(0);
      expect(held.at(-1)!.spot16.pan).to.equal(reached);
    });

    it("the `panic` command holds the heads, and undoing it restores no motion state: the looks glide back", async () => {
      const dataRoot = join(mkdtempSync(join(tmpdir(), "light-motion-panic-")), "data");
      mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
      copyFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), join(dataRoot, "fixtures", "spot.qxf"));
      const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      let now = 0;
      const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null, now: () => now });
      const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
      plugin.venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1 });
      plugin.venue.canvases.put({ id: "spot", name: "Spot", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "spot", head: -1 }] }] });
      plugin.runtime.looks.put({ id: "a", name: "A", canvas: "spot", technique: { kind: "aucune" }, move: { shape: "fixe", center: { pan: 0.2, tilt: 0.8 } } });
      const pan = () => {
        const b = plugin.engine.render()[0]!;
        now += 20;
        return (b[0]! * 256 + b[1]!) / 65535;
      };
      const during = (ms: number) => Array.from({ length: ms / 20 }, pan);
      await run("look.go", { id: "a" });
      expect(during(1500).at(-1)).to.be.closeTo(0.2, 1e-4);
      await run("position.set", { fixtures: ["spot"], pan: 0.7 });
      expect(pan()).to.be.closeTo(0.7, 1e-4);
      await run("panic"); // no safe state: Blackout, which keeps pan/tilt
      expect(plugin.engine.isBlackout()).to.equal(true);
      expect(new Set(during(3000).map((v) => v.toFixed(4)))).to.deep.equal(new Set(["0.7000"])); // neither to rest nor back to the look
      await run("panic.undo");
      const back = during(1500);
      expect(back[0]).to.be.closeTo(0.7, 1e-3); // from where it held
      expect(Math.max(...back.slice(1).map((v, i) => Math.abs(v - back[i]!)))).to.be.at.most(slope(0.5, 1));
      expect(back.at(-1)).to.be.closeTo(0.2, 1e-4); // the look is back; the manual position stays released
      await plugin.stop?.();
    });
  });

  describe("raw pan/tilt of a look (imported scenes)", () => {
    const scene = (t: Rig, id: string, writes: [string, number, number][], more: object = {}) =>
      t.show.looks.put({ id, name: id, canvas: "lyres", technique: { kind: "aucune" }, channels: { targets: writes.map(([fixture, offset]) => ({ fixture, offset })), steps: [writes.map(([, , v]) => v)] }, ...more } as never);

    it("glides to the bytes of the scene and lands on them exactly: 16 bits, coarse alone, inverted and swapped axes", () => {
      const t = setup();
      // spot16: pan coarse + fine, tilt coarse alone, and its dimmer; spot8: both axes
      scene(t, "s", [["spot16", 0, 200], ["spot16", 1, 17], ["spot16", 2, 40], ["spot16", 5, 180], ["spot8", 0, 30], ["spot8", 1, 220]]);
      const frames = t.run(1500, [[100, () => t.show.go("s")]]);
      expect(bytes(frames[4]!, 0, 4)).to.deep.equal([128, 0, 128, 0]);
      expect(steepest(frames, "spot16")).to.be.at.most(slope(0.35, 1));
      expect(steepest(frames, "spot8")).to.be.at.most(slope(0.4, 1));
      const end = frames.at(-1)!;
      expect(bytes(end, 0, 4)).to.deep.equal([200, 17, 40, 0]); // a fine byte the scene does not write is 0
      expect(bytes(end, 10, 2)).to.deep.equal([30, 220]);
      expect(end.buf[5]).to.equal(180); // its other raw channels go down as they did
      // the logical position: the swapped head's pan channel is its tilt, its tilt channel its pan, inverted
      expect(end.spot8.tilt).to.be.closeTo(30 / 255, 1e-9);
      expect(end.spot8.pan).to.be.closeTo(1 - 220 / 255, 1e-9);
      expect(t.show.motionStatus().get("spot16")!.pan).to.include({ layer: "look", owner: "look:s" });
    });

    it("obeys the manual layer, claims only the axes it writes, and the last scene launched wins", () => {
      const t = setup();
      t.fixed("move", 0.3, 0.3);
      scene(t, "tilt-only", [["spot16", 2, 230]]);
      scene(t, "pan-only", [["spot16", 0, 20], ["spot16", 1, 0]]);
      scene(t, "pan-high", [["spot16", 0, 240], ["spot16", 1, 0]]);
      t.run(1500, [[0, () => (t.show.go("move"), t.show.go("tilt-only"))]]);
      const both = t.frame();
      expect(both.spot16.pan).to.be.closeTo(0.3, 1e-4); // the pan is the move's
      expect(bytes(both, 2, 2)).to.deep.equal([230, 0]); // the tilt the scene's
      t.show.go("pan-high");
      t.show.go("pan-only"); // launched last: it wins, though its byte is the lowest
      expect(bytes(t.run(1500).at(-1)!, 0, 4)).to.deep.equal([20, 0, 230, 0]);
      t.show.setPosition(["spot16"], { pan: 0.9 });
      const manual = t.frame();
      expect(manual.spot16.pan).to.be.closeTo(0.9, 1e-4); // the pad passes over the scene
      expect(bytes(manual, 2, 2)).to.deep.equal([230, 0]);
      t.show.releasePositions();
      t.show.stop("pan-only");
      const back = t.run(1500);
      expect(steepest(back, "spot16")).to.be.at.most(slope(0.9, 1));
      expect(bytes(back.at(-1)!, 0, 2)).to.deep.equal([240, 0]); // the scene below takes the axis back
    });

    it("says the axis is animated while the scene steps through other pan/tilt bytes, not when its steps keep them", () => {
      const t = setup();
      const stepping = (id: string, steps: number[][]) =>
        t.show.looks.put({ id, name: id, canvas: "lyres", technique: { kind: "aucune" }, timing: { every: { seconds: 0.2 } }, channels: { targets: [{ fixture: "spot16", offset: 0 }, { fixture: "spot16", offset: 5 }], steps } } as never);
      stepping("moving", [[40, 10], [200, 10]]);
      stepping("still", [[40, 10], [40, 200]]); // only the dimmer changes from step to step
      t.show.go("moving");
      const frames = t.run(2000).slice(-30); // once the entry glide is over
      const pans = new Set(frames.map((f) => f.buf[0]));
      expect(pans.has(40) && pans.has(200)).to.equal(true); // the steps really move the head
      expect(t.show.motionStatus().get("spot16")!.pan).to.include({ layer: "look", owner: "look:moving", moving: false, animated: true });
      expect(t.show.motionStatus().get("spot8")!.pan.animated).to.equal(undefined); // not written by the scene
      t.show.stop("moving");
      t.show.go("still");
      t.run(1500);
      expect(t.show.motionStatus().get("spot16")!.pan).to.include({ owner: "look:still" });
      expect(t.show.motionStatus().get("spot16")!.pan.animated).to.equal(undefined);
    });

    it("places nothing from a fine channel alone, and leaves a fixture without a definition as it was", () => {
      const t = setup();
      t.venue.fixtures.put({ id: "nodef", name: "No definition", manufacturer: "Test", model: "Unknown", mode: "x", universe: 1, address: 40 });
      scene(t, "s", [["spot16", 1, 99], ["spot16", 3, 99], ["nodef", 0, 77]]);
      const frames = t.run(1500, [[0, () => t.show.go("s")]]);
      expect(bytes(frames.at(-1)!, 0, 4)).to.deep.equal([128, 0, 128, 0]);
      expect(frames.at(-1)!.buf[39]).to.equal(77); // raw by address, at once
      expect(frames[0]!.buf[39]).to.equal(77);
    });
  });

  describe("what is really sent", () => {
    it("starts a glide from the position the guard let out, not from the one asked (a speed rule)", () => {
      const t = setup();
      t.show.rules.put({ id: "doux", name: "Doux", level: "venue", scope: { fixture: "spot16" }, target: {}, maxDegPerSecond: 90, locked: false });
      t.fixed("far", 1, 0.5, { move: { shape: "fixe", center: { pan: 1, tilt: 0.5 }, fade: { seconds: 0 } } });
      const frames = t.run(
        3100,
        [
          [100, () => t.show.go("far")],
          [1100, () => t.show.stop("far")],
        ],
        { guarded: true },
      );
      const top = Math.max(...frames.map((f) => f.spot16.pan));
      expect(top).to.be.closeTo(0.5 + 90 / 540, 0.01); // it never went on towards 1 after the stop
      expect(steepest(frames, "spot16")).to.be.at.most((90 / 540) * 0.02 + 1e-3);
      expect(frames.at(-1)!.spot16.pan).to.be.closeTo(0.5, 1e-4);
    });

    it("reads the DMX console's forcing back: a look launched over it starts from the forced position", () => {
      const t = setup();
      t.fixed("a", 0.9, 0.5);
      const force = (b: Uint8Array) => {
        b[0] = 26;
        b[1] = 0;
      };
      for (let i = 0; i < 3; i++) {
        t.frame({ force });
        t.tick();
      }
      expect(t.show.sentPosition("spot16")!.pan).to.equal((26 * 256) / 65535);
      t.show.go("a");
      const frames = t.run(1500, [], { guarded: true });
      expect(frames[0]!.spot16.pan).to.be.closeTo(0.1, 0.002);
      expect(steepest(frames, "spot16")).to.be.at.most(slope(0.8, 1));
      expect(frames.at(-1)!.spot16.pan).to.be.closeTo(0.9, 1e-4);
    });

    it("cuts or glides an axis by the box of the channel it drives, swap included (fadeable tracks)", () => {
      const t = setup();
      // on the swapped head the logical tilt drives the Pan channel: only that box is ticked
      t.venue.fixtures.put({ ...t.venue.fixtures.get("spot8")!, overrides: { tracks: { enabled: true, fade: ["Pan"] } } });
      t.fixed("a", 0.2, 0.8);
      const frames = t.run(1500, [[100, () => t.show.go("a")]]);
      expect(frames[5]!.spot8.pan).to.be.closeTo(0.2, 1 / 255); // through the Tilt channel, unticked: at once
      expect(frames[5]!.spot8.tilt).to.be.closeTo(0.5, 2 / 255); // through the Pan channel: on its way
      expect(frames.at(-1)!.spot8.tilt).to.be.closeTo(0.8, 1 / 255);
    });
  });

  describe("strictBounds", () => {
    const rule = (t: Rig, max: number) => t.show.rules.put({ id: "pan-max", name: "Pan max", level: "show", scope: { fixture: "spot16" }, target: { channel: "Pan" }, max, onViolation: "reject" });

    it("changes nothing: the same frames with and without a launch checked in the middle of a glide", () => {
      const play = (check: boolean): number[][] => {
        const t = setup();
        rule(t, 250);
        t.fixed("a", 0.2, 0.3, { timing: { entryFade: 1, exitFade: 1 } });
        t.fixed("b", 0.8, 0.7, { timing: { entryFade: 1, exitFade: 1 } });
        t.place("circle", { shape: "cercle", size: { pan: 0.2, tilt: 0.1 } });
        t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
        const checked = (id: string) => () => {
          if (check) t.show.strictBounds(id);
        };
        return t
          .run(6000, [
            [0, () => t.show.go("a")],
            [300, checked("b")],
            [500, checked("circle")],
            [1500, () => t.show.go("b")],
            [1700, checked("a")],
            [1720, checked("circle")],
            [2000, () => t.show.setPosition(["spot8"], { pan: 0.4 }, "glide")],
            [2200, checked("a")],
            [2400, () => t.show.go("a")],
            [2600, checked("b")],
            [3000, () => t.show.holdPositions()],
            [3100, checked("circle")],
            [3500, () => t.show.go("circle")],
            [3600, checked("b")],
            [4500, () => t.show.releaseTop()],
            [4600, checked("b")],
          ])
          .map((f) => bytes(f, 0, 16));
      };
      expect(play(true)).to.deep.equal(play(false));
    });

    it("bounds a launch by where the head lands, however long the glide there", () => {
      const t = setup();
      rule(t, 200);
      t.fixed("soon", 1, 0.5);
      t.fixed("late", 1, 0.5, { move: { shape: "fixe", center: { pan: 1, tilt: 0.5 }, fade: { seconds: 30 } } });
      t.fixed("inside", 0.7, 0.5);
      t.run(200);
      expect(t.show.strictBounds("soon")).to.have.length(1); // there within a second: beyond the limit
      expect(t.show.strictBounds("late")).to.have.length(1); // thirty seconds to get there: the arrival is sampled too
      expect(t.show.strictBounds("inside")).to.have.length(0);
      // and a launch checked takes no launch order: the next claim is the one a launch alone would get
      t.show.go("soon");
      t.show.setPosition(["spot16"], { tilt: 0.1 });
      t.frame();
      expect(t.show.motionStatus().get("spot16")!.released).to.deep.equal([]);
    });
  });
});

describe("motion layer: a speed rule that refuses or asks", () => {
  it("refuses the launch whose glide is faster than the rule, lets a slower one through", () => {
    const t = setup();
    t.show.rules.put({ id: "lent", name: "Lent", level: "show", scope: { fixture: "spot16" }, target: {}, maxDegPerSecond: 90, onViolation: "reject" });
    t.fixed("fast", 1, 0.5); // 270° of pan in the second of the show's moveFade
    t.fixed("cut", 1, 0.5, { move: { shape: "fixe", center: { pan: 1, tilt: 0.5 }, fade: { seconds: 0 } } });
    t.fixed("slow", 1, 0.5, { move: { shape: "fixe", center: { pan: 1, tilt: 0.5 }, fade: { seconds: 10 } } }); // 40°/s at its fastest
    t.fixed("near", 0.52, 0.5); // 11° in a second
    t.show.groups.put({ id: "cour", name: "Cour", members: { fixtures: ["spot8"] } });
    t.place("other", { shape: "fixe", center: { pan: 1, tilt: 0.5 }, group: "cour" }); // the head the rule does not cover
    t.run(200, [], { guarded: true });
    for (const [id, bounded] of [["fast", 1], ["cut", 1], ["slow", 0], ["near", 0], ["other", 0]] as const) {
      const bounds = t.show.strictBounds(id);
      expect(bounds.map((b) => b.rule.id), id).to.deep.equal(bounded ? ["lent"] : []);
      if (bounded) expect(bounds[0]!.clamps.map((c) => [c.fixture, c.channel]), id).to.deep.equal([["spot16", "Pan"]]);
    }
    // a head already turning faster than the rule is not held against a look that leaves it alone
    t.show.go("fast");
    t.run(200, [], { guarded: true });
    expect(t.show.strictBounds("other")).to.have.length(0);
  });

  it("measures the speed for a caller's own rule too, from where the heads are", () => {
    const t = setup();
    t.show.rules.put({ id: "ia-lent", name: "Lent pour l'IA", level: "show", scope: {}, target: {}, maxDegPerSecond: 90, appliesTo: { origins: ["mcp"] } });
    t.fixed("cut", 1, 0.5, { move: { shape: "fixe", center: { pan: 1, tilt: 0.5 }, fade: { seconds: 0 } } });
    t.run(200);
    expect(t.show.strictBounds("cut")).to.have.length(0); // the rule is not this caller's
    expect(t.show.strictBounds("cut", { origin: "mcp" }).map((b) => b.rule.id)).to.deep.equal(["ia-lent"]);
  });
});

describe("motion layer through the commands", () => {
  let plugin: LightPlugin;
  let now = 0;
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  /** One frame of the engine (render, console, guard, Blackout), 20 ms on: the pan sent to the head, 0..1. */
  const pan = () => {
    const b = plugin.engine.render()[0]!;
    now += 20;
    return (b[0]! * 256 + b[1]!) / 65535;
  };
  const during = (ms: number) => Array.from({ length: ms / 20 }, pan);
  const steepestOf = (values: number[]) => Math.max(0, ...values.slice(1).map((v, i) => Math.abs(v - values[i]!)));
  interface Why {
    rawLooks: { id: string }[];
    motion?: { axis: string; layer: string; owner: string | null; name?: string; moving: boolean; from?: number; to?: number; remainingMs?: number; masked: { owner: string; name?: string; released?: true }[] };
  }
  const why = (channel: number) => run("dmx.explain", { universe: 1, channel }) as Promise<Why>;

  beforeEach(() => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-motion-cmd-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), join(dataRoot, "fixtures", "spot.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    now = 0;
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null, now: () => now });
    plugin.venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1 });
    plugin.venue.canvases.put({ id: "spot", name: "Spot", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "spot", head: -1 }] }] });
    const look = (id: string, name: string, more: object) => plugin.runtime.looks.put({ id, name, canvas: "spot", technique: { kind: "aucune" }, ...more } as never);
    look("a", "A", { move: { shape: "fixe", center: { pan: 0.2, tilt: 0.8 } } });
    look("b", "B", { move: { shape: "fixe", center: { pan: 0.8, tilt: 0.8 } } });
    look("scene", "Scène", { channels: { targets: [{ fixture: "spot", offset: 0 }], steps: [[128]] } });
  });
  afterEach(async () => {
    await plugin.stop();
  });

  it("a Panic again under a channel forced from the DMX console holds the head where it is then, not where it first held", async () => {
    await run("look.go", { id: "a" });
    expect(during(1500).at(-1)).to.be.closeTo(0.2, 1e-4);
    await run("panic");
    expect(during(500).at(-1)).to.be.closeTo(0.2, 1e-4);
    await run("dmx.set", { universe: 1, values: { "1": 230, "2": 0 } });
    const forced = (230 * 256) / 65535;
    expect(during(500).at(-1)).to.equal(forced);
    await run("panic"); // it releases the console: the head must not swing back
    expect(new Set(during(1000))).to.deep.equal(new Set([forced]));
    expect((await why(1)).motion).to.include({ layer: "hold", owner: null, moving: false });
  });

  it("`position.release` lets a head out of the hold a Panic left: it glides to rest", async () => {
    await run("look.go", { id: "a" });
    during(1500);
    await run("panic");
    during(500);
    expect(await run("position.release", { fixtures: ["spot"] })).to.deep.equal({ released: ["spot"] });
    const back = during(1500);
    expect(back[0]).to.be.closeTo(0.2, 1e-3);
    expect(steepestOf(back)).to.be.at.most(slope(0.3, 1));
    expect(back.at(-1)).to.be.closeTo(0.5, 1e-4);
    expect(await run("position.release")).to.deep.equal({ released: [] }); // nothing held any more
    // without a Panic it releases the manual position only, as before: the look takes the head back
    await run("look.go", { id: "a" });
    await run("position.set", { fixtures: ["spot"], pan: 0.6 });
    during(200);
    expect(await run("position.release")).to.deep.equal({ released: ["spot"] });
    expect(during(1500).at(-1)).to.be.closeTo(0.2, 1e-4);
  });

  it("`position.home` releases everything on a head and sends it to its rest, gliding", async () => {
    await run("position.rest.set", { fixtures: ["spot"], pan: 0.4, tilt: 0.5 });
    await run("look.go", { id: "a" });
    await run("position.set", { fixtures: ["spot"], pan: 0.9 });
    during(1500);
    const homed = (await run("position.home", { fixtures: ["spot"] })) as { fixtures: { fixture: string; released: string[] }[] };
    expect(homed.fixtures.map((h) => [h.fixture, [...h.released].sort()])).to.deep.equal([["spot", ["look:a", "manual"]]]);
    const back = during(1500);
    expect(steepestOf(back)).to.be.at.most(slope(0.5, 1));
    expect(back.at(-1)).to.be.closeTo(0.4, 1e-4);
    expect(plugin.runtime.isActive("a")).to.equal(true); // the look plays on: it only lost this head
    expect((await why(1)).motion).to.deep.include({ layer: "rest", masked: [{ owner: "look:a", name: "A", released: true }] });
    // out of a Panic hold too, which it tells
    await run("panic");
    during(200);
    expect(((await run("position.home")) as typeof homed).fixtures).to.deep.equal([{ fixture: "spot", released: ["hold"] }]);
    let refused = "";
    await run("position.home", { fixtures: ["nope"] }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("nope");
  });

  it("`dmx.explain` on pan/tilt names who holds the axis, the glide under way, and who is masked", async () => {
    during(100);
    expect((await why(1)).motion).to.deep.include({ axis: "pan", layer: "rest", owner: null, moving: false, masked: [] });
    expect((await why(4)).motion).to.include({ axis: "tilt", layer: "rest" }); // the fine channel of the tilt
    expect((await why(6)).motion).to.equal(undefined); // the dimmer: not the motion layer's
    await run("look.go", { id: "scene" });
    during(1500);
    const raw = await why(1);
    expect(raw.motion).to.include({ layer: "look", owner: "look:scene", name: "Scène" });
    expect(raw.rawLooks.map((l) => l.id)).to.deep.equal(["scene"]); // it writes the channel and holds the axis
    expect((await why(3)).motion).to.include({ layer: "rest" }); // it does not write the tilt
    await run("look.go", { id: "a" });
    during(400);
    const gliding = await why(1);
    expect(gliding.motion).to.include({ layer: "look", owner: "look:a", name: "A", moving: true, to: 0.2 });
    expect(gliding.motion!.from).to.be.closeTo(128 / 255.996, 1e-3);
    expect(gliding.motion!.remainingMs).to.be.within(550, 650);
    expect(gliding.motion!.masked).to.deep.equal([{ owner: "look:scene", name: "Scène" }]);
    expect(gliding.rawLooks).to.deep.equal([]); // the scene writes the channel but no longer places the head
    during(1000);
    await run("position.set", { fixtures: ["spot"], pan: 0.6 });
    during(40);
    const manual = await why(2);
    expect(manual.motion).to.include({ layer: "manual", owner: "manual", moving: false });
    expect(manual.motion!.masked.map((m) => m.owner)).to.deep.equal(["look:scene", "look:a"]);
  });
});

describe("motion layer: handing back a Panic hold", () => {
  it("tells the hold among what `releaseTop` released", () => {
    const t = setup();
    t.fixed("a", 0.2, 0.3);
    t.run(1500, [[0, () => t.show.go("a")]]);
    t.show.holdPositions();
    t.show.stopAll();
    t.run(200);
    expect(t.show.releaseTop(["spot16"])).to.deep.equal([{ fixture: "spot16", released: ["hold"] }]);
    expect(t.show.releaseHold()).to.deep.equal(["spot8"]); // the other head, by the hook of `position.release`
    expect(t.show.releaseHold()).to.deep.equal([]);
    const frames = t.run(1500);
    expect(steepest(frames, "spot16")).to.be.at.most(slope(0.3, 1));
    centred(frames.at(-1)!.spot16);
    centred(frames.at(-1)!.spot8, 1 / 255);
  });
});

describe("venue.readPosition: the exact inverse of the position written", () => {
  const ORIENTATIONS = [
    undefined,
    { yaw: 0, invertPan: true, invertTilt: false, swapPanTilt: false, panOffset: 0, tiltOffset: 0 },
    { yaw: 0, invertPan: false, invertTilt: true, swapPanTilt: true, panOffset: 0, tiltOffset: 0 },
    { yaw: 0, invertPan: true, invertTilt: true, swapPanTilt: true, panOffset: 0, tiltOffset: 0 },
  ];
  const rig = (mode: "Standard" | "Basic") => {
    const dir = mkdtempSync(join(tmpdir(), "light-readpos-"));
    const defs = join(dir, "fixtures");
    mkdirSync(defs);
    copyFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), join(defs, "spot.qxf"));
    const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
    ORIENTATIONS.forEach((orientation, i) => venue.fixtures.put({ id: `h${i}`, name: `H${i}`, manufacturer: "Test", model: "Spot 7", mode, universe: 1, address: 1 + i * 10, ...(orientation ? { orientation } : {}) }));
    const heads = ORIENTATIONS.map((_, i) => venue.resolve(`h${i}`) as ResolvedFixture);
    /** Reads every head's position in `buf`, writes it again: the bytes that come out. */
    const again = (buf: Uint8Array): Uint8Array => {
      const frame = emptyFrame();
      for (const r of heads) frame.positions.set(r.patch.id, venue.sentPosition(r, buf) as Position);
      const out = new Uint8Array(512);
      venue.toDmx(frame, [out], new Map(), { now: 0, merge: "last" });
      return out;
    };
    return { venue, heads, again };
  };

  it("gives back the same bytes in 16 bits, whatever the inversions and the swap (idempotent round trip)", () => {
    const { again } = rig("Standard");
    const buf = new Uint8Array(512);
    // every coarse value with fine values spread over the byte, and the ends
    const values = [...Array.from({ length: 65536 / 5 }, (_, k) => k * 5), 255, 256, 32767, 32768, 65279, 65280, 65535];
    for (const pan of values) {
      const tilt = (pan * 40503 + 12345) & 0xffff;
      for (let i = 0; i < ORIENTATIONS.length; i++) buf.set([pan >> 8, pan & 255, tilt >> 8, tilt & 255], i * 10);
      const out = again(buf);
      for (let i = 0; i < ORIENTATIONS.length; i++) expect([...out.slice(i * 10, i * 10 + 4)], `orientation ${i}, pan ${pan}`).to.deep.equal([...buf.slice(i * 10, i * 10 + 4)]);
    }
  });

  it("gives back the same bytes in 8 bits, every value", () => {
    const { again } = rig("Basic");
    const buf = new Uint8Array(512);
    for (let pan = 0; pan < 256; pan++) {
      const tilt = (pan * 167 + 13) & 255;
      for (let i = 0; i < ORIENTATIONS.length; i++) buf.set([pan, tilt], i * 10);
      const out = again(buf);
      for (let i = 0; i < ORIENTATIONS.length; i++) expect([...out.slice(i * 10, i * 10 + 2)], `orientation ${i}, pan ${pan}`).to.deep.equal([pan, tilt]);
    }
  });

  it("undoes the swap and the inversions, and leaves out an axis whose coarse byte is not known", () => {
    const { venue, heads } = rig("Standard");
    const plain = heads[0]!;
    expect(venue.readPosition(plain, (o) => [255, 255, 0, 0][o])).to.deep.equal({ pan: 1, tilt: 0 });
    expect(venue.readPosition(plain, (o) => (o === 0 ? 128 : undefined))).to.deep.equal({ pan: (128 * 256) / 65535 }); // coarse alone: fine 0, no tilt
    expect(venue.readPosition(plain, (o) => (o === 1 ? 128 : undefined))).to.deep.equal({}); // a fine byte alone places nothing
    const swapped = heads[2]!; // tilt inverted, axes swapped: the Pan channel carries the tilt
    expect(venue.readPosition(swapped, (o) => (o === 0 ? 255 : o === 1 ? 255 : undefined))).to.deep.equal({ tilt: 0 });
    expect(venue.readPosition(swapped, (o) => (o === 2 ? 255 : o === 3 ? 255 : undefined))).to.deep.equal({ pan: 1 });
  });
});
