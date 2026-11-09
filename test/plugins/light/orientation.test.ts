import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { aimAt, pointing, rawAngles } from "../../../src/plugins/light/venue/aim.js";
import { beamDirection, FACINGS, facingOf, isHung, orientTo, wrapYaw } from "../../../src/plugins/light/venue/orientation.js";

describe("fixture orientation", () => {
  const close = (v: { x: number; y: number; z: number }) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e6) / 1e6 + 0);

  it("points the named facings where the stage frame says: X to cour, Y upstage, Z up", () => {
    expect(close(beamDirection(FACINGS.audience))).to.deep.equal([0, -1, 0]);
    expect(close(beamDirection(FACINGS.upstage))).to.deep.equal([0, 1, 0]);
    expect(close(beamDirection(FACINGS.houseLeft))).to.deep.equal([-1, 0, 0]); // jardin
    expect(close(beamDirection(FACINGS.houseRight))).to.deep.equal([1, 0, 0]); // cour
    expect(close(beamDirection(FACINGS.ceiling))).to.deep.equal([0, 0, 1]);
    expect(close(beamDirection(FACINGS.floor))).to.deep.equal([0, 0, -1]);
  });

  it("agrees with the aiming of moving heads: the front is where the yaw says", () => {
    for (const [name, x, y] of [["audience", 0, -3], ["upstage", 0, 3], ["houseLeft", -3, 0], ["houseRight", 3, 0]] as const) {
      const a = rawAngles({ position: { x: 0, y: 0, z: 0 }, hung: false, yaw: FACINGS[name].yaw }, { x, y, z: 1 });
      expect(Math.abs(a!.heading), name).to.be.below(1e-9);
    }
  });

  it("names an orientation, and keeps the heading when turned to the ceiling or the floor", () => {
    expect(facingOf({ yaw: 450, pitch: 0 })).to.equal("houseRight");
    expect(facingOf({ yaw: -180, pitch: 0 })).to.equal("upstage");
    expect(facingOf({ yaw: 30, pitch: 90 })).to.equal("ceiling");
    expect(facingOf({ yaw: 30, pitch: 0 })).to.equal(undefined);
    expect(orientTo({ yaw: 30, pitch: 0 }, "floor")).to.deep.equal({ yaw: 30, pitch: -90 });
    expect(orientTo({ yaw: 30, pitch: 90 }, "houseLeft")).to.deep.equal({ yaw: -90, pitch: 0 });
    expect([wrapYaw(270), wrapYaw(-180), wrapYaw(15)]).to.deep.equal([-90, 180, 15]);
  });

  it("orients a fixture by name, by angle or by a turn, and names it back in the patch", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-orient-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    const orient = async (args: object) => ((await run("venue.fixture.orient", { id: "bar-0", ...args })) as { fixture: { orientation: { yaw: number; pitch: number } }; facing?: string });
    expect((await orient({ facing: "houseLeft" })).fixture.orientation).to.include({ yaw: -90, pitch: 0 });
    const turned = await orient({ turn: -135 });
    expect(turned.fixture.orientation.yaw).to.equal(135);
    expect(turned.facing).to.equal(undefined);
    expect((await orient({ facing: "floor" })).fixture.orientation).to.include({ yaw: 135, pitch: -90 }); // keeps its line
    expect(await run("stage.describe")).to.contain("Bar 0 vers le sol");
    // a bar stood up (as in front of the audience): its roll only, where it points stays
    expect((await orient({ roll: 90 })).fixture.orientation).to.include({ yaw: 135, pitch: -90, roll: 90 });
    expect((await orient({ turn: 15 })).fixture.orientation).to.include({ yaw: 150, roll: 90 }); // kept when turned
    const listed = (await run("venue.fixture.list")) as { id: string; facing?: string }[];
    expect(listed.find((f) => f.id === "bar-0")!.facing).to.equal("floor");
    expect(listed.find((f) => f.id === "bar-1")!.facing).to.equal(undefined); // never oriented
    await run("venue.fixture.put", { fixture: listed.find((f) => f.id === "bar-0") }); // a listed fixture goes back as it is
    // a fixture not installed for this show: flagged in the patch, kept there, and put back
    expect(await run("venue.fixture.presence", { fixtures: ["bar-1"], present: false })).to.deep.equal({ absent: ["bar-1"], changed: ["bar-1"] });
    expect(((await run("venue.fixture.list")) as { id: string; absent?: boolean }[]).map((f) => [f.id, f.absent])).to.deep.include(["bar-1", true]);
    await run("venue.fixture.presence", { fixtures: ["nope"], present: false }).then(
      () => expect.fail("an unknown fixture is refused"),
      (e: Error) => expect(e.message).to.contain("nope"),
    );
    expect(await run("venue.fixture.presence", { fixtures: ["bar-1"], present: true })).to.deep.equal({ absent: [], changed: ["bar-1"] });
    // renamed and given a marker colour, both kept apart; the colour goes back to none
    expect(((await run("venue.fixture.mark", { id: "bar-1", name: "Barre jardin", color: "#22C55E" })) as { fixture: object }).fixture).to.deep.include({ id: "bar-1", name: "Barre jardin", color: "#22c55e", address: 1 + 15 });
    expect(((await run("venue.fixture.mark", { id: "bar-1", color: "#ef4444" })) as { fixture: object }).fixture).to.deep.include({ name: "Barre jardin", color: "#ef4444" });
    expect(((await run("venue.fixture.channels")) as { id: string; color?: string }[]).find((f) => f.id === "bar-1")!.color).to.equal("#ef4444");
    expect(((await run("venue.fixture.mark", { id: "bar-1", color: null })) as { fixture: object }).fixture).to.not.have.property("color");
    await run("venue.fixture.mark", { id: "bar-1", color: "red" }).then(
      () => expect.fail("a colour is #rrggbb"),
      (e: Error) => expect(e.message).to.match(/invalides/),
    );
    let failed = "";
    await run("venue.fixture.orient", { id: "nope", facing: "audience" }).catch((e: Error) => (failed = e.message));
    expect(failed).to.contain("nope");
    // several at once, along the front of a riser, turned towards the audience
    await run("stage.zone.put", { zone: { id: "estrade", name: "Estrade", type: "riser", polygon: [[-2, 1], [2, 1], [2, 3], [-2, 3]], floorHeight: 0.5 } });
    const placed = (await run("venue.fixture.arrange", { fixtures: ["bar-1", "bar-0"], zone: "estrade", edge: "front", facing: "audience" })) as { id: string; position: { x: number; y: number; z: number }; facing?: string }[];
    expect(placed).to.deep.equal([
      { id: "bar-1", position: { x: -1, y: 1.3, z: 0.8 }, facing: "audience" }, // the order given: bar-1 on the jardin side
      { id: "bar-0", position: { x: 1, y: 1.3, z: 0.8 }, facing: "audience" },
    ]);
    expect(((await run("venue.fixture.arrange", { fixtures: ["bar-0"], zone: "estrade", edge: "back", height: 2 })) as { position: { z: number } }[])[0]!.position).to.deep.equal({ x: 0, y: 2.7, z: 2.5 });
    await run("venue.fixture.arrange", { fixtures: ["bar-0"], zone: "nulle-part" }).catch((e: Error) => (failed = e.message));
    expect(failed).to.contain("zone inconnue");
  });

  it("inverts pan and tilt per fixture: written only when given, kept by a partial call, carried by an import", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-invert-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    const orient = async (args: object) =>
      ((await run("venue.fixture.orient", { id: "bar-0", ...args })) as { fixture: { orientation: { invertPan: boolean; invertTilt: boolean; yaw: number } } }).fixture.orientation;
    expect(await orient({ invertPan: true })).to.include({ yaw: 0, invertPan: true, invertTilt: false });
    expect(await orient({ invertPan: true, invertTilt: true })).to.include({ invertPan: true, invertTilt: true });
    expect(await orient({ facing: "houseRight" })).to.include({ yaw: 90, invertPan: true, invertTilt: true }); // a facing keeps them
    expect(await orient({ yaw: -30 })).to.include({ yaw: -30, invertPan: true, invertTilt: true }); // a partial call keeps them
    expect(await orient({ invertPan: false })).to.include({ invertPan: false, invertTilt: true });
    // another venue's patch carries the inversions in the orientation it imports
    const other = join(dataRoot, "venues", "autre", "fixtures");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, "bar-1.json"),
      JSON.stringify({ id: "bar-1", name: "Bar 1", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 16, orientation: { yaw: 20, pitch: 10, invertPan: true, invertTilt: false, swapPanTilt: true, panOffset: 0, tiltOffset: 2 } }),
    );
    await run("venue.positions.import", { from: "autre", apply: true });
    const listed = (await run("venue.fixture.list")) as { id: string; orientation?: { invertPan: boolean; invertTilt: boolean; swapPanTilt: boolean; pitch: number } }[];
    expect(listed.find((f) => f.id === "bar-1")!.orientation).to.include({ invertPan: true, invertTilt: false, swapPanTilt: true, pitch: 10 });
  });

  it("re-solves the inversions of a calibration while keeping the body's pitch, roll and swap, the pan offset folded into the yaw", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-solve-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), join(dataRoot, "fixtures", "spot.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    // the head these marks were taken on, its body stored slanted and rolled, pan wired backwards
    await run("venue.fixture.put", {
      fixture: { id: "lyre", name: "Lyre", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: 2, y: 3, z: 5 }, mount: "hung", orientation: { yaw: 0, pitch: 20, roll: 45, invertPan: true, invertTilt: false, swapPanTilt: true, panOffset: 5, tiltOffset: 0 } },
    });
    const truth = { position: { x: 2, y: 3, z: 5 }, hung: true, yaw: 30, panMax: 540, tiltMax: 270, panOffset: 0, tiltOffset: 4 };
    for (const target of [{ x: 0, y: 1, z: 0 }, { x: 4, y: 2, z: 0 }, { x: 2, y: 5.5, z: 0 }]) {
      const a = aimAt(truth, target) as { pan: number; tilt: number };
      await run("position.set", { fixtures: ["lyre"], pan: 1 - a.pan, tilt: a.tilt }); // what the hand saw: pan inverted
      await run("calibration.record", { fixture: "lyre", point: target });
    }
    const result = (await run("calibration.solve", { fixture: "lyre", apply: true })) as { yaw: number; tiltOffset: number; invertPan: boolean; invertTilt: boolean };
    const listed = (await run("venue.fixture.list")) as { id: string; orientation?: Record<string, unknown> }[];
    const o = listed.find((f) => f.id === "lyre")!.orientation!;
    expect(o).to.include({ pitch: 20, roll: 45, swapPanTilt: true, panOffset: 0 }); // the body kept, the pan offset folded into the yaw
    expect(o.invertPan).to.equal(result.invertPan); // the inversions are the solve's own (recalculated)
    expect(o.invertTilt).to.equal(result.invertTilt);
  });

  it("hangs a moving head pointed at the floor, whatever its mount; the mount decides otherwise", () => {
    const o = (pitch?: number) => ({ yaw: 0, pitch, invertPan: false, invertTilt: false, swapPanTilt: false, panOffset: 0, tiltOffset: 0 });
    expect(isHung({ mount: "floor", orientation: o(-90) })).to.equal(true);
    expect(isHung({ mount: "truss", orientation: o(90) })).to.equal(false);
    expect(isHung({ mount: "truss", orientation: o(0) })).to.equal(true);
    expect(isHung({ mount: "stand" })).to.equal(false);
  });
});

describe("where a moving head points, from its pan/tilt", () => {
  it("undoes the aiming: aimed at a point, it points at that point", () => {
    for (const hung of [false, true])
      for (const yaw of [0, 90, -135])
        for (const target of [{ x: 2, y: 3, z: 0 }, { x: -1.5, y: 0.5, z: 1.5 }, { x: 0, y: 4, z: 0 }]) {
          const f = { position: { x: 0.5, y: 2, z: hung ? 5 : 0.2 }, hung, yaw, panMax: 540, tiltMax: 270, panOffset: 3, tiltOffset: -4 };
          const res = aimAt(f, target);
          if ("error" in res) continue;
          const d = pointing(f, res);
          const v = { x: target.x - f.position.x, y: target.y - f.position.y, z: target.z - f.position.z };
          const len = Math.hypot(v.x, v.y, v.z);
          expect(d.x * v.x + d.y * v.y + d.z * v.z, `${hung} ${yaw} ${JSON.stringify(target)}`).to.be.closeTo(len, 1e-6); // same direction
        }
  });
});
