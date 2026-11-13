import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import type { Position } from "../../../src/plugins/light/engine/move.js";
import type { HeadMotionEntry } from "../../../src/plugins/light/show/motion-report.js";

/**
 * « Figer les lyres » in the engine (T26, lot 2; docs/specs/engine-effects-timing.md, « Couche Mouvement », Verrou):
 * the lock plugged into the motion layer, the hard lock's bytes frozen in the guard (the DMX console still passes,
 * decision Q4), `held` taken on a freeze and followed by the pad, the glide out of a lock, snapshots, Panic and a
 * restart. One engine frame every 20 ms, time injected; no output route (nothing leaves the machine).
 *
 * Two heads of the same model: « spot » (channels 1-7: pan, pan fine, tilt, tilt fine, wheel, dimmer, shutter) and
 * « spot2 » (11-17).
 */
const SPOT = 0;
const SPOT2 = 10;

describe("motion lock in the engine (T26)", () => {
  let plugin: LightPlugin;
  let dataRoot: string;
  let now = 0;
  const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  const start = () => {
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null, now: () => now });
  };
  /** One engine frame (render, DMX console, guard, Blackout), 20 ms on: a copy of universe 1. */
  const frame = (): Uint8Array => {
    (plugin.engine as unknown as { frame(now: number): void }).frame(now);
    now += 20;
    return Uint8Array.from(plugin.engine.output.buffers[0]!);
  };
  const during = (ms: number): Uint8Array[] => Array.from({ length: Math.round(ms / 20) }, frame);
  const pan = (b: Uint8Array, at = SPOT) => (b[at]! * 256 + b[at + 1]!) / 65535;
  const tilt = (b: Uint8Array, at = SPOT) => (b[at + 2]! * 256 + b[at + 3]!) / 65535;
  const posBytes = (b: Uint8Array, at = SPOT) => [...b.slice(at, at + 4)];
  /** The largest change of a head's pan or tilt from one frame to the next. */
  const steepest = (frames: Uint8Array[], at = SPOT) =>
    Math.max(0, ...frames.slice(1).flatMap((f, i) => [Math.abs(pan(f, at) - pan(frames[i]!, at)), Math.abs(tilt(f, at) - tilt(frames[i]!, at))]));
  const lock = (level: "off" | "soft" | "hard", heads: Record<string, "soft" | "hard"> = {}) => plugin.runtime.setMotionLock({ level, heads });
  const listed = async (id = "spot") => ((await run("position.list")) as HeadMotionEntry[]).find((h) => h.id === id)!;
  const showJson = () => JSON.parse(readFileSync(join(dataRoot, "shows", "default", "show.json"), "utf8")) as { motionLock?: { level: string; heads: object; held: Record<string, Position> } };

  beforeEach(() => {
    dataRoot = join(mkdtempSync(join(tmpdir(), "light-motion-lock-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), join(dataRoot, "fixtures", "spot.qxf"));
    now = 0;
    start();
    plugin.venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: -1, y: 2, z: 5 }, mount: "hung" });
    plugin.venue.fixtures.put({ id: "spot2", name: "Spot 2", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 11, position: { x: 1, y: 2, z: 5 }, mount: "hung" });
    plugin.venue.canvases.put({ id: "lyres", name: "Lyres", topology: "line", cells: 2, render: [{ from: 0, to: 0, targets: [{ fixture: "spot", head: -1 }] }, { from: 1, to: 1, targets: [{ fixture: "spot2", head: -1 }] }] });
    const look = (id: string, more: object) => plugin.runtime.looks.put({ id, name: id, canvas: "lyres", technique: { kind: "plat", color: "#ff0000" }, ...more } as never);
    // both heads on the same course (spread 0): a head locked alone is compared with the other
    look("circle", { move: { shape: "cercle", center: { pan: 0.5, tilt: 0.5 }, size: { pan: 0.2, tilt: 0.2 }, every: { seconds: 2 }, spread: 0 } });
    look("low", { move: { shape: "fixe", center: { pan: 0.2, tilt: 0.8 } } });
    look("raw", { channels: { targets: [{ fixture: "spot", offset: 0 }], steps: [[240]] } });
  });
  afterEach(async () => {
    await plugin.stop();
  });

  describe("soft", () => {
    it("freezes the heads where they are while the look plays its colours; the pad still moves them", async () => {
      await run("look.go", { id: "circle" });
      during(1500);
      lock("soft");
      const frozen = during(5000);
      for (const f of frozen) {
        expect(posBytes(f)).to.deep.equal(posBytes(frozen[0]!));
        expect(posBytes(f, SPOT2)).to.deep.equal(posBytes(frozen[0]!, SPOT2));
        expect(f[SPOT + 5]).to.equal(255); // the dimmer: the look still lights the heads
      }
      // another look that moves does not move them either
      await run("look.go", { id: "low" });
      for (const f of during(2000)) expect(posBytes(f)).to.deep.equal(posBytes(frozen[0]!));
      const motion = (await listed()).motion!;
      expect(motion.lock).to.equal("soft");
      expect(motion.pan.layer).to.equal("lock");
      expect(motion.masked.map((m) => m.owner)).to.have.members(["look:circle", "look:low"]);
      // the pad: at once (direct), and frozen where it leaves the head once released
      plugin.runtime.setPosition(["spot"], { pan: 0.9, tilt: 0.1 });
      const padded = during(100).at(-1)!;
      expect(pan(padded)).to.be.closeTo(0.9, 1e-4);
      expect(tilt(padded)).to.be.closeTo(0.1, 1e-4);
      expect((await listed()).motion!.pan.layer).to.equal("manual");
      plugin.runtime.releasePositions(["spot"]);
      for (const f of during(1000)) expect(posBytes(f)).to.deep.equal(posBytes(padded));
      expect((await listed()).motion!.pan.layer).to.equal("lock");
    });

    it("leaves the DMX console and a channel fader on pan free", async () => {
      during(100);
      lock("soft");
      await run("fader.put", { fader: { id: "panfader", name: "Pan", channels: [{ fixture: "spot", offset: 0 }], level: 1 } });
      expect(during(100).at(-1)![SPOT]).to.equal(255);
      await run("dmx.set", { universe: 1, channel: 3, value: 10 });
      expect(during(100).at(-1)![SPOT + 2]).to.equal(10);
    });
  });

  describe("hard", () => {
    it("nothing of the show moves the heads: looks, raw pan/tilt, the pad, a channel fader", async () => {
      await run("look.go", { id: "circle" });
      during(1500);
      lock("hard");
      const first = during(40).at(-1)!;
      plugin.runtime.setPosition(["spot"], { pan: 0.9, tilt: 0.1 });
      await run("look.go", { id: "raw" });
      await run("fader.put", { fader: { id: "panfader", name: "Pan", channels: [{ fixture: "spot", offset: 0 }], level: 1 } });
      for (const f of during(3000)) {
        expect(posBytes(f)).to.deep.equal(posBytes(first));
        expect(f[SPOT + 5]).to.equal(255);
      }
      expect((await listed()).motion!.lock).to.equal("hard");
      // the Panic's own release of the manual positions (an internal call, not position.release) moves nothing
      await run("panic");
      for (const f of during(1500)) expect(posBytes(f)).to.deep.equal(posBytes(first));
      expect(plugin.runtime.motionLockState().level).to.equal("hard"); // the Panic never lifts the lock
    });

    it("leaves the DMX console free (decision Q4), and takes the head back to where it is held when it lets go", async () => {
      during(100);
      lock("hard");
      const held = during(40).at(-1)!;
      await run("dmx.set", { universe: 1, values: { "1": 200, "3": 20 } });
      const forced = during(100).at(-1)!;
      expect(forced[SPOT]).to.equal(200);
      expect(forced[SPOT + 2]).to.equal(20);
      expect(forced[SPOT + 1]).to.equal(held[SPOT + 1]); // the fine bytes the console does not force stay frozen
      await run("dmx.release", { universe: 1 });
      expect(posBytes(during(40).at(-1)!)).to.deep.equal(posBytes(held));
    });

    it("a soft lock hardening freezes the head where the pad left it; hard to soft moves nothing", async () => {
      during(100);
      lock("soft");
      during(40);
      plugin.runtime.setPosition(["spot"], { pan: 0.7, tilt: 0.3 });
      during(100);
      lock("hard");
      const hard = during(500);
      for (const f of hard) expect(pan(f)).to.be.closeTo(0.7, 1e-4);
      expect(plugin.runtime.heldPosition("spot")!.pan).to.be.closeTo(0.7, 1e-4);
      lock("soft");
      for (const f of during(500)) expect(posBytes(f)).to.deep.equal(posBytes(hard.at(-1)!));
    });
  });

  it("a head locked alone stays, the others move; its level is the stricter of the global lock and its own", async () => {
    await run("look.go", { id: "circle" });
    during(1500);
    lock("off", { spot: "soft" });
    const frames = during(2000);
    for (const f of frames) expect(posBytes(f)).to.deep.equal(posBytes(frames[0]!));
    expect(steepest(frames, SPOT2)).to.be.above(0.01); // spot2 keeps turning
    lock("soft", { spot: "hard" });
    expect(plugin.runtime.motionLock("spot")).to.equal("hard");
    expect(plugin.runtime.motionLock("spot2")).to.equal("soft");
    await run("fader.put", { fader: { id: "panfader", name: "Pan", channels: [{ fixture: "spot", offset: 0 }, { fixture: "spot2", offset: 0 }], level: 1 } });
    const faded = during(100).at(-1)!;
    expect(posBytes(faded)).to.deep.equal(posBytes(frames[0]!)); // hard: the fader does not pass
    expect(faded[SPOT2]).to.equal(255); // soft: it does
  });

  it("under a speed rule, a head frozen stops where it really is, not where it was sent to", async () => {
    await run("rule.put", { where: "show", rule: { id: "lent", name: "Lent", level: "show", scope: { fixture: "spot" }, target: {}, maxDegPerSecond: 20 } });
    during(100);
    await run("look.go", { id: "low" }); // a long way from the centre at 20°/s
    during(400);
    lock("hard");
    const frozen = during(1000);
    for (const f of frozen) expect(posBytes(f)).to.deep.equal(posBytes(frozen[0]!));
    expect(pan(frozen[0]!)).to.be.above(0.3); // still far from 0.2
  });

  it("lifting the lock glides from where the head is held back onto the shape at its current phase, no jump", async () => {
    await run("show.settings.set", { moveFade: { seconds: 0 } }); // even with cuts, a lock lifted glides (at least a second)
    await run("look.go", { id: "circle" });
    during(1500);
    lock("off", { spot: "hard" });
    during(1000);
    lock("off");
    const glide = during(1500);
    // the circle (0.2 of travel over 2 s): at most its own speed plus the glide's over 20 ms
    expect(steepest(glide)).to.be.below(0.05);
    expect(pan(glide[0]!)).to.not.be.closeTo(pan(glide[0]!, SPOT2), 1e-3);
    const landed = glide.at(-1)!;
    expect(pan(landed)).to.be.closeTo(pan(landed, SPOT2), 1e-4);
    expect(tilt(landed)).to.be.closeTo(tilt(landed, SPOT2), 1e-4);
    expect(plugin.runtime.heldPosition("spot")).to.equal(undefined);
    expect(showJson().motionLock!.held).to.deep.equal({});
  });

  it("Blackout keeps a locked head where it is", async () => {
    await run("look.go", { id: "circle" });
    during(1000);
    lock("soft");
    const held = during(40).at(-1)!;
    await run("blackout", { on: true });
    for (const f of during(1000)) {
      expect(posBytes(f)).to.deep.equal(posBytes(held));
      expect(f[SPOT + 5]).to.equal(0);
    }
    expect(plugin.runtime.motionLockState().level).to.equal("soft");
  });

  describe("held, show.json and a restart", () => {
    it("writes where a head is frozen at once, and the pad's moves a second after the last, not every frame", async () => {
      during(100);
      plugin.runtime.setPosition(["spot"], { pan: 0.3, tilt: 0.4 });
      during(100);
      lock("soft");
      expect(showJson().motionLock!.held.spot!.pan).to.be.closeTo(0.3, 1e-4);
      plugin.runtime.setPosition(["spot"], { pan: 0.6, tilt: 0.4 });
      during(500);
      expect(showJson().motionLock!.held.spot!.pan).to.be.closeTo(0.3, 1e-4); // not yet
      during(600);
      expect(showJson().motionLock!.held.spot!.pan).to.be.closeTo(0.6, 1e-4);
      expect(showJson().motionLock).to.deep.include({ level: "soft", heads: {} });
    });

    it("a restart under a lock sends the heads back where they were frozen from the first frame", async () => {
      await run("look.go", { id: "low" });
      during(1500);
      lock("off", { spot: "hard", spot2: "soft" });
      during(100);
      await plugin.stop();
      start();
      const first = frame();
      expect(pan(first)).to.be.closeTo(0.2, 1e-4);
      expect(tilt(first)).to.be.closeTo(0.8, 1e-4);
      expect(pan(first, SPOT2)).to.be.closeTo(0.2, 1e-4);
      expect(plugin.runtime.motionLock("spot")).to.equal("hard");
      // and a look started then does not move them
      await run("look.go", { id: "circle" });
      for (const f of during(1000)) expect(posBytes(f)).to.deep.equal(posBytes(first));
    });
  });

  describe("snapshots (decision Q3)", () => {
    it("records the lock levels and puts back exactly that lock, unlocking included; an older snapshot leaves it", async () => {
      during(100);
      lock("soft", { spot2: "hard" });
      await run("snapshot.save", { name: "Figees" });
      const saved = plugin.runtime.snapshots.get("figees")!;
      expect(saved.motionLock).to.deep.equal({ level: "soft", heads: { spot2: "hard" } });
      lock("off");
      await run("snapshot.save", { name: "Libres" });
      await run("snapshot.recall", { id: "figees" });
      expect(plugin.runtime.motionLockState()).to.deep.equal({ level: "soft", heads: { spot2: "hard" } });
      await run("snapshot.recall", { id: "libres" });
      expect(plugin.runtime.motionLockState()).to.deep.equal({ level: "off", heads: {} });
      // an older snapshot (no motionLock) does not touch the lock
      lock("hard");
      plugin.runtime.snapshots.put({ id: "ancien", name: "Ancien", looks: [], groups: {}, faders: {}, blackout: false });
      await run("snapshot.recall", { id: "ancien" });
      expect(plugin.runtime.motionLockState().level).to.equal("hard");
    });

    it("a head locked by a recall is frozen where it is then; `panic.undo` leaves the lock alone", async () => {
      during(100);
      lock("hard");
      await run("snapshot.save", { name: "Figees" });
      lock("off");
      plugin.runtime.setPosition(["spot"], { pan: 0.8, tilt: 0.2 });
      during(100);
      await run("snapshot.recall", { id: "figees" });
      const held = during(500);
      for (const f of held) expect(pan(f)).to.be.closeTo(0.8, 1e-4);
      // Panic, a freeze, then « Annuler le Panic »: the freeze holds
      lock("off");
      await run("panic");
      lock("soft");
      await run("panic.undo");
      expect(plugin.runtime.motionLockState().level).to.equal("soft");
    });
  });
});
