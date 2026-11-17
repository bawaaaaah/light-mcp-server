import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import type { Position } from "../../../src/plugins/light/engine/move.js";
import { PositionPresetSchema } from "../../../src/plugins/light/show/model.js";
import { ShowRuntime } from "../../../src/plugins/light/show/runtime.js";
import { Venue, type ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";

/**
 * What the show runtime keeps from frame to frame and drops (T48 review): the paths of the split no other test pins —
 * a look leaving under a crossfade and its move, the order the looks leaving compose in, what another show opened
 * forgets, the lock's `held` and when it is written, the looks that light a fixture held by hand.
 */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "light-runtime-state-"));
  const defs = join(dir, "fixtures");
  mkdirSync(defs);
  for (const f of ["spot.qxf", "par-rgb.qxf"]) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(defs, f));
  const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
  venue.fixtures.put({ id: "spot16", name: "Spot 16", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: -2, y: 2, z: 5 }, mount: "hung" });
  venue.fixtures.put({ id: "par", name: "Par", manufacturer: "Test", model: "Par RGB", mode: "3 Channel", universe: 1, address: 21 });
  venue.canvases.put({ id: "lyres", name: "Lyres", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "spot16" }] }] });
  venue.canvases.put({ id: "wash", name: "Wash", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "par" }] }] });
  const clock = { now: 0, beats: 0 };
  const show = new ShowRuntime(new FolderStore(join(dir, "show")), venue, { state: () => ({ beats: clock.beats, bpm: 120 }) }, () => clock.now);
  const look = (id: string, canvas: string, technique: object, fades: [number, number], more: object = {}) =>
    show.looks.put({ id, name: id, canvas, technique, timing: { entryFade: fades[0], exitFade: fades[1] }, ...more } as never);
  let last = new Uint8Array(512);
  /** Frames every 20 ms for `ms` (one at least), render then guard; the last one is kept in `out()`. */
  const run = (ms = 0): void => {
    for (let t = 0; t <= ms; t += 20) {
      last = new Uint8Array(512);
      show.render([last]);
      show.guard([last]);
      clock.now += 20;
      clock.beats += 0.04;
    }
  };
  const pan = (): number => (venue.sentPosition(venue.resolve("spot16") as ResolvedFixture, last) as Position).pan;
  /** The par's red, green and blue bytes on the last frame. */
  const rgb = (): number[] => [...last.slice(20, 23)];
  /** One byte of the last frame (0-based slot). */
  const byte = (slot: number): number => last[slot]!;
  /** Counts the writes of show.json from now on. */
  const writes = (): { count: number } => {
    const seen = { count: 0 };
    const write = show.store.writeManifest.bind(show.store);
    show.store.writeManifest = ((...a: Parameters<typeof write>) => {
      seen.count++;
      return write(...a);
    }) as typeof write;
    return seen;
  };
  return { dir, venue, show, clock, look, run, pan, rgb, byte, writes };
}

const near = (v: number, to: number) => expect(v).to.be.closeTo(to, 2 / 255);

