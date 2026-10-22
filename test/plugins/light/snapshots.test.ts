import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

describe("snapshots: the whole live state, and Panic's safe state", () => {
  let plugin: LightPlugin;
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  const groupLevel = (id: string) => plugin.runtime.groups.get(id)!.master;

  beforeEach(async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-snap-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    await run("fader.put", { fader: { id: "uv", name: "UV", channels: [{ fixture: "bar-0", offset: 1 }], level: 0 } });
  });

  it("saves looks, DCA, faders, grand master and Blackout, and puts them back", async () => {
    await run("look.go", { id: "hole" });
    await run("look.go", { id: "masks" });
    await run("group.level", { id: "master", level: 0.4 });
    await run("group.mute", { id: "master", mute: true });
    await run("fader.level", { id: "uv", level: 0.7 });
    await run("show.settings.set", { grandMaster: 0.8 });
    const saved = (await run("snapshot.save", { name: "Accueil" })) as { id: string; looks: string[] };
    expect(saved.id).to.equal("accueil");
    expect(saved.looks).to.have.members(["hole", "masks"]);
    // everything moves
    await run("look.stopall");
    await run("look.go", { id: "breath" });
    await run("group.level", { id: "master", level: 1 });
    await run("group.mute", { id: "master", mute: false });
    await run("fader.level", { id: "uv", level: 0 });
    await run("show.settings.set", { grandMaster: 1 });
    await run("blackout", { on: true });
    expect(plugin.engine.isBlackout()).to.equal(true);
    const back = (await run("snapshot.recall", { id: "accueil" })) as { looks: string[]; skipped: string[] };
    expect(back.looks).to.have.members(["hole", "masks"]);
    expect(back.skipped).to.deep.equal([]);
    expect(groupLevel("master")).to.deep.include({ level: 0.4, mute: true });
    expect(plugin.runtime.faders.get("uv")!.level).to.equal(0.7);
    expect(plugin.runtime.settings.grandMaster).to.equal(0.8);
    expect(plugin.engine.isBlackout()).to.equal(false);
  });

  it("sets the grand master from the live (a level right, not a show write), says it in the state, doses the output", async () => {
    await run("look.go", { id: "breath" });
    expect(plugin.engine.render()[0]![0]).to.equal(255); // the first bar's master dimmer
    const r = (await run("grandmaster.set", { level: 0.5 })) as { grandMaster: number };
    expect(r.grandMaster).to.equal(0.5);
    expect(plugin.state().grandMaster).to.equal(0.5);
    expect(plugin.engine.render()[0]![0]).to.be.closeTo(128, 1); // dosed by its dimmer, colours kept
    const spec = plugin.commands.get("grandmaster.set")!;
    expect(spec.right).to.equal("commands:level");
  });

  it("channel faders: on a dimmer the fader doses it (dark at 0), on a colour it raises it, and a DCA doses both faders", async () => {
    const out = () => plugin.engine.render()[0]!;
    expect([out()[0], out()[15]]).to.deep.equal([255, 255]); // the show holds both bars' dimmers at full
    // the first bar's dimmer alone
    await run("fader.put", { fader: { id: "bords", name: "Barres des bords", channels: [{ fixture: "bar-0", offset: 0 }], level: 0 } });
    expect([out()[0], out()[15]]).to.deep.equal([0, 255]); // at 0 that bar is dark, the other one untouched
    await run("fader.level", { id: "bords", level: 0.5 });
    expect(out()[0]).to.be.closeTo(128, 1);
    // the second bar's dimmer and its first red
    await run("fader.put", { fader: { id: "centre", name: "Centre rouge", channels: [{ fixture: "bar-1", offset: 0 }, { fixture: "bar-1", offset: 3 }], level: 1 } });
    expect([out()[15], out()[18]]).to.deep.equal([255, 255]);
    // one DCA over both faders
    await run("group.put", { group: { id: "barres", name: "Barres", master: { level: 0.5, mute: false } } });
    for (const id of ["bords", "centre"]) await run("fader.put", { fader: { ...plugin.runtime.faders.get(id)!, dca: "barres" } });
    expect(out()[0]).to.be.closeTo(64, 1); // 0.5 × 0.5
    expect([out()[15], out()[18]].map((v) => Math.round(v / 2))).to.deep.equal([64, 64]);
    await run("group.mute", { id: "barres", mute: true });
    expect([out()[0], out()[15], out()[18]]).to.deep.equal([0, 0, 0]);
  });

  it("Panic recalls the safe snapshot (over the safe look), and skips what was deleted since", async () => {
    await run("look.go", { id: "hole" });
    await run("fader.level", { id: "uv", level: 0.5 });
    await run("snapshot.save", { name: "Secours" });
    await run("show.settings.set", { safeSnapshot: "secours", safeLook: "breath" });
    await run("look.stopall");
    await run("look.go", { id: "masks" });
    await run("fader.level", { id: "uv", level: 1 });
    const panic = (await run("panic")) as { action: string; looks: string[] };
    expect(panic).to.deep.include({ action: "safe-snapshot" });
    expect(plugin.runtime.activeLooks()).to.deep.equal(["hole"]);
    expect(plugin.runtime.faders.get("uv")!.level).to.equal(0.5);
    await run("look.delete", { id: "hole", force: true }); // still in the snapshot: deleted anyway
    const after = (await run("snapshot.recall", { id: "secours" })) as { skipped: string[] };
    expect(after.skipped).to.deep.equal(["hole"]);
    // deleting the safe snapshot leaves the safe look
    await run("snapshot.delete", { id: "secours" });
    expect(((await run("panic")) as { action: string }).action).to.equal("safe-look");
  });
});
