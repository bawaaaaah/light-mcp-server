import { expect } from "chai";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { parseQxf } from "../../../src/plugins/light/venue/qxf-import.js";
import { RESET_RULE_ID, RESET_WINDOW_MS, resetChannels } from "../../../src/plugins/light/rules/reset-protection.js";

/** A synthetic moving head: pan, tilt, dimmer, and a control channel whose top range resets it. */
const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition">
 <Manufacturer>Test</Manufacturer><Model>Head</Model><Type>Moving Head</Type>
 <Channel Name="Pan" Preset="PositionPan"/>
 <Channel Name="Tilt" Preset="PositionTilt"/>
 <Channel Name="Dimmer" Preset="IntensityDimmer"/>
 <Channel Name="Control"><Group Byte="0">Maintenance</Group><Capability Min="0" Max="199">No function</Capability><Capability Min="200" Max="255">Reset</Capability></Channel>
 <Mode Name="4 Channel"><Channel Number="0">Pan</Channel><Channel Number="1">Tilt</Channel><Channel Number="2">Dimmer</Channel><Channel Number="3">Control</Channel></Mode>
</FixtureDefinition>`;

/** Two heads (control channels at DMX 4 and 24) on a plugin whose clock the test moves. */
async function setup() {
  const dataRoot = join(mkdtempSync(join(tmpdir(), "light-reset-")), "data");
  mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
  writeFileSync(join(dataRoot, "fixtures", "head.qxf"), HEAD);
  const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
  let now = 1000;
  const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null, now: () => now });
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  for (const [id, address] of [["h1", 1], ["h2", 21]] as const) await run("venue.fixture.put", { fixture: { id, name: id.toUpperCase(), manufacturer: "Test", model: "Head", mode: "4 Channel", universe: 1, address } });
  const control = (address: number) => plugin.engine.render()[0]![address - 1 + 3]!;
  return { plugin, run, control, advance: (ms: number) => (now += ms) };
}

describe("Reset channel protection (built-in locked rule)", () => {
  it("finds a fixture's Reset channels and the value that triggers each", () => {
    const def = parseQxf(HEAD);
    expect(resetChannels({ def, mode: def.modes[0]! })).to.deep.equal([{ offset: 3, name: "Control", value: 200 }]);
  });

  it("holds a Reset range at rest against a look, a fader, a rule and the console, and dmx.explain names it", async () => {
    const { run, control } = await setup();
    await run("venue.canvas.put", { canvas: { id: "c", name: "C", cells: 1 } });
    await run("look.put", { look: { id: "raw", name: "Raw", canvas: "c", technique: { kind: "aucune" }, timing: { every: { beats: 1 }, attack: 0, order: "loop", entryFade: 0 }, channels: { targets: [{ fixture: "h1", offset: 3 }], steps: [[230]] } } });
    await run("look.go", { id: "raw" });
    expect(control(1)).to.equal(199); // the look: back to the top of « No function »
    await run("look.stop", { id: "raw" });
    await run("fader.put", { fader: { id: "f", name: "F", channels: [{ fixture: "h1", offset: 3 }], level: 1 } });
    expect(control(1)).to.equal(199); // a fader at full
    await run("fader.delete", { id: "f" });
    await run("rule.put", { rule: { id: "plancher", name: "Plancher", level: "show", target: { channel: "Control" }, min: 220 } });
    expect(control(1)).to.equal(199); // a rule's floor inside the Reset range
    await run("rule.delete", { id: "plancher" });
    await run("dmx.set", { universe: 1, channel: 4, value: 250 });
    expect(control(1)).to.equal(199); // the console's forcing too
    const why = (await run("dmx.explain", { universe: 1, channel: 4 })) as { parked?: number; clamps: { rule: string; name?: string }[]; resettable?: boolean };
    expect(why.parked).to.equal(250);
    expect(why.clamps.map((c) => c.rule)).to.include(RESET_RULE_ID);
    expect(why.clamps.find((c) => c.rule === RESET_RULE_ID)!.name).to.contain("Reset");
    expect(why.resettable).to.equal(true);
  });

  it("is listed by rule.list and can be neither replaced nor deleted", async () => {
    const { run } = await setup();
    const list = (await run("rule.list")) as { builtin: { id: string; locked: boolean }[]; venue: unknown[] };
    expect(list.builtin.map((r) => [r.id, r.locked])).to.deep.equal([[RESET_RULE_ID, true]]);
    expect(list.venue).to.deep.equal([]); // not seeded into the venue's files
    let refused = "";
    await run("rule.delete", { where: "venue", id: RESET_RULE_ID }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("intégrée");
    refused = "";
    await run("rule.put", { where: "venue", rule: { id: RESET_RULE_ID, name: "x", target: {} } }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("intégrée");
  });

  it("lets fixture.reset through for that fixture only, for its window, then protects again", async () => {
    const { run, control, advance } = await setup();
    await run("dmx.set", { universe: 1, channel: 24, value: 250 }); // h2 forced into its Reset range: held
    const done = (await run("fixture.reset", { id: "h1" })) as { channels: { value: number }[]; seconds: number };
    expect(done.channels.map((c) => c.value)).to.deep.equal([200]);
    expect(done.seconds).to.equal(RESET_WINDOW_MS / 1000);
    expect(control(1)).to.equal(200); // the start of its Reset range
    expect(control(21)).to.equal(199); // the other head stays protected
    const log = (await run("activity.list")) as { name: string; target?: string }[];
    expect(log.find((e) => e.name === "fixture.reset")).to.deep.include({ target: "h1" }); // traced like any command
    advance(RESET_WINDOW_MS - 1);
    expect(control(1)).to.equal(200);
    advance(1);
    expect(control(1)).to.equal(0); // window closed: back to what the show writes
    await run("dmx.set", { universe: 1, channel: 4, value: 250 });
    expect(control(1)).to.equal(199); // and protected again
    let refused = "";
    await run("fixture.reset", { id: "nope" }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("nope");
  });
});