describe("show runtime: state kept and dropped (T48)", () => {
  describe("looks leaving", () => {
    it("a look leaving under a crossfade moves the heads while it has weight, not once its weight is gone", () => {
      const t = setup();
      t.look("a", "lyres", { kind: "plat", color: "#ffffff" }, [0, 0.4], { move: { shape: "fixe", center: { pan: 0.2, tilt: 0.8 } } });
      t.look("b", "lyres", { kind: "plat", color: "#0000ff" }, [3, 0]); // no move: it releases a's heads to rest
      t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
      t.show.go("a");
      t.run(1500);
      near(t.pan(), 0.2);
      t.show.go("b");
      t.run(200); // a still leaves (0.4 s): it holds the head where it put it
      near(t.pan(), 0.2);
      t.run(2300); // a's weight is gone, the crossfade still runs (3 s): the head is back at rest
      near(t.pan(), 0.5);
    });

    it("composes the looks fading out on exit under those leaving under a crossfade", () => {
      const t = setup();
      t.look("x", "wash", { kind: "plat", color: "#ff0000" }, [0, 3]);
      t.look("y", "wash", { kind: "plat", color: "#0000ff" }, [0, 3]);
      t.look("z", "wash", { kind: "aucune" }, [2, 0]); // comes in over y, painting nothing: y leaves outside it
      t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["y", "z"] } });
      t.show.go("x");
      t.show.go("y");
      t.run(500);
      t.show.stop("x");
      t.show.go("z");
      t.run(300);
      const [r, , b] = t.rgb();
      // « last »: the look composed later covers the fixture — y, leaving under the crossfade, over x, fading out
      expect(r).to.equal(0);
      expect(b).to.be.above(0);
    });

    it("counts a look fading out on exit among those lighting a fixture held by hand", () => {
      const t = setup();
      t.look("red", "wash", { kind: "plat", color: "#ff0000" }, [0, 1]);
      t.show.go("red");
      t.run(100);
      t.show.stop("red");
      t.run(100);
      expect(t.show.paintedByLooks("par")).to.equal(true);
      t.run(1100);
      expect(t.show.paintedByLooks("par")).to.equal(false);
    });

    it("drops a crossfade tail's shared sheet with the tail", () => {
      const t = setup();
      for (const id of ["a", "b"]) t.look(id, "wash", { kind: "plat", color: id === "a" ? "#ff0000" : "#00ff00" }, [1, 1]);
      t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
      t.show.go("a");
      t.run(1200);
      t.show.go("b"); // a leaves under b
      t.run(300);
      t.show.stop("b"); // the tail leaves on its own: a and b
      t.run(100);
      t.show.go("a"); // a comes back alone beside that tail: it shares its sheet
      // white box: a stale entry changes no byte (it names a key never used again), it only outlives its tail
      const sheets = (t.show as unknown as { sharedSheet: ReadonlyMap<string, string> }).sharedSheet;
      expect(sheets.size).to.equal(1);
      t.run(2000);
      expect(sheets.size).to.equal(0);
    });
  });

  describe("a launch checked ahead (strictBounds)", () => {
    it("plays its sampled frames on the layer's own course, not from where the heads were before the first", () => {
      const t = setup();
      // slower than a jump between two samples (200 ms), faster than the 2 s glide of the look
      t.show.rules.put({ id: "lent", name: "Lent", level: "show", scope: { fixture: "spot16" }, target: {}, maxDegPerSecond: 400, onViolation: "reject" });
      t.show.positionPresets.put(PositionPresetSchema.parse({ id: "p1", name: "P1", values: { spot16: { pan: 0.1, tilt: 0.5 } } }));
      t.show.positionPresets.put(PositionPresetSchema.parse({ id: "p2", name: "P2", values: { spot16: { pan: 0.15, tilt: 0.5 } } }));
      // its second step leads to a zone gone: the head holds where it is on its way, then glides on from there
      t.look("tour", "lyres", { kind: "aucune" }, [0, 0], { move: { shape: "fixe", every: { seconds: 1 }, fade: { seconds: 2 }, at: { path: { stops: [{ position: "p1" }, { position: "p2" }, { zone: "gone" }] } } } });
      t.run(200);
      near(t.pan(), 0.5);
      // played from what was sent before the first sample on every sample, the hold would send the head back to rest at once
      expect(t.show.strictBounds("tour")).to.deep.equal([]);
    });
  });

  describe("another show opened (resetLive)", () => {
    it("forgets what a look covered through a named position since deleted", () => {
      const t = setup();
      t.show.positionPresets.put(PositionPresetSchema.parse({ id: "pp", name: "Position A", values: { spot16: { pan: 0.3, tilt: 0.7 } } }));
      t.look("at", "lyres", { kind: "aucune" }, [0, 0], { move: { shape: "fixe", at: { position: "pp" } } });
      t.show.go("at");
      t.run(1500);
      near(t.pan(), 0.3);
      t.show.deletePositionPreset("pp"); // the look now holds the heads it covered
      t.show.resetLive();
      t.show.go("at"); // in the other show, the position is unknown and covered nothing: the head goes to rest
      t.run(2000);
      near(t.pan(), 0.5);
    });

    it("starts the targets' points afresh: no glide carried over", () => {
      const t = setup();
      t.show.targets.put({ id: "tg", name: "Cible", fixtures: ["spot16"], point: { x: 0, y: 3, z: 1 }, smoothing: { curve: "linear", msPerStep: 20 } } as never);
      t.show.targetPoint(t.show.targets.get("tg")!);
      t.show.moveTarget("tg", { x: 2 });
      t.clock.now += 100;
      expect(t.show.targetPoint(t.show.targets.get("tg")!).x).to.be.below(2); // on its way
      t.show.resetLive();
      expect(t.show.targetPoint(t.show.targets.get("tg")!).x).to.equal(2);
    });
  });

  describe("the motion lock's held (T26)", () => {
    const held = (dir: string): Record<string, unknown> => (JSON.parse(readFileSync(join(dir, "show", "show.json"), "utf8")) as { motionLock?: { held: Record<string, unknown> } }).motionLock?.held ?? {};

    it("writes where a head is frozen right after the frame that froze it", async () => {
      const t = setup();
      t.show.setMotionLock({ level: "off", heads: { spot16: "soft" } }); // nothing sent yet: frozen on the frame after the first
      t.run(); // the first frame: what is sent
      expect(held(t.dir)).to.deep.equal({});
      t.run(); // frozen there
      await Promise.resolve();
      expect(held(t.dir)).to.have.property("spot16");
    });

    it("an opened show's lock is its own: a soft lock of the show before does not harden it", () => {
      const t = setup();
      t.show.setMotionLock({ level: "off", heads: { spot16: "soft" } });
      t.run(100);
      t.show.store.writeManifest("show.json", { ...t.show.settings, motionLock: { level: "off", heads: { spot16: "hard" }, held: { spot16: { pan: 0.1, tilt: 0.9 } } } });
      t.show.reloadSettings();
      t.run();
      const at = t.show.heldPosition("spot16")!;
      expect(at.pan).to.be.closeTo(0.1, 1e-9);
      expect(at.tilt).to.be.closeTo(0.9, 1e-9);
    });

    it("an opened show's heads glide to where it froze them, over a second at least (decision D4)", () => {
      const t = setup();
      t.show.setMotionLock({ level: "off", heads: { spot16: "soft" } });
      t.run(100);
      near(t.pan(), 0.5);
      t.show.store.writeManifest("show.json", { ...t.show.settings, motionLock: { level: "off", heads: { spot16: "hard" }, held: { spot16: { pan: 0.1, tilt: 0.9 } } } });
      t.show.reloadSettings();
      t.run(600); // past half the glide: on its way
      expect(t.pan()).to.be.within(0.15, 0.45);
      t.run(600);
      near(t.pan(), 0.1);
    });

    it("the hard lock writes the head back over a channel fader, but not on a slot the DMX console parks", () => {
      const t = setup();
      t.show.faders.put({ id: "fp", name: "Pan", channels: [{ fixture: "spot16", offset: 0 }], level: 0 });
      t.show.setMotionLock({ level: "off", heads: { spot16: "hard" } });
      t.run(100); // frozen at rest
      t.show.faders.putLive({ ...t.show.faders.get("fp")!, level: 0.95 });
      t.run(); // whatever the fader writes on its pan
      near(t.pan(), 0.5);
      t.show.consoleSlots = () => new Map([[1, new Set([0])]]);
      t.run();
      expect(t.byte(0)).to.equal(242); // the console's slot: the fader's byte stays
    });

    it("the useful stops bound a channel fader on pan, but not on a slot the DMX console parks", () => {
      const t = setup();
      t.venue.fixtures.put({ ...t.venue.fixtures.get("spot16")!, orientation: { yaw: 0, invertPan: false, invertTilt: false, swapPanTilt: false, panOffset: 0, tiltOffset: 0, limits: { pan: [0, 100], tilt: [0, 180] } } });
      t.show.faders.put({ id: "fp", name: "Pan", channels: [{ fixture: "spot16", offset: 0 }], level: 0.95 });
      t.run(100);
      expect(t.byte(0)).to.be.below(242); // bounded to the stop
      t.show.consoleSlots = () => new Map([[1, new Set([0])]]);
      t.run();
      expect(t.byte(0)).to.equal(242);
    });

    it("an opened show gets no write pending for the show before: a freeze", async () => {
      const t = setup();
      t.show.setMotionLock({ level: "off", heads: { spot16: "soft" } });
      t.run();
      t.run(); // frozen: a write is queued after this frame
      t.show.reloadSettings();
      const seen = t.writes();
      await Promise.resolve();
      expect(seen.count).to.equal(0);
    });

    it("an opened show gets no write pending for the show before: the pad under a soft lock", async () => {
      const t = setup();
      t.show.setMotionLock({ level: "off", heads: { spot16: "soft" } });
      t.run();
      t.run();
      await Promise.resolve();
      t.show.setPosition(["spot16"], { pan: 0.8, tilt: 0.2 });
      t.run(60); // the pad moves the frozen head: written a second after its last move
      t.show.reloadSettings();
      const seen = t.writes();
      t.show.flushHeld();
      expect(seen.count).to.equal(0);
    });
  });

  it("puts back only the colours of fixtures still patched (panic.undo)", () => {
    const t = setup();
    expect(t.show.restoreColours({ par: "#ff0000", ghost: "#00ff00" })).to.deep.equal(["par"]);
    expect(t.show.heldColours()).to.deep.equal({ par: "#ff0000" });
  });
});
