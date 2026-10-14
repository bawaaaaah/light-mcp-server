import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { LiveSnapshotFile, RESUME_MAX_AGE_MS } from "../../../src/plugins/light/data/live-snapshot.js";

describe("resume after a restart", () => {
  it("keeps a snapshot only for the same show and while it is recent", () => {
    const dir = mkdtempSync(join(tmpdir(), "light-live-"));
    let now = 1_000_000;
    const file = new LiveSnapshotFile(join(dir, "machine", "live.json"), () => now);
    file.save({ show: "default", looks: ["a"], blackout: false, song: "s" });
    now += 60_000;
    expect(file.load("default")).to.deep.include({ looks: ["a"], song: "s" });
    expect(file.load("other")).to.equal(undefined);
    now += RESUME_MAX_AGE_MS;
    expect(file.load("default")).to.equal(undefined); // the next day: no surprise
    writeFileSync(join(dir, "machine", "live.json"), "{broken");
    expect(file.load("default")).to.equal(undefined);
  });

  it("refreshes the time stamp of a steady state, so a long look is still resumed", () => {
    const dir = mkdtempSync(join(tmpdir(), "light-live-"));
    let now = 0;
    const file = new LiveSnapshotFile(join(dir, "live.json"), () => now);
    for (; now <= 20 * 60_000; now += 1000) file.save({ show: "default", looks: ["a"], blackout: false });
    expect(file.load("default")).to.not.equal(undefined);
  });

  it("brings back the playing looks and the Blackout after a crash", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-live-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const make = () => new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const first = make();
    await first.start();
    const run = (name: string, args: unknown = {}) => first.commands.invoke(name, args, systemContext());
    await run("venue.fixture.put", { fixture: { id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1 } });
    await run("venue.canvas.put", { canvas: { id: "mur", name: "Mur", cells: 4, render: [{ from: 0, to: 3, targets: [{ fixture: "bar", head: -1 }] }] } });
    await run("look.put", { look: { id: "rouge", name: "Rouge", canvas: "mur", technique: { kind: "plat", color: "#ff0000" } } });
    await run("look.go", { id: "rouge" });
    await run("blackout", { on: true });
    first.saveLive(); // what the 1-second timer does
    await first.stop();

    const second = make();
    await second.start();
    expect(second.runtime.isActive("rouge")).to.equal(true);
    expect(second.engine.isBlackout()).to.equal(true);
    expect(second.resumed).to.deep.include({ looks: ["rouge"], blackout: true });
    await second.stop();
  });
});
