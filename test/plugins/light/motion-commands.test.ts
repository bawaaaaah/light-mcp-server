import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, type PluginEvent } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import type { AxisStatus, HeadStatus } from "../../../src/plugins/light/engine/motion.js";
import { headMotion, lookNamer, motionKey, type HeadMotionEntry } from "../../../src/plugins/light/show/motion-report.js";

/**
 * The motion layer through its commands and its topic (T25, lot 4; docs/specs/engine-effects-timing.md,
 * « Couche Mouvement »): position.list says why each head is where it is, position.releaseTop hands a head back one
 * layer at a time, light:motion is sent on a change only, calibration.record reads the position really sent, the Panic
 * moves nothing by itself.
 */
describe("motion layer: the commands of lot 4", () => {
  let plugin: LightPlugin;
  let bus: EventBus;
  let now = 0;
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  /** One engine frame (the listeners too: light:motion), 20 ms on: the pan sent to the head, 0..1. */
  const frame = (): number => {
    (plugin.engine as unknown as { frame(now: number): void }).frame(now);
    const b = plugin.engine.output.buffers[0]!;
    now += 20;
    return (b[0]! * 256 + b[1]!) / 65535;
  };
  const during = (ms: number) => Array.from({ length: ms / 20 }, frame);
  type Listed = HeadMotionEntry & { name: string; manual: { pan: number; tilt: number } | null };
  const listed = async (): Promise<Listed> => ((await run("position.list")) as Listed[]).find((h) => h.id === "spot")!;

  beforeEach(() => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-motion-cmds-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), join(dataRoot, "fixtures", "spot.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    now = 0;
    bus = new EventBus();
    plugin = new LightPlugin({ eventBus: bus, config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null, now: () => now });
    plugin.venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: 0, y: 2, z: 5 }, mount: "hung" });
    plugin.venue.canvases.put({ id: "spot", name: "Spot", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "spot", head: -1 }] }] });
    const look = (id: string, name: string, more: object) => plugin.runtime.looks.put({ id, name, canvas: "spot", technique: { kind: "aucune" }, ...more } as never);
    look("a", "A", { move: { shape: "fixe", center: { pan: 0.2, tilt: 0.8 } } });
    look("b", "B", { move: { shape: "fixe", center: { pan: 0.8, tilt: 0.8 } } });
  });
  afterEach(async () => {
    await plugin.stop();
  });

  it("`position.list` says per head what was sent, its rest, and who holds each axis, gliding or not", async () => {
    const before = await listed();
    expect(before).to.include({ name: "Spot", sent: null, motion: null, manual: null }); // no frame yet
    expect(before.rest).to.deep.equal({ pan: 0.5, tilt: 0.5, set: false });
    during(100);
    const rest = await listed();
    expect(rest.sent!.pan).to.be.closeTo(0.5, 1e-4);
    expect(rest.motion).to.deep.include({ lock: "off", masked: [], released: [] });
    expect(rest.motion!.pan).to.include({ layer: "rest", owner: null, moving: false });
    await run("position.rest.set", { fixtures: ["spot"], pan: 0.4, tilt: 0.5 });
    expect((await listed()).rest).to.deep.equal({ pan: 0.4, tilt: 0.5, set: true });
    during(1500);
    await run("look.go", { id: "a" });
    during(400);
    const gliding = (await listed()).motion!.pan;
    expect(gliding).to.include({ layer: "look", owner: "look:a", name: "A", moving: true, to: 0.2 });
    expect(gliding.from).to.be.closeTo(0.4, 1e-3);
    expect(gliding.remainingMs).to.be.within(550, 650);
    during(1000);
    const arrived = await listed();
    expect(arrived.motion!.pan).to.deep.equal({ layer: "look", owner: "look:a", name: "A", position: arrived.motion!.pan.position, moving: false });
    expect(arrived.sent!.pan).to.be.closeTo(0.2, 1e-4);
    await run("position.set", { fixtures: ["spot"], pan: 0.6 }); // the pan only
    during(40);
    const manual = await listed();
    expect(manual.motion!.pan).to.include({ layer: "manual", owner: "manual" });
    expect(manual.motion!.tilt).to.include({ layer: "look", owner: "look:a" }); // the other axis stays with the look
    expect(manual.manual!.pan).to.equal(0.6);
  });

  it("`position.releaseTop` hands a head back one layer at a time: manual, then the look, then rest", async () => {
    await run("look.go", { id: "a" });
    await run("position.set", { fixtures: ["spot"], pan: 0.9, tilt: 0.1 });
    during(1500);
    type Released = { fixtures: { fixture: string; released: string[] }[] };
    expect(await run("position.releaseTop", { fixtures: ["spot"] })).to.deep.equal({ fixtures: [{ fixture: "spot", released: ["manual"] }] });
    expect((await listed()).manual).to.equal(null);
    const toLook = during(1500);
    expect(toLook.at(-1)).to.be.closeTo(0.2, 1e-4);
    expect(Math.max(...toLook.slice(1).map((v, i) => Math.abs(v - toLook[i]!)))).to.be.below(0.03); // a glide, no jump
    expect(((await run("position.releaseTop")) as Released).fixtures).to.deep.equal([{ fixture: "spot", released: ["look:a"] }]);
    during(1500);
    const atRest = await listed();
    expect(atRest.sent!.pan).to.be.closeTo(0.5, 1e-4);
    expect(atRest.motion!.pan.layer).to.equal("rest");
    expect(atRest.motion!.released).to.deep.equal([{ owner: "look:a", name: "A" }]); // said released, the look plays on
    expect(plugin.runtime.isActive("a")).to.equal(true);
    expect(((await run("position.releaseTop")) as Released).fixtures).to.deep.equal([{ fixture: "spot", released: [] }]); // nothing left
    // a look started again claims the head again
    await run("look.go", { id: "b" });
    expect(during(1500).at(-1)).to.be.closeTo(0.8, 1e-4);
    let refused = "";
    await run("position.releaseTop", { fixtures: ["nope"] }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("nope");
  });

  it("`position.releaseTop` respects a lock: none released under a hard one, only the manual position under a soft one", async () => {
    await run("look.go", { id: "a" });
    await run("position.set", { fixtures: ["spot"], pan: 0.9 });
    during(200);
    plugin.runtime.motionLock = () => "hard";
    during(40);
    expect(await run("position.releaseTop")).to.deep.equal({ fixtures: [{ fixture: "spot", released: [] }] });
    plugin.runtime.motionLock = () => "soft";
    during(40);
    expect(await run("position.releaseTop")).to.deep.equal({ fixtures: [{ fixture: "spot", released: ["manual"] }] });
    expect(await run("position.releaseTop")).to.deep.equal({ fixtures: [{ fixture: "spot", released: [] }] }); // the look is under the lock
  });

  it("`light:motion` is sent on a change of owner and at a glide's start and end, not every frame", async () => {
    const seen: HeadMotionEntry[][] = [];
    bus.subscribe((e: PluginEvent) => {
      if (e.type === "motion") seen.push((e.payload as { heads: HeadMotionEntry[] }).heads);
    });
    const settle = () => new Promise((r) => setTimeout(r, 150)); // the 100 ms throttle
    during(100);
    await settle();
    expect(seen.length).to.equal(1); // the first frame: every head at rest
    expect(seen[0]![0]!.motion!.pan.layer).to.equal("rest");
    during(1000);
    await settle();
    expect(seen.length).to.equal(1); // nothing changed: nothing sent
    await run("look.go", { id: "a" });
    frame();
    await settle();
    expect(seen.length).to.equal(2);
    expect(seen[1]![0]!.motion!.pan).to.include({ layer: "look", name: "A", moving: true });
    during(500);
    await settle();
    expect(seen.length).to.equal(2); // the glide on its way: nothing
    during(1000);
    await settle();
    expect(seen.length).to.equal(3); // the glide over
    expect(seen[2]![0]!.motion!.pan).to.include({ layer: "look", moving: false });
  });

  it("`calibration.record` records the position really sent, and waits for a hand-aimed head at rest", async () => {
    await run("look.go", { id: "a" });
    during(1500);
    let refused = "";
    await run("calibration.record", { fixture: "spot", point: { x: 0, y: 0, z: 0 } }).catch((e: Error) => (refused = e.message));
    expect(refused).to.match(/look/);
    await run("position.set", { fixtures: ["spot"], pan: 0.3, tilt: 0.6 });
    frame();
    // the DMX console forces the pan: the head points where the output says, not where the pad asked
    await run("dmx.set", { universe: 1, values: { "1": 64, "2": 0 } });
    frame();
    expect(await run("calibration.record", { fixture: "spot", point: { x: 0, y: 0, z: 0 } })).to.include({ samples: 1 });
    const [mark] = (await run("calibration.list", { fixture: "spot" })) as { pan: number; tilt: number }[];
    expect(mark!.pan).to.be.closeTo((64 * 256) / 65535, 1e-6);
    expect(mark!.tilt).to.be.closeTo(0.6, 1e-4);
    // a glide under way (to rest): not yet
    await run("look.stop", { id: "a" }).catch(() => undefined);
    await run("position.home", { fixtures: ["spot"] });
    frame();
    refused = "";
    await run("calibration.record", { fixture: "spot", point: { x: 1, y: 0, z: 0 } }).catch((e: Error) => (refused = e.message));
    expect(refused).to.match(/glisse|gliding/);
  });

  it("Panic moves no head by itself; a safe look that carries a move takes them, gliding (question 4)", async () => {
    await run("look.go", { id: "a" });
    during(1500);
    await run("panic"); // no safe state: a Blackout, the heads hold
    const held = during(1000);
    expect(new Set(held.map((v) => v.toFixed(4)))).to.deep.equal(new Set(["0.2000"]));
    expect((await listed()).motion!.pan).to.include({ layer: "hold", owner: null });
    await run("panic.undo");
    during(200);
    await run("show.settings.set", { safeLook: "b" });
    await run("panic");
    const safe = during(1500);
    expect(safe[0]).to.be.below(0.25); // where it was: no jump
    expect(Math.max(...safe.slice(1).map((v, i) => Math.abs(v - safe[i]!)))).to.be.below(0.03);
    expect(safe.at(-1)).to.be.closeTo(0.8, 1e-4);
    expect((await listed()).motion!.pan).to.include({ layer: "look", owner: "look:b", name: "B" });
  });
});

