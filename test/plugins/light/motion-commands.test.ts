import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, type PluginEvent } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import type { AxisStatus, HeadStatus } from "../../../src/plugins/light/engine/motion.js";
import { headMotion, lookNamer, motionKey, type HeadMotionEntry } from "../../../src/plugins/light/show/motion-report.js";
import { rawMotionAxes } from "../../../src/plugins/light/venue/tracks.js";

/**
 * The motion layer through its commands and its topic (T25, lots 4 and 5; docs/specs/engine-effects-timing.md,
 * « Couche Mouvement »): position.list says why each head is where it is, position.releaseTop hands a head back one
 * layer at a time, light:motion is sent on a change only, calibration.record reads the position really sent, the Panic
 * moves nothing by itself, and « Vérifier le show » names the looks whose raw pan/tilt now go through the layer.
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
  /** What `calibration.record` waits for: here, one engine frame rendered on demand (or none: the output stopped). */
  let frames = true;
  const injectFrames = () => {
    (plugin as unknown as { nextFrame: () => Promise<boolean> }).nextFrame = () => Promise.resolve(frames ? (frame(), true) : false);
  };
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
    frames = true;
    injectFrames();
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
    const { claims: arrivedClaims, ...arrivedPan } = arrived.motion!.pan;
    expect(arrivedPan).to.deep.equal({ layer: "look", layers: ["look", "rest"], owner: "look:a", name: "A", position: arrived.motion!.pan.position, moving: false });
    expect(arrivedClaims).to.have.length(2);
    expect(arrivedClaims[0]).to.match(/^look:a#\d+$/); // the claim key of each layer, same order; "" for rest
    expect(arrivedClaims[1]).to.equal("");
    expect(arrived.sent!.pan).to.be.closeTo(0.2, 1e-4);
    await run("position.set", { fixtures: ["spot"], pan: 0.6 }); // the pan only
    during(40);
    const manual = await listed();
    expect(manual.motion!.pan).to.include({ layer: "manual", owner: "manual" });
    expect(manual.motion!.pan.layers).to.deep.equal(["manual", "look", "rest"]);
    expect(manual.motion!.tilt).to.include({ layer: "look", owner: "look:a" }); // the other axis stays with the look
    expect(manual.motion!.tilt.layers).to.deep.equal(["look", "rest"]);
    expect(manual.manual!.pan).to.equal(0.6);
    await run("position.releaseTop", { fixtures: ["spot"] });
    during(40);
    expect((await listed()).motion!.pan.layers).to.deep.equal(["look", "rest"]); // released claims leave the stack
  });

  it("`position.list` resolves the existing fixture and group targets server-side", async () => {
    plugin.venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, tags: ["motion-test"] });
    plugin.venue.fixtures.put({ id: "spot2", name: "Spot 2", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 11 });
    await run("group.put", { group: { id: "leaf", name: "Leaf", members: { fixtures: ["spot2"], groups: [], looks: [] } } });
    await run("group.put", { group: { id: "parent", name: "Parent", members: { fixtures: [], groups: ["leaf"], looks: [] }, selector: { tags: ["motion-test"] } } });
    const ids = async (args: unknown) => ((await run("position.list", args)) as Listed[]).map((h) => h.id);
    expect(await ids({ fixtures: ["spot"] })).to.deep.equal(["spot"]);
    expect(await ids({ fixtures: [] })).to.deep.equal([]);
    expect(await ids({ group: "leaf" })).to.deep.equal(["spot2"]);
    expect(new Set(await ids({ group: "parent" }))).to.deep.equal(new Set(["spot", "spot2"])); // selector and sub-group
    expect(new Set(await ids({}))).to.deep.equal(new Set(["spot", "spot2"]));
    let refused = "";
    await run("position.list", { group: "missing" }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("missing");
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

  it("`calibration.record` reads the gesture just before it, on the next frame, and refuses a head a look or a glide holds", async () => {
    const record = (x: number) => run("calibration.record", { fixture: "spot", point: { x, y: 0, z: 0 } });
    const refusal = (x: number) => record(x).then(() => "", (e: Error) => e.message);
    await run("look.go", { id: "a" });
    during(1500);
    expect(await refusal(0)).to.match(/look/);
    // right after the gesture, no frame in between: the frame the record waits for carries it
    await run("position.set", { fixtures: ["spot"], pan: 0.3, tilt: 0.6 });
    expect(await record(0)).to.include({ samples: 1 });
    const [mark] = (await run("calibration.list", { fixture: "spot" })) as { pan: number; tilt: number }[];
    expect(mark!.pan).to.be.closeTo(0.3, 1e-4);
    expect(mark!.tilt).to.be.closeTo(0.6, 1e-4);
    // a glide under way (to rest): not yet
    await run("position.home", { fixtures: ["spot"] });
    expect(await refusal(1)).to.match(/glisse|gliding/);
    // no frame rendered (the output stopped): nothing stale is recorded
    during(1500);
    await run("position.set", { fixtures: ["spot"], pan: 0.4, tilt: 0.6 });
    frames = false;
    expect(await refusal(1)).to.match(/aucune trame|no frame/);
    expect(((await run("calibration.list", { fixture: "spot" })) as unknown[]).length).to.equal(1);
  });

  it("`calibration.record` waits for a head a speed rule slows down to arrive", async () => {
    const refusal = () => run("calibration.record", { fixture: "spot", point: { x: 0, y: 0, z: 0 } }).then(() => "", (e: Error) => e.message);
    await run("position.set", { fixtures: ["spot"], pan: 0.8, tilt: 0.5 });
    during(200);
    await run("rule.put", { where: "show", rule: { id: "lent", name: "Lent", level: "show", scope: { fixture: "spot" }, target: {}, maxDegPerSecond: 20 } });
    during(40); // the rule measures from where the head is
    await run("position.set", { fixtures: ["spot"], pan: 0.1 });
    during(60);
    expect(await refusal()).to.match(/pas encore arrivée|not arrived yet/);
    expect(((await run("calibration.list", { fixture: "spot" })) as unknown[]).length).to.equal(0);
    during(20000); // 0.7 × 540° at 20°/s: under 19 s
    expect(await refusal()).to.equal("");
    const [mark] = (await run("calibration.list", { fixture: "spot" })) as { pan: number }[];
    expect(mark!.pan).to.be.closeTo(0.1, 1e-3);
  });

  it("a target holding the head is named as such, not as a look", async () => {
    // no target layer yet (T24): the refusal is tested on the layer the status gives
    during(40);
    const real = plugin.runtime.motionStatus();
    // shadows the method on this instance only, deleted after
    const shadow = plugin.runtime as unknown as { motionStatus?: () => ReadonlyMap<string, HeadStatus> };
    shadow.motionStatus = () => new Map([...real].map(([id, s]) => [id, { ...s, pan: { ...s.pan, layer: "target" as const, owner: "target:chanteur" } }]));
    try {
      const message = await run("calibration.record", { fixture: "spot", point: { x: 0, y: 0, z: 0 } }).then(() => "", (e: Error) => e.message);
      expect(message).to.match(/une cible la tient|a target holds it/);
    } finally {
      delete shadow.motionStatus;
    }
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
  const axis = (more: Partial<AxisStatus>): AxisStatus => {
    const layers: AxisStatus["layers"] = more.layer && more.layer !== "rest" ? [more.layer, "rest"] : ["rest"];
    return { layer: "rest", layers, claims: layers.map((layer) => (layer === "rest" ? "" : `${more.owner ?? layer}#1`)), owner: null, position: 0.5, moving: false, ...more };
  };
  const status = (pan: Partial<AxisStatus>, more: Partial<HeadStatus> = {}): HeadStatus => ({ pan: axis(pan), tilt: axis({}), lock: "off", masked: [], released: [], ...more });

  it("names the looks, rounds the time left, and gives the owners of the released claims once", () => {
    const nameOf = lookNamer((id) => (id === "a" ? "A" : undefined));
    const m = headMotion(status({ layer: "look", owner: "look:a", moving: true, from: 0.1, target: 0.2, remainingMs: 412.6 }, { masked: ["look:gone"], released: ["look:a#3", "look:a#5", "manual#4"] }), nameOf);
    expect(m.pan).to.deep.equal({ layer: "look", layers: ["look", "rest"], claims: ["look:a#1", ""], owner: "look:a", name: "A", position: 0.5, moving: true, from: 0.1, to: 0.2, remainingMs: 413 });
    expect(m.masked).to.deep.equal([{ owner: "look:gone" }]);
    expect(m.released).to.deep.equal([{ owner: "look:a", name: "A" }, { owner: "manual" }]);
  });

  it("changes on an owner, a glide started or ended, a lock, a release, a rest or a look renamed, not on a position nor the time left", () => {
    let rest: Record<string, { pan: number; tilt: number }> = {};
    let lookName = "A";
    const key = (s: HeadStatus) =>
      motionKey({ movingHeads: () => ["h"], motionStatus: () => new Map([["h", s]]), sentPosition: () => undefined, settings: { restPositions: rest }, looks: { get: (id) => (id === "a" ? { name: lookName } : undefined) } });
    const base = key(status({ layer: "look", owner: "look:a", moving: true, remainingMs: 900 }));
    expect(key(status({ layer: "look", owner: "look:a", moving: true, remainingMs: 300, position: 0.3 }))).to.equal(base);
    expect(key(status({ layer: "look", owner: "look:a", moving: true, layers: ["look", "hold", "rest"] }))).to.not.equal(base);
    expect(key(status({ layer: "look", owner: "look:a", moving: true, claims: ["look:a#2", ""] }))).to.not.equal(base); // relaunched
    expect(key(status({ layer: "look", owner: "look:a" }))).to.not.equal(base);
    expect(key(status({ layer: "look", owner: "look:b", moving: true }))).to.not.equal(base);
    expect(key(status({ layer: "look", owner: "look:a", moving: true }, { lock: "soft" }))).to.not.equal(base);
    expect(key(status({ layer: "look", owner: "look:a", moving: true }, { released: ["manual#2"] }))).to.not.equal(base);
    rest = { h: { pan: 0.3, tilt: 0.5 } };
    expect(key(status({ layer: "look", owner: "look:a", moving: true }))).to.not.equal(base);
    rest = {};
    lookName = "A renamed";
    expect(key(status({ layer: "look", owner: "look:a", moving: true }))).to.not.equal(base);
  });
});

describe("motion layer: raw pan/tilt in « Vérifier le show » (lot 5)", () => {
  it("tells the axes a look's raw channels place, and those written by their fine channel alone", () => {
    const r = { pan: { coarse: 0, fine: 1 }, tilt: { coarse: 2, fine: 3 } };
    expect(rawMotionAxes(r, new Set([0, 1, 2]))).to.deep.equal({ placed: ["pan", "tilt"], fineOnly: [] });
    expect(rawMotionAxes(r, new Set([1, 2, 5]))).to.deep.equal({ placed: ["tilt"], fineOnly: ["pan"] });
    expect(rawMotionAxes({ pan: { coarse: 0 } }, new Set([1]))).to.deep.equal({ placed: [], fineOnly: [] });
  });

  it("names the looks writing raw pan/tilt (info) and warns on a fine channel alone", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-motion-lint-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    for (const f of ["spot.qxf", "par-rgb.qxf"]) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(dataRoot, "fixtures", f));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    try {
      plugin.venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: 0, y: 0, z: 4 } });
      plugin.venue.fixtures.put({ id: "par", name: "Par", manufacturer: "Test", model: "Par RGB", mode: "3 Channel", universe: 1, address: 21, position: { x: 1, y: 0, z: 4 } });
      plugin.venue.canvases.put({ id: "c", name: "C", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "par", head: -1 }] }] });
      const raw = (id: string, name: string, targets: { fixture: string; offset: number }[]) =>
        plugin.runtime.looks.put({ id, name, canvas: "c", technique: { kind: "aucune" }, channels: { targets, steps: [targets.map(() => 100)] } } as never);
      raw("scene", "Scène", [{ fixture: "spot", offset: 0 }, { fixture: "spot", offset: 2 }, { fixture: "spot", offset: 5 }]);
      raw("fine", "Fin", [{ fixture: "spot", offset: 1 }]);
      raw("par", "Par seul", [{ fixture: "par", offset: 0 }]);
      raw("tilt", "Tilt seul", [{ fixture: "spot", offset: 2 }]);
      const { issues } = (await plugin.commands.invoke("show.lint", {}, systemContext())) as { issues: { level: string; where: string; message: string }[] };
      const of = (where: string) => issues.filter((i) => i.where === where && /pan\/tilt/.test(i.message));
      // one note for every look, the change said once
      const grouped = issues.filter((i) => i.where.startsWith("looks "));
      expect(grouped.map((i) => [i.level, i.where])).to.deep.equal([["info", "looks scene, tilt"]]);
      expect(grouped[0]!.message)
        .to.contain("« Scène » : « Spot » (Pan, Tilt)")
        .and.contain("« Tilt seul » : « Spot » (Tilt)")
        .and.contain("glissent (sauf un axe réglé en coupe")
        .and.contain("dernier lancé");
      expect(grouped[0]!.message.match(/glissent/g)).to.have.length(1);
      expect(of("look scene")).to.deep.equal([]);
      const fine = of("look fine");
      expect(fine.map((i) => i.level)).to.deep.equal(["attention"]);
      expect(fine[0]!.message).to.contain("« Spot » (Pan fine)").and.contain("ne place plus");
      expect(of("look par")).to.deep.equal([]); // no moving head written
    } finally {
      await plugin.stop();
    }
  });
});
