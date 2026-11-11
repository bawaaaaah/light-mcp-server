import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

/** The snapshot recalled when the application starts (T16): a first run saves it, a second one boots on it. */
describe("startup snapshot", () => {
  let dataRoot: string;
  const config = () => ({ discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } });
  const make = (standby = false) => new LightPlugin({ eventBus: new EventBus(), config: { get: () => config(), set: async () => undefined }, dataRoot, midiNative: null, ...(standby ? { standby } : {}) });
  const runOn = (p: LightPlugin) => (name: string, args: unknown = {}) => p.commands.invoke(name, args, systemContext());

  /** A first session: a look playing under Blackout is saved as « Depart » and chosen for startup; then everything is stopped and the live file dropped. */
  async function prepare(): Promise<void> {
    const first = make();
    await first.start();
    const run = runOn(first);
    await run("venue.fixture.put", { fixture: { id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1 } });
    await run("venue.canvas.put", { canvas: { id: "mur", name: "Mur", cells: 4, render: [{ from: 0, to: 3, targets: [{ fixture: "bar", head: -1 }] }] } });
    await run("look.put", { look: { id: "rouge", name: "Rouge", canvas: "mur", technique: { kind: "plat", color: "#ff0000" } } });
    await run("look.put", { look: { id: "bleu", name: "Bleu", canvas: "mur", technique: { kind: "plat", color: "#0000ff" } } });
    await run("look.go", { id: "rouge" });
    await run("blackout", { on: true });
    await run("snapshot.save", { name: "Depart" });
    await run("show.settings.set", { startupSnapshot: "depart" });
    await run("blackout", { on: false });
    await run("look.stopall");
    await first.stop();
    rmSync(join(dataRoot, "machine", "live.json"), { force: true }); // stop() saves the live state: drop it, so only the startup snapshot remains
  }

  beforeEach(() => {
    dataRoot = join(mkdtempSync(join(tmpdir(), "light-startup-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
  });

  it("recalls it on a fresh start, Blackout included", async () => {
    await prepare();
    const second = make();
    await second.start();
    expect(second.resumed).to.equal(undefined);
    expect(second.runtime.isActive("rouge")).to.equal(true);
    expect(second.engine.isBlackout()).to.equal(true);
    await second.stop();
  });

  it("lets a recent crash resume win over it", async () => {
    await prepare();
    const crashed = make();
    await crashed.start();
    const run = runOn(crashed);
    await run("look.stopall");
    await run("blackout", { on: false });
    await run("look.go", { id: "bleu" });
    crashed.saveLive();
    await crashed.stop();
    const second = make();
    await second.start();
    expect(second.resumed).to.deep.include({ looks: ["bleu"], blackout: false });
    expect(second.runtime.activeLooks()).to.deep.equal(["bleu"]);
    expect(second.engine.isBlackout()).to.equal(false);
    await second.stop();
  });

  it("holds the output standby", async () => {
    await prepare();
    const second = make(true);
    await second.start();
    expect(second.router.isStandby()).to.equal(true);
    expect(second.runtime.isActive("rouge")).to.equal(true);
    await second.stop();
  });

  it("skips a snapshot that no longer exists", async () => {
    await prepare();
    const edit = make();
    await edit.start();
    edit.runtime.saveSettings({ startupSnapshot: "gone" }); // a hand-edited show.json
    await edit.stop();
    rmSync(join(dataRoot, "machine", "live.json"), { force: true });
    const second = make();
    await second.start();
    expect(second.runtime.activeLooks()).to.deep.equal([]);
    expect(second.engine.isBlackout()).to.equal(false);
    await second.stop();
  });

  it("refuses an unknown snapshot, clears with null, and is cleared when the snapshot is deleted", async () => {
    await prepare();
    const p = make();
    await p.start();
    const run = runOn(p);
    const startup = async () => ((await run("show.settings")) as { startupSnapshot?: string }).startupSnapshot;
    expect(await startup()).to.equal("depart");
    let refused = "";
    await run("show.settings.set", { startupSnapshot: "nope" }).catch((e: Error) => (refused = e.message));
    expect(refused).to.match(/nope/);
    await run("show.settings.set", { startupSnapshot: null });
    expect(await startup()).to.equal(undefined);
    await run("show.settings.set", { startupSnapshot: "depart" });
    await run("snapshot.delete", { id: "depart" });
    expect(await startup()).to.equal(undefined);
    await p.stop();
  });

  it("show.open recalls the opened show's startup snapshot", async () => {
    await prepare();
    const p = make();
    await p.start();
    const run = runOn(p);
    const other = (await run("show.create", { name: "Autre", from: "default", open: false })) as { id: string };
    await run("look.stopall");
    await run("blackout", { on: false });
    await run("show.open", { id: other.id });
    expect(p.runtime.isActive("rouge")).to.equal(true);
    expect(p.engine.isBlackout()).to.equal(true);
    await run("look.stopall");
    await run("show.open", { id: "default" });
    expect(p.runtime.isActive("rouge")).to.equal(true);
    await p.stop();
  });
});
