import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { rawAngles } from "../../../src/plugins/light/venue/aim.js";
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
    const listed = (await run("venue.fixture.list")) as { id: string; facing?: string }[];
    expect(listed.find((f) => f.id === "bar-0")!.facing).to.equal("floor");
    expect(listed.find((f) => f.id === "bar-1")!.facing).to.equal(undefined); // never oriented
    await run("venue.fixture.put", { fixture: listed.find((f) => f.id === "bar-0") }); // a listed fixture goes back as it is
    let failed = "";
    await run("venue.fixture.orient", { id: "nope", facing: "audience" }).catch((e: Error) => (failed = e.message));
    expect(failed).to.contain("nope");
  });

  it("hangs a moving head pointed at the floor, whatever its mount; the mount decides otherwise", () => {
    const o = (pitch?: number) => ({ yaw: 0, pitch, invertPan: false, invertTilt: false, swapPanTilt: false, panOffset: 0, tiltOffset: 0 });
    expect(isHung({ mount: "floor", orientation: o(-90) })).to.equal(true);
    expect(isHung({ mount: "truss", orientation: o(90) })).to.equal(false);
    expect(isHung({ mount: "truss", orientation: o(0) })).to.equal(true);
    expect(isHung({ mount: "stand" })).to.equal(false);
  });
});
