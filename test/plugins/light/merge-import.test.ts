import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, mergeImport } from "../../../src/plugins/light/presets/merge-import.js";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

type G = { id: string; name: string; members: string[]; master?: { level: number }; limits?: { max: number } };

describe("re-import without losing work (mode hybride)", () => {
  const at = (items: G[]) => (id: string) => items.find((x) => x.id === id);

  it("adds new objects, updates untouched ones, keeps hand edits, and always keeps live state", () => {
    const imported: G = { id: "a", name: "A", members: ["x"], master: { level: 1 } };
    const previous = { a: fingerprint("groups", imported), b: fingerprint("groups", { id: "b", name: "B", members: [] }) };
    const existing: G[] = [
      { ...imported, master: { level: 0.4 }, limits: { max: 0.8 } }, // untouched design, live level and limits set
      { id: "b", name: "B renamed by hand", members: [] }, // edited by hand
    ];
    const incoming: G[] = [
      { id: "a", name: "A", members: ["x", "y"], master: { level: 1 } }, // changed in QLC+
      { id: "b", name: "B", members: ["z"] },
      { id: "c", name: "C", members: [] }, // new
    ];
    const m = mergeImport("groups", incoming, at(existing), previous);
    expect(m.added).to.deep.equal(["c"]);
    expect(m.updated).to.deep.equal(["a"]);
    expect(m.kept).to.deep.equal(["b"]);
    const a = m.write.find((x) => x.id === "a")!;
    expect(a.members).to.deep.equal(["x", "y"]); // the new design
    expect(a.master).to.deep.equal({ level: 0.4 }); // the live level
    expect(a.limits).to.deep.equal({ max: 0.8 }); // the limits
    expect(m.write.find((x) => x.id === "b")).to.equal(undefined);
    expect(m.fingerprints.b).to.equal(previous.b); // still the last imported version: the edit stays recognised
  });

  it("is careful with objects imported before fingerprints existed, and can overwrite on request", () => {
    const existing: G[] = [{ id: "a", name: "edited", members: [] }];
    const incoming: G[] = [{ id: "a", name: "A", members: [] }];
    expect(mergeImport("groups", incoming, at(existing), {}).toCheck).to.deep.equal(["a"]);
    const forced = mergeImport("groups", incoming, at(existing), {}, true);
    expect(forced.updated).to.deep.equal(["a"]);
  });

  it("does not count user fields (stage position) as an edit", () => {
    const f = { id: "bar", name: "Bar", address: 1 };
    const m = mergeImport("fixtures", [f], () => ({ ...f, position: { x: 1, y: 2, z: 3 } }), { bar: fingerprint("fixtures", f) });
    expect(m.unchanged).to.deep.equal(["bar"]);
  });

  it("re-imports a real workspace: hand work survives, QLC+ changes come through", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-reimport-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    const xml = readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8");
    await run("import.qxw", { xml, apply: true });
    // hand work: a stage position, a DCA limit and level, a look rebuilt by hand
    const bar = plugin.runtime.venue.fixtures.get("bar-0")!;
    await run("venue.fixture.put", { fixture: { ...bar, position: { x: 1, y: 2, z: 3 } } });
    await run("group.put", { group: { ...plugin.runtime.groups.get("master")!, limits: { max: 0.7, mode: "clamp" } } });
    await run("group.level", { id: "master", level: 0.5 });
    await run("look.put", { look: { ...plugin.runtime.looks.get("checker")!, technique: { kind: "damier", colors: ["#ff0000", "#0000ff"], block: 4 } } });
    plugin.runtime.groups.flushLive();
    // QLC+ side: the « hole » sequence changed
    const changed = xml.replace('Name="hole" BoundScene="31"><Speed FadeIn="0" FadeOut="0" Duration="500"/>', 'Name="hole" BoundScene="31"><Speed FadeIn="0" FadeOut="0" Duration="250"/>');
    const r = (await run("import.qxw", { xml: changed, apply: true })) as { merged: Record<string, { kept: string[]; updated: number }> };
    expect(plugin.runtime.venue.fixtures.get("bar-0")!.position).to.deep.equal({ x: 1, y: 2, z: 3 });
    expect(plugin.runtime.groups.get("master")).to.deep.include({ limits: { max: 0.7, mode: "clamp" }, master: { level: 0.5, mute: false } });
    expect(plugin.runtime.looks.get("checker")!.technique.kind).to.equal("damier"); // kept
    expect(r.merged.looks.kept).to.deep.equal(["checker"]);
    expect(r.merged.looks.updated).to.equal(1); // « hole » follows QLC+
    // an import made before fingerprints existed: differences are kept and listed, never overwritten
    rmSync(join(dataRoot, "shows", "default", "import-state.json"));
    const legacy = (await run("import.qxw", { xml, apply: true })) as { merged: Record<string, { toCheck: string[] }> };
    expect(legacy.merged.looks.toCheck).to.have.members(["checker", "hole"]);
  });
});
