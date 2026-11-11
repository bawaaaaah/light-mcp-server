import { expect } from "chai";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { findDuplicateDefinitions, sameNameMessage, type LibraryEntry } from "../../../src/plugins/light/venue/definition-duplicates.js";
import { parseQxf } from "../../../src/plugins/light/venue/qxf-import.js";

/** A synthetic RGB fixture; `extra` adds channels to the mode, `strobeMax` moves a capability range. */
function qxf(manufacturer: string, model: string, opts: { extra?: number; strobeMax?: number; names?: [string, string, string] } = {}): string {
  const [r, g, b] = opts.names ?? ["Red", "Green", "Blue"];
  const extra = Array.from({ length: opts.extra ?? 0 }, (_, i) => ({ n: `Aux${i}`, at: 4 + i }));
  return `<?xml version="1.0"?>
<FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition">
 <Manufacturer>${manufacturer}</Manufacturer>
 <Model>${model}</Model>
 <Type>Color Changer</Type>
 <Channel Name="Dimmer" Preset="IntensityMasterDimmer"/>
 <Channel Name="${r}" Preset="IntensityRed"/>
 <Channel Name="${g}" Preset="IntensityGreen"/>
 <Channel Name="${b}" Preset="IntensityBlue"/>
 <Channel Name="Strobe"><Group Byte="0">Shutter</Group><Capability Min="0" Max="10" Preset="ShutterOpen">Open</Capability><Capability Min="11" Max="${opts.strobeMax ?? 255}" Preset="StrobeSlowToFast">Strobe</Capability></Channel>
${extra.map((e) => ` <Channel Name="${e.n}"><Capability Min="0" Max="255">Other</Capability></Channel>`).join("\n")}
 <Mode Name="Standard">
  <Channel Number="0">Dimmer</Channel><Channel Number="1">${r}</Channel><Channel Number="2">${g}</Channel><Channel Number="3">${b}</Channel><Channel Number="4">Strobe</Channel>
${extra.map((e, i) => `  <Channel Number="${5 + i}">${e.n}</Channel>`).join("\n")}
 </Mode>
</FixtureDefinition>`;
}

const entry = (source: string, xml: string): LibraryEntry => ({ source, def: parseQxf(xml) });

describe("duplicate fixture definitions: detection", () => {
  it("finds identical copies of one model under spellings the lookup treats alike", () => {
    const rep = findDuplicateDefinitions([entry("a.qxf", qxf("Acme", "Wash-3")), entry("b.qxf", qxf("ACME", "wash 3")), entry("c.qxf", qxf("Acme", "Spot"))]);
    expect(rep.sameName).to.have.length(1);
    expect(rep.sameName[0]!.winner).to.equal("a.qxf");
    expect(rep.sameName[0]!.others).to.deep.equal([{ source: "b.qxf", identical: true }]);
  });

  it("names the winner and says how a differing copy differs", () => {
    const rep = findDuplicateDefinitions([entry("old.qxf", qxf("Acme", "Wash")), entry("new.qxf", qxf("Acme", "Wash", { extra: 2 })), entry("rng.qxf", qxf("Acme", "Wash", { strobeMax: 200 }))]);
    const g = rep.sameName[0]!;
    expect(g.winner).to.equal("old.qxf");
    expect(g.others[0]).to.include({ source: "new.qxf", identical: false });
    expect(g.others[0]!.diff!.channelCounts).to.deep.equal([{ mode: "Standard", winner: 5, other: 7 }]);
    expect(g.others[1]!.diff!.rangesDiffer).to.deep.equal(["Standard"]);
    const msg = sameNameMessage(g);
    expect(msg).to.contain("old.qxf est utilisé").and.to.contain("7 canaux au lieu de 5").and.to.contain("plages différents");
  });

  it("finds the same structure under two names, but not two distinct fixtures", () => {
    const rep = findDuplicateDefinitions([entry("a.qxf", qxf("Acme", "Wash")), entry("b.qxf", qxf("Other", "Wash Pro", { names: ["R", "G", "B"] })), entry("c.qxf", qxf("Acme", "Long", { extra: 3 })), entry("d.qxf", qxf("Acme", "Range", { strobeMax: 100 }))]);
    expect(rep.sameName).to.deep.equal([]);
    expect(rep.sameSignature).to.have.length(1);
    expect(rep.sameSignature[0]!.names.map((n) => n.model)).to.deep.equal(["Wash", "Wash Pro"]);
  });

  it("reports nothing for a library of distinct fixtures", () => {
    const rep = findDuplicateDefinitions([entry("a.qxf", qxf("Acme", "A")), entry("b.qxf", qxf("Acme", "B", { extra: 1 })), entry("c.qxf", qxf("Zed", "C", { extra: 2 }))]);
    expect(rep).to.deep.equal({ sameName: [], sameSignature: [] });
  });
});

describe("duplicate fixture definitions: the show check", () => {
  function setup(files: Record<string, string>, patched: [string, string][]) {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-dups-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    for (const [f, xml] of Object.entries(files)) writeFileSync(join(dataRoot, "fixtures", f), xml);
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    const patch = async () => {
      for (const [i, [manufacturer, model]] of patched.entries()) await run("venue.fixture.put", { fixture: { id: `f${i}`, name: `F${i}`, manufacturer, model, mode: "Standard", universe: 1, address: 1 + i * 10 } });
    };
    const lint = async () => ((await run("show.lint")) as { issues: { level: string; where: string; message: string }[] }).issues.filter((i) => i.where.startsWith("définition"));
    return { run, patch, lint };
  }

  it("warns when a patched model has differing files, naming the one in use", async () => {
    const t = setup({ "a.qxf": qxf("Acme", "Wash"), "b.qxf": qxf("Acme", "Wash", { extra: 2 }) }, [["Acme", "Wash"]]);
    await t.patch();
    const issues = await t.lint();
    expect(issues).to.have.length(1);
    expect(issues[0]!.level).to.equal("attention");
    expect(issues[0]!.message).to.contain("a.qxf est utilisé").and.to.contain("b.qxf");
    const check = (await t.run("venue.patch.check")) as { duplicateDefinitions: { sameName: { winner: string }[] } };
    expect(check.duplicateDefinitions.sameName[0]!.winner).to.equal("a.qxf");
  });

  it("stays quiet for identical copies and for duplicates of models the venue does not patch", async () => {
    const t = setup({ "a.qxf": qxf("Acme", "Wash"), "b.qxf": qxf("Acme", "Wash"), "c.qxf": qxf("Zed", "Spot", { extra: 3 }), "d.qxf": qxf("Zed", "Spot", { extra: 4 }) }, [["Acme", "Wash"]]);
    await t.patch();
    expect(await t.lint()).to.deep.equal([]);
    const check = (await t.run("venue.patch.check")) as { duplicateDefinitions: { sameName: unknown[] } };
    expect(check.duplicateDefinitions.sameName).to.have.length(2); // the whole library is still reported there
  });

  it("warns about one structure under two names when the venue patches one of them", async () => {
    const t = setup({ "a.qxf": qxf("Acme", "Wash"), "b.qxf": qxf("Other", "Wash Pro") }, [["Other", "Wash Pro"]]);
    await t.patch();
    const issues = await t.lint();
    expect(issues).to.have.length(1);
    expect(issues[0]!.message).to.contain("même structure").and.to.contain("Acme Wash").and.to.contain("Other Wash Pro");
  });
});
