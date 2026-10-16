import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { PANIC_UNDO_MS } from "../../../src/plugins/light/show/runtime.js";

describe("undoing a Panic pressed by mistake", () => {
  let plugin: LightPlugin;
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());

  beforeEach(async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-undo-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
  });

  it("puts back the looks and levels from just before, even after a second Panic", async () => {
    await run("look.go", { id: "hole" });
    await run("group.level", { id: "master", level: 0.4 });
    expect(plugin.state().panicUndo).to.equal(false);
    await run("panic");
    await run("panic"); // the finger insisted
    expect(plugin.runtime.activeLooks()).to.not.include("hole");
    expect(plugin.state().panicUndo).to.equal(true);
    await run("panic.undo");
    expect(plugin.runtime.activeLooks()).to.deep.equal(["hole"]);
    expect(plugin.runtime.groups.get("master")!.master!.level).to.equal(0.4);
    expect(plugin.state().panicUndo).to.equal(false); // once
    let refused = "";
    await run("panic.undo").catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("rien à annuler");
  });

  it("undoes the last Panic when something played in between", async () => {
    await run("look.go", { id: "hole" });
    await run("panic"); // on purpose
    await run("look.go", { id: "masks" });
    await run("panic"); // by mistake
    await run("panic.undo");
    expect(plugin.runtime.activeLooks()).to.deep.equal(["masks"]);
  });

  it("is gone after a minute", () => {
    const now = 1_000_000;
    plugin.runtime.rememberBeforePanic(false, now);
    expect(plugin.runtime.panicUndoUntil(now + PANIC_UNDO_MS)).to.equal(now + PANIC_UNDO_MS);
    expect(plugin.runtime.takeBeforePanic(now + PANIC_UNDO_MS + 1)).to.equal(undefined);
  });
});