describe("motion layer: the report and its change key", () => {
  const axis = (more: Partial<AxisStatus>): AxisStatus => ({ layer: "rest", owner: null, position: 0.5, moving: false, ...more });
  const status = (pan: Partial<AxisStatus>, more: Partial<HeadStatus> = {}): HeadStatus => ({ pan: axis(pan), tilt: axis({}), lock: "off", masked: [], released: [], ...more });

  it("names the looks, rounds the time left, and gives the owners of the released claims once", () => {
    const nameOf = lookNamer((id) => (id === "a" ? "A" : undefined));
    const m = headMotion(status({ layer: "look", owner: "look:a", moving: true, from: 0.1, target: 0.2, remainingMs: 412.6 }, { masked: ["look:gone"], released: ["look:a#3", "look:a#5", "manual#4"] }), nameOf);
    expect(m.pan).to.deep.equal({ layer: "look", owner: "look:a", name: "A", position: 0.5, moving: true, from: 0.1, to: 0.2, remainingMs: 413 });
    expect(m.masked).to.deep.equal([{ owner: "look:gone" }]);
    expect(m.released).to.deep.equal([{ owner: "look:a", name: "A" }, { owner: "manual" }]);
  });

  it("changes on an owner, a glide started or ended, a lock or a release, not on a position nor the time left", () => {
    const key = (s: HeadStatus) => motionKey(new Map([["h", s]]));
    const base = key(status({ layer: "look", owner: "look:a", moving: true, remainingMs: 900 }));
    expect(key(status({ layer: "look", owner: "look:a", moving: true, remainingMs: 300, position: 0.3 }))).to.equal(base);
    expect(key(status({ layer: "look", owner: "look:a" }))).to.not.equal(base);
    expect(key(status({ layer: "look", owner: "look:b", moving: true }))).to.not.equal(base);
    expect(key(status({ layer: "look", owner: "look:a", moving: true }, { lock: "soft" }))).to.not.equal(base);
    expect(key(status({ layer: "look", owner: "look:a", moving: true }, { released: ["manual#2"] }))).to.not.equal(base);
  });
});
