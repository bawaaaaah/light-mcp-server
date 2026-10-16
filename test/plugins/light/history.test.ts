import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

describe("versions: earlier versions of looks, groups, faders and dashboards", () => {
  let plugin: LightPlugin;
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  const tick = () => new Promise((r) => setTimeout(r, 5)); // one history entry per millisecond stamp
  const versions = (collection: string, id: string) => run("history.list", { collection, id }) as Promise<{ stamp: string; at: string }[]>;

  beforeEach(async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-history-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
  });

  it("puts a look back, and a restore is undone the same way", async () => {
    const look = plugin.runtime.looks.get("hole")!;
    await tick();
    await run("look.put", { look: { ...look, name: "Creux bleu" } });
    const [before] = await versions("looks", "hole");
    expect(before).to.have.keys("stamp", "at");
    await tick();
    await run("history.restore", { collection: "looks", id: "hole", stamp: before!.stamp });
    expect(plugin.runtime.looks.get("hole")!.name).to.equal(look.name);
    const again = await versions("looks", "hole");
    expect(again).to.have.length(2); // the restored-over version is kept too
    await run("history.restore", { collection: "looks", id: "hole", stamp: again[0]!.stamp });
    expect(plugin.runtime.looks.get("hole")!.name).to.equal("Creux bleu");
  });

  it("lists a deleted look, and brings it back", async () => {
    const name = plugin.runtime.looks.get("breath")!.name;
    await run("look.delete", { id: "breath", force: true });
    const gone = (await run("history.deleted", { collection: "looks" })) as { id: string; name?: string; stamp: string }[];
    expect(gone.map((g) => g.id)).to.deep.equal(["breath"]); // the others were changed, not deleted
    expect(gone[0]!.name).to.equal(name);
    await run("history.restore", { collection: "looks", id: "breath", stamp: gone[0]!.stamp });
    expect(plugin.runtime.looks.get("breath")).to.not.equal(undefined);
    expect(await run("history.deleted", { collection: "looks" })).to.deep.equal([]);
  });

  it("restores a DCA's design without moving its live level", async () => {
    const group = plugin.runtime.groups.get("master")!;
    await tick();
    await run("group.put", { group: { ...group, limits: { max: 0.5, mode: "clamp" } } });
    await run("group.level", { id: "master", level: 0.3 });
    const [before] = await versions("groups", "master");
    await run("history.restore", { collection: "groups", id: "master", stamp: before!.stamp });
    const now = plugin.runtime.groups.get("master")!;
    expect(now.limits?.max).to.equal(group.limits?.max);
    expect(now.master?.level).to.equal(0.3);
  });

  it("undoes a change from its activity line: an edit, a deletion; not a creation nor a live move", async () => {
    type Line = { name: string; target?: string; at: number; until: number; undo?: { collection: string; id: string } };
    const lines = async () => (await run("activity.list")) as Line[];
    const undo = (l: Line) => run("history.undo", { ...l.undo, at: l.at, until: l.until });
    const look = plugin.runtime.looks.get("hole")!;
    await tick();
    const as = (who: string) => ({ ...systemContext(), who });
    await plugin.commands.invoke("look.put", { look: { ...look, name: "Creux bleu" } }, as("Alice"));
    await tick();
    await plugin.commands.invoke("look.put", { look: { ...look, name: "Creux rouge" } }, as("Bob")); // another line: another caller
    const edits = (await lines()).filter((l) => l.name === "look.put" && l.target === "hole");
    expect(edits).to.have.length(2);
    expect(edits[1]!.undo).to.deep.equal({ collection: "looks", id: "hole" });
    await undo(edits[1]!); // Alice's change, and Bob's after it with it
    expect(plugin.runtime.looks.get("hole")!.name).to.equal(look.name);
    // a deletion comes back
    await run("look.delete", { id: "breath", force: true });
    const deleted = (await lines()).find((l) => l.name === "look.delete")!;
    await undo(deleted);
    expect(plugin.runtime.looks.get("breath")).to.not.equal(undefined);
    // a creation replaced nothing; a level moved is state, nothing to undo
    await run("look.put", { look: { ...look, id: "neuf", name: "Neuf" } });
    let refused = "";
    await undo((await lines()).find((l) => l.target === "neuf")!).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("une création s'annule en supprimant");
    await run("group.level", { id: "master", level: 0.5 });
    expect((await lines()).find((l) => l.name === "group.level")!.undo).to.equal(undefined);
  });

  it("refuses a version that is not there", async () => {
    let refused = "";
    await run("history.restore", { collection: "looks", id: "hole", stamp: "2026-01-01T00-00-00-000Z-000000" }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("version introuvable");
    await run("history.restore", { collection: "looks", id: "hole", stamp: "../../etc" }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("version introuvable");
  });
});
