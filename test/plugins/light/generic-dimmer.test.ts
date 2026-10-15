import { expect } from "chai";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { findDefinition, findMode, GENERIC_DIMMER } from "../../../src/plugins/light/venue/qxf-import.js";
import { parseQxw } from "../../../src/plugins/light/presets/qxw-import.js";
import { qxwToShow } from "../../../src/plugins/light/presets/qxw-to-show.js";

/** A QLC+ workspace with two built-in generic dimmers (no .qxf) and a level slider on them. */
const WORKSPACE = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace><Creator><Version>4.14.1</Version></Creator><Engine>
<Fixture><Manufacturer>Generic</Manufacturer><Model>Generic</Model><Mode>1 Channel</Mode><ID>0</ID><Name>Douche</Name><Universe>0</Universe><Address>199</Address><Channels>1</Channels></Fixture>
<Fixture><Manufacturer>Generic</Manufacturer><Model>Generic</Model><Mode>2 Channels</Mode><ID>1</ID><Name>Pack</Name><Universe>0</Universe><Address>209</Address><Channels>2</Channels></Fixture>
</Engine>
<VirtualConsole><Frame Caption="">
<Slider Caption="Face" ID="40"><Input Universe="0" Channel="23"/><SliderMode ValueDisplayStyle="Exact" ClickAndGoType="None">Level</SliderMode><Level LowLimit="0" HighLimit="255" Value="0"><Channel Fixture="0">0</Channel><Channel Fixture="1">1</Channel></Level></Slider>
</Frame></VirtualConsole></Workspace>`;

describe("QLC+ built-in generic dimmer", () => {
  it("is found without a .qxf file, with a mode per channel count", () => {
    const def = findDefinition([], "Generic", "Generic")!;
    expect(def).to.equal(GENERIC_DIMMER);
    expect(findMode(def, "1 Channel")!.channels).to.deep.equal(["Dimmer 1"]);
    expect(findMode(def, "4 Channels")!.channels).to.have.length(4);
    expect(def.channels.get("Dimmer 3")!.attribute).to.equal("intensity");
    expect(findDefinition([], "Generic", "Generic Smoke")).to.equal(undefined);
  });

  it("is decoded by the import: no missing definition, its level slider drives the channels like in QLC+", () => {
    const p = qxwToShow(parseQxw(WORKSPACE), []);
    expect(p.report.warnings.filter((w) => w.includes("définition manquante"))).to.deep.equal([]);
    expect(p.groups.find((g) => g.id === "face")).to.equal(undefined); // no colour for a DCA to dose
    expect(p.faders.find((f) => f.id === "face")!.channels).to.deep.equal([{ fixture: "douche", offset: 0 }, { fixture: "pack", offset: 1 }]);
  });

  it("is listed in the library and lights up on the output", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-generic-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    const library = (await run("venue.library", { search: "generic" })) as { model: string }[];
    expect(library.map((d) => d.model)).to.deep.equal(["Generic"]);
    await run("import.qxw", { xml: WORKSPACE, apply: true });
    await run("fader.level", { id: "face", level: 1 });
    const out = plugin.engine.render()[0]!;
    expect([out[199], out[209], out[210]]).to.deep.equal([255, 0, 255]);
    await run("panic");
    expect(plugin.engine.render()[0]![199]).to.equal(0);
  });
});
