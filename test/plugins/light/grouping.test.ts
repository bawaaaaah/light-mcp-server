import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { proposeTypeGrouping, typeTagOf, type TypedFixture } from "../../../src/plugins/light/venue/grouping.js";

const fx = (id: string, over: Partial<TypedFixture> = {}): TypedFixture => ({ id, name: id, tags: [], type: "Color Changer", moving: false, machine: false, colour: true, ...over });

describe("type groups, on proposal", () => {
  it("reads a generic kind from the definition: moving heads, machines, washes, bars, dimmers", () => {
    expect(typeTagOf({ type: "Other", moving: true, machine: false, colour: true })).to.equal("lyre");
    expect(typeTagOf({ type: "Hazer", moving: false, machine: false, colour: false })).to.equal("machine");
    expect(typeTagOf({ type: "Effect", moving: false, machine: true, colour: true })).to.equal("machine"); // a fog with LEDs
    expect(typeTagOf({ type: "Color Changer", moving: false, machine: false, colour: true })).to.equal("wash");
    expect(typeTagOf({ type: "LED Bar (Pixels)", moving: false, machine: false, colour: true })).to.equal("barre");
    expect(typeTagOf({ type: "Dimmer", moving: false, machine: false, colour: false })).to.equal("gradateur");
    expect(typeTagOf({ type: "", moving: false, machine: false, colour: false })).to.equal(undefined); // no definition
  });

  it("proposes the missing tags and a group per kind of two fixtures or more, never over an existing group", () => {
    const fixtures = [fx("w1"), fx("w2", { tags: ["wash", "face"] }), fx("h1", { moving: true }), fx("h2", { moving: true }), fx("fog", { type: "Hazer", colour: false })];
    const p = proposeTypeGrouping(fixtures, [{ id: "type-lyre", name: "Wash", fixtures: ["x"] }]);
    expect(p.tags.map((t) => [t.fixture, t.tag])).to.deep.equal([
      ["w1", "wash"],
      ["h1", "lyre"],
      ["h2", "lyre"],
      ["fog", "machine"],
    ]);
    // a group of one (the fog) is not proposed; the taken id and name are left alone
    expect(p.groups.map((g) => [g.tag, g.id, g.name, g.fixtures])).to.deep.equal([
      ["lyre", "type-lyre-2", "Lyres", ["h1", "h2"]],
      ["wash", "type-wash", "Wash (wash)", ["w1", "w2"]],
    ]);
    // a kind already gathered (a live group on its tag, or a group holding exactly its fixtures) gets no group
    const gathered = proposeTypeGrouping(fixtures, [
      { id: "mine", name: "Mes lyres", fixtures: [], selector: { tags: ["lyre"] } },
      { id: "faces", name: "Faces", fixtures: ["w2", "w1"] },
    ]);
    expect(gathered.groups).to.deep.equal([]);
  });

  it("writes nothing on proposal, then applies only what is chosen: a live group by tag or a fixed list", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-grouping-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    writeFileSync(
      join(dataRoot, "fixtures", "head.qxf"),
      `<?xml version="1.0" encoding="UTF-8"?><FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition"><Manufacturer>Test</Manufacturer><Model>Head</Model><Type>Moving Head</Type><Channel Name="Pan" Preset="PositionPan"/><Channel Name="Tilt" Preset="PositionTilt"/><Mode Name="2 Channel"><Channel Number="0">Pan</Channel><Channel Number="1">Tilt</Channel></Mode></FixtureDefinition>`,
    );
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    const put = (id: string, model: string, mode: string, address: number, tags: string[] = []) => run("venue.fixture.put", { fixture: { id, name: id, manufacturer: "Test", model, mode, universe: 1, address, tags } });
    await put("bar-a", "Bar 4", "15 Channel", 1, ["face"]);
    await put("bar-b", "Bar 4", "15 Channel", 16);
    await put("head-a", "Head", "2 Channel", 31);
    await put("head-b", "Head", "2 Channel", 33);
    const proposal = (await run("venue.grouping.propose")) as { tags: { fixture: string; tag: string }[]; groups: { tag: string }[] };
    expect(proposal.groups.map((g) => g.tag).sort()).to.deep.equal(["barre", "lyre"]);
    expect((await run("group.list")) as unknown[]).to.deep.equal([]); // nothing written
    const lint = (await run("show.lint")) as { issues: { level: string; where: string; message: string }[] };
    expect(lint.issues.find((i) => i.where === "groupes par type")!.level).to.equal("info");

    const applied = (await run("venue.grouping.apply", { groups: [{ tag: "lyre", live: true }, { tag: "barre", live: false }] })) as { tagged: { fixture: string }[]; created: { id: string }[] };
    expect(applied.tagged.map((t) => t.fixture)).to.deep.equal(["head-a", "head-b"]); // the live group's fixtures need its tag; the bars were not asked
    const groups = (await run("group.list")) as { id: string; selector?: { tags: string[] }; members: { fixtures: string[] } }[];
    const live = groups.find((g) => g.selector?.tags?.[0] === "lyre")!;
    const fixed = groups.find((g) => g.id !== live.id)!;
    expect(fixed.members.fixtures).to.deep.equal(["bar-a", "bar-b"]);
    const tagsOf = async (id: string) => ((await run("venue.fixture.list")) as { id: string; tags: string[] }[]).find((f) => f.id === id)!.tags;
    expect(await tagsOf("bar-a")).to.deep.equal(["face"]); // other tags untouched, nothing added unasked

    // a head patched later joins the live group once it bears the tag, which is proposed again
    await put("head-c", "Head", "2 Channel", 35);
    const next = (await run("venue.grouping.propose")) as { tags: { fixture: string; tag: string }[]; groups: unknown[] };
    expect(next.tags.filter((t) => t.tag === "lyre").map((t) => t.fixture)).to.deep.equal(["head-c"]);
    expect(next.groups).to.deep.equal([]);
    await run("venue.grouping.apply", { tags: ["lyre"] });
    expect(plugin.runtime.fixturesOf(live.id)).to.have.all.keys("head-a", "head-b", "head-c");

    let refused = "";
    await run("venue.grouping.apply", { groups: [{ tag: "lyre", live: true }] }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("rien n'est proposé pour : lyre");
  });
});
