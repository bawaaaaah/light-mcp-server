import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { exclusiveMoves, nextExclusiveName } from "../../../src/plugins/light/show/exclusive.js";
import { GroupSchema } from "../../../src/plugins/light/show/model.js";

describe("exclusive groups as radio buttons", () => {
  const group = (id: string, looks: string[], exclusive = true) => GroupSchema.parse({ id, name: id, exclusive, members: { looks } });

  it("puts looks in one set, out of the other exclusive groups, never touching the others", () => {
    const groups = [group("one", ["a", "b"]), group("two", ["c"]), group("dca", ["a", "c"], false)];
    const moved = exclusiveMoves(groups, ["b", "c"], "one");
    // b already in « one », c taken out of « two » into it; the DCA, no set, keeps its looks
    expect(moved.map((g) => [g.id, g.members.looks])).to.deep.equal([
      ["one", ["a", "b", "c"]],
      ["two", []],
    ]);
  });

  it("adds the new members after the others, and takes them out of every set with no target", () => {
    const groups = [group("one", ["a"]), group("two", ["c", "d"]), group("dca", ["c"], false)];
    expect(exclusiveMoves(groups, ["d", "c"], "one").map((g) => [g.id, g.members.looks])).to.deep.equal([
      ["one", ["a", "d", "c"]],
      ["two", []],
    ]);
    expect(exclusiveMoves(groups, ["c"]).map((g) => [g.id, g.members.looks])).to.deep.equal([["two", ["d"]]]); // the DCA keeps it
    expect(exclusiveMoves(groups, ["a"], "one")).to.deep.equal([]); // already there: nothing to save
    expect(nextExclusiveName([group("Exclusif 1", []), group("exclusif 2", [])].map((g) => ({ ...g, name: g.id })), "Exclusif")).to.equal("Exclusif 3");
  });

  describe("in the plugin", () => {
    let plugin: LightPlugin;
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());

    beforeEach(async () => {
      const dataRoot = join(mkdtempSync(join(tmpdir(), "light-exclusive-")), "data");
      mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
      copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
      const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
      await run("venue.fixture.put", { fixture: { id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1 } });
      await run("venue.canvas.put", { canvas: { id: "mur", name: "Mur", cells: 4, render: [{ from: 0, to: 3, targets: [{ fixture: "bar", head: -1 }] }] } });
      for (const [id, color] of [["a", "#ff0000"], ["b", "#00ff00"], ["c", "#0000ff"], ["d", "#ffffff"]]) {
        await run("look.put", { look: { id, name: `Look ${id}`, canvas: "mur", technique: { kind: "plat", color } } });
      }
    });

    it("makes two sets side by side: a look started releases only the others of its own set", async () => {
      expect(await run("look.exclusive", { looks: ["a", "b"], create: {} })).to.deep.equal({ group: "exclusif-1", changed: ["exclusif-1"] });
      expect(await run("look.exclusive", { looks: ["c", "d"], create: {} })).to.deep.equal({ group: "exclusif-2", changed: ["exclusif-2"] });
      expect(plugin.runtime.groups.get("exclusif-2")).to.include({ name: "Exclusif 2", exclusive: true });
      await run("look.go", { id: "a" });
      await run("look.go", { id: "c" });
      await run("look.go", { id: "b" });
      expect(plugin.runtime.activeLooks().sort()).to.deep.equal(["b", "c"]); // a released, c in the other set kept
      await run("look.go", { id: "d" });
      expect(plugin.runtime.activeLooks().sort()).to.deep.equal(["b", "d"]);
      // b moves to the second set; a, alone in the first, is taken out of every set
      await run("look.exclusive", { looks: ["b"], group: "exclusif-2" });
      await run("look.exclusive", { looks: ["a"] });
      expect(plugin.runtime.groups.get("exclusif-1")!.members.looks).to.deep.equal([]);
      expect(plugin.runtime.groups.get("exclusif-2")!.members.looks).to.deep.equal(["c", "d", "b"]);
      // a named set, and a group that is no set is refused
      expect(((await run("look.exclusive", { looks: ["a"], create: { name: "Fumée" } })) as { group: string }).group).to.equal("fumee");
      await run("group.put", { group: { id: "dca", name: "DCA", members: { looks: ["a"] } } });
      let refused = "";
      await run("look.exclusive", { looks: ["a"], group: "dca" }).catch((e: Error) => (refused = e.message));
      expect(refused).to.contain("pas un groupe exclusif");
    });
  });
});
