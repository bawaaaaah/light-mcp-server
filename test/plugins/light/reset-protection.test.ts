import { expect } from "chai";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext, type CommandError, type Origin } from "../../../src/plugins/light/commands/registry.js";
import { capabilityTags, parseQxf } from "../../../src/plugins/light/venue/qxf-import.js";
import { holdAtRest, powerOnResets, RESET_ORIGINS, RESET_RULE_ID, RESET_WINDOW_MS, resetChannels, restValue, unprotectable } from "../../../src/plugins/light/rules/reset-protection.js";
import type { ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";

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

/** A lamp head: its Reset range sits between Lamp off and Lamp on, and a second channel is all Lamp off and Reset. */
const LAMP = `<?xml version="1.0" encoding="UTF-8"?>
<FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition">
 <Manufacturer>Test</Manufacturer><Model>Lamp</Model><Type>Moving Head</Type>
 <Channel Name="Pan" Preset="PositionPan"/>
 <Channel Name="Control"><Group Byte="0">Maintenance</Group><Capability Min="0" Max="99">No function</Capability><Capability Min="100" Max="149" Preset="LampOff">Lamp off</Capability><Capability Min="150" Max="199">Reset pan/tilt</Capability><Capability Min="200" Max="227">Reset all</Capability><Capability Min="228" Max="255" Preset="LampOn">Lamp on</Capability></Channel>
 <Channel Name="Wipe"><Group Byte="0">Maintenance</Group><Capability Min="0" Max="99" Preset="LampOff">Lamp off</Capability><Capability Min="100" Max="255">Reset</Capability></Channel>
 <Mode Name="3 Channel"><Channel Number="0">Pan</Channel><Channel Number="1">Control</Channel><Channel Number="2">Wipe</Channel></Mode>
</FixtureDefinition>`;

/** A one-channel definition from its ranges, as [min, max, name, preset?]: synthetic, shaped on real QLC+ cases. */
function oneChannel(ranges: [number, number, string, string?][]) {
  const caps = ranges.map(([min, max, name, preset]) => `<Capability Min="${min}" Max="${max}"${preset ? ` Preset="${preset}"` : ""}>${name}</Capability>`).join("");
  const def = parseQxf(`<?xml version="1.0" encoding="UTF-8"?><FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition"><Manufacturer>Test</Manufacturer><Model>One</Model><Type>Moving Head</Type><Channel Name="Ctl"><Group Byte="0">Maintenance</Group>${caps}</Channel><Mode Name="1"><Channel Number="0">Ctl</Channel></Mode></FixtureDefinition>`);
  const mode = def.modes[0]!;
  const fx = { def, mode, patch: { id: "x", universe: 1, address: 1 } } as unknown as ResolvedFixture;
  /** What the protection sends for each value written in turn, with one memory. */
  const hold = (...values: number[]) => {
    const last = new Map<string, number>();
    return values.map((v) => {
      const buf = new Uint8Array(512);
      buf[0] = v;
      holdAtRest(fx, buf, last);
      return buf[0];
    });
  };
  return { def, mode, fx, hold, ch: def.channels.get("Ctl")! };
}

/** Two heads (control channels at DMX 4 and 24) on a plugin whose clock the test moves. */
async function setup(opts: { standby?: boolean } = {}) {
  const dataRoot = join(mkdtempSync(join(tmpdir(), "light-reset-")), "data");
  mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
  writeFileSync(join(dataRoot, "fixtures", "head.qxf"), HEAD);
  writeFileSync(join(dataRoot, "fixtures", "lamp.qxf"), LAMP);
  const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
  let now = 1000;
  const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null, now: () => now, ...(opts.standby ? { standby: true } : {}) });
  // a voluntary reset is accepted where someone can confirm: the command line here
  const run = (name: string, args: unknown = {}, origin: Origin = "cli") => plugin.commands.invoke(name, args, systemContext(origin));
  for (const [id, address] of [["h1", 1], ["h2", 21]] as const) await run("venue.fixture.put", { fixture: { id, name: id.toUpperCase(), manufacturer: "Test", model: "Head", mode: "4 Channel", universe: 1, address } });
  const at = (channel: number) => plugin.engine.render()[0]![channel - 1]!;
  const control = (address: number) => at(address + 3);
  const refusal = (name: string, args: unknown = {}, origin: Origin = "cli") => run(name, args, origin).then(() => "", (e: Error) => e);
  return { plugin, run, at, control, refusal, advance: (ms: number) => (now += ms) };
}

describe("Reset channel protection (built-in locked rule)", () => {
  it("finds a fixture's Reset channels, sends the middle of the « all » range, and knows where each rests", () => {
    const def = parseQxf(HEAD);
    expect(resetChannels({ def, mode: def.modes[0]! })).to.deep.equal([{ offset: 3, name: "Control", value: 227, range: "Reset (200–255)", others: [] }]);
    const lamp = parseQxf(LAMP);
    const [control, wipe] = resetChannels({ def: lamp, mode: lamp.modes[0]! });
    expect(control).to.deep.include({ name: "Control", value: 213, range: "Reset all (200–227)", others: ["Reset pan/tilt (150–199)"] });
    expect(wipe!.value).to.equal(177);
    expect(restValue(lamp.channels.get("Control")!)).to.equal(0); // its « No function »
    expect(restValue(lamp.channels.get("Wipe")!)).to.equal(undefined); // Lamp off and Reset: nowhere to rest
    expect(unprotectable({ def: lamp, mode: lamp.modes[0]! })).to.deep.equal(["Wipe"]);
  });

  it("holds a Reset channel at rest against a look, a fader, a rule and the console, and dmx.explain names it", async () => {
    const { run, control } = await setup();
    await run("venue.canvas.put", { canvas: { id: "c", name: "C", cells: 1 } });
    await run("look.put", { look: { id: "raw", name: "Raw", canvas: "c", technique: { kind: "aucune" }, timing: { every: { beats: 1 }, attack: 0, order: "loop", entryFade: 0 }, channels: { targets: [{ fixture: "h1", offset: 3 }], steps: [[230]] } } });
    await run("look.go", { id: "raw" });
    expect(control(1)).to.equal(0); // the look: back to rest, not to the top of « No function »
    await run("look.stop", { id: "raw" });
    await run("fader.put", { fader: { id: "f", name: "F", channels: [{ fixture: "h1", offset: 3 }], level: 1 } });
    expect(control(1)).to.equal(0); // a fader at full
    await run("fader.delete", { id: "f" });
    await run("rule.put", { rule: { id: "plancher", name: "Plancher", level: "show", target: { channel: "Control" }, min: 220 } });
    expect(control(1)).to.equal(0); // a rule's floor inside the Reset range
    await run("rule.delete", { id: "plancher" });
    await run("dmx.set", { universe: 1, channel: 4, value: 120 });
    expect(control(1)).to.equal(120); // a value outside the Reset range is the console's to force
    await run("dmx.set", { universe: 1, channel: 4, value: 250 });
    expect(control(1)).to.equal(0); // forced into the Reset range: what the show sends there
    const why = (await run("dmx.explain", { universe: 1, channel: 4 })) as { parked?: number; clamps: { rule: string; name?: string }[]; resettable?: boolean; reset?: { channels: { range: string }[] } };
    expect(why.parked).to.equal(250);
    expect(why.clamps.find((c) => c.rule === RESET_RULE_ID)!.name).to.equal("Protection du canal Reset");
    expect(why.resettable).to.equal(true);
    expect(why.reset!.channels.map((c) => c.range)).to.deep.equal(["Reset (200–255)"]);
  });

  it("never pushes a channel into another maintenance range: Lamp off and Lamp on stay out of reach", async () => {
    const { run, at } = await setup();
    await run("venue.fixture.put", { fixture: { id: "lamp", name: "Lamp", manufacturer: "Test", model: "Lamp", mode: "3 Channel", universe: 1, address: 41 } });
    for (const value of [170, 199, 210]) {
      await run("dmx.set", { universe: 1, channel: 42, value });
      expect(at(42), String(value)).to.equal(0); // not 149 (Lamp off) nor 228 (Lamp on): its rest
    }
    await run("venue.canvas.put", { canvas: { id: "c", name: "C", cells: 1 } });
    await run("look.put", { look: { id: "raw", name: "Raw", canvas: "c", technique: { kind: "aucune" }, timing: { every: { beats: 1 }, attack: 0, order: "loop", entryFade: 0 }, channels: { targets: [{ fixture: "lamp", offset: 1 }], steps: [[60]] } } });
    await run("look.go", { id: "raw" });
    await run("dmx.set", { universe: 1, channel: 42, value: 170 });
    expect(at(42)).to.equal(60); // what the show sends there, without the console's forbidden write
    await run("look.stop", { id: "raw" });
    await run("dmx.set", { universe: 1, channel: 42, value: 120 });
    expect(at(42)).to.equal(120); // Lamp off on purpose: only a reset is forbidden
    // a venue's locked « max » landing in a Reset range: the protection comes after it
    await run("dmx.release", {});
    await run("rule.put", { where: "venue", rule: { id: "plafond", name: "Plafond", level: "venue", target: { channel: "Control" }, max: 199, locked: true } });
    await run("dmx.set", { universe: 1, channel: 42, value: 250 });
    expect(at(42)).to.equal(0);
    // a channel of Lamp off and Reset only cannot rest: left as it is (never pushed into Lamp off), and show.lint says so
    await run("dmx.set", { universe: 1, channel: 43, value: 90 });
    expect(at(43)).to.equal(90);
    await run("dmx.set", { universe: 1, channel: 43, value: 150 });
    expect(at(43)).to.equal(0); // back to what the show sends there (0, where it sits from power-on), never to a nearest value
    const lint = (await run("show.lint")) as { issues: { level: string; message: string }[] };
    expect(lint.issues.find((i) => i.message.includes("Wipe"))).to.deep.include({ level: "attention" });
    expect(lint.issues.find((i) => i.message.includes("Wipe"))!.message).to.contain("ne peut pas le tenir au repos");
  });

  it("is listed by rule.list, can be neither replaced nor deleted, and a stored rule with its id can be deleted", async () => {
    const { run, refusal, plugin } = await setup();
    const list = (await run("rule.list")) as { builtin: { id: string; locked: boolean }[]; venue: unknown[] };
    expect(list.builtin.map((r) => [r.id, r.locked])).to.deep.equal([[RESET_RULE_ID, true]]);
    expect(list.venue).to.deep.equal([]); // not seeded into the venue's files
    expect(((await refusal("rule.delete", { where: "venue", id: RESET_RULE_ID })) as Error).message).to.contain("intégrée");
    expect(((await refusal("rule.put", { where: "venue", rule: { id: RESET_RULE_ID, name: "x", target: {} } })) as Error).message).to.contain("intégrée");
    // saved before the id was reserved: it does nothing (the engine's wins) and can still go
    plugin.runtime.venueRules.put({ id: RESET_RULE_ID, name: "old", level: "venue", scope: {}, target: {}, locked: false, onViolation: "clamp" });
    expect(await run("rule.delete", { where: "venue", id: RESET_RULE_ID })).to.deep.equal({ deleted: true });
  });

  it("lets fixture.reset through on its channels, twins included, for its window, then protects again", async () => {
    const { run, control, advance } = await setup();
    await run("venue.fixture.put", { fixture: { id: "twin", name: "Twin", manufacturer: "Test", model: "Head", mode: "4 Channel", universe: 1, address: 1 } });
    await run("dmx.set", { universe: 1, channel: 24, value: 250 }); // h2 forced into its Reset range: held
    const done = (await run("fixture.reset", { id: "h1" })) as { channels: { value: number }[]; seconds: number; warning?: string };
    expect(done.channels.map((c) => c.value)).to.deep.equal([227]);
    expect(done.seconds).to.equal(RESET_WINDOW_MS / 1000);
    expect(done.warning).to.equal(undefined);
    expect(control(1)).to.equal(227); // the middle of its Reset range, though its twin shares the channel
    expect(control(21)).to.equal(0); // the other head stays protected
    const log = (await run("activity.list")) as { name: string; target?: string }[];
    expect(log.find((e) => e.name === "fixture.reset")).to.deep.include({ target: "h1" }); // traced like any command
    const why = (await run("dmx.explain", { universe: 1, channel: 24 })) as { reset?: { secondsLeft?: number } };
    expect(why.reset!.secondsLeft).to.equal(undefined); // h2 is not resetting
    expect(((await run("dmx.explain", { universe: 1, channel: 4 })) as { reset?: { secondsLeft?: number } }).reset!.secondsLeft).to.equal(5);
    advance(RESET_WINDOW_MS - 1);
    expect(control(1)).to.equal(227);
    advance(1);
    expect(control(1)).to.equal(0); // window closed: back to what the show writes
    await run("dmx.set", { universe: 1, channel: 4, value: 250 });
    expect(control(1)).to.equal(0); // and protected again
    expect(((await run("fixture.reset", { id: "nope" }).catch((e: Error) => e)) as Error).message).to.contain("nope");
  });

  it("is accepted only where someone can confirm, and asks an AI client for confirm: true", async () => {
    const { run, refusal, control } = await setup();
    expect(RESET_ORIGINS).to.deep.equal(["ui", "mcp", "cli"]);
    for (const origin of ["midi", "osc", "os2l", "timeline"] as const) {
      const e = (await refusal("fixture.reset", { id: "h1" }, origin)) as Error;
      expect(e.message, origin).to.contain(`refusée depuis ${origin}`);
    }
    const asked = (await refusal("fixture.reset", { id: "h1" }, "mcp")) as CommandError;
    expect(asked.message).to.contain("Reset (200–255)").and.to.contain("confirm: true");
    expect(asked.detail).to.deep.equal({ confirm: true });
    expect(control(1)).to.equal(0); // nothing sent
    await run("fixture.reset", { id: "h1", confirm: true }, "mcp");
    expect(control(1)).to.equal(227);
  });

  it("says when nothing would go out: Blackout, standby, another locked rule; Panic stops a reset", async () => {
    const { run, refusal, control } = await setup();
    await run("blackout", { on: true });
    expect(((await refusal("fixture.reset", { id: "h1" })) as Error).message).to.contain("Blackout");
    await run("blackout", { on: false });
    await run("rule.put", { where: "venue", rule: { id: "plafond", name: "Plafond du lieu", level: "venue", target: { channel: "Control" }, max: 199, locked: true } });
    const blocked = (await refusal("fixture.reset", { id: "h1" })) as Error;
    expect(blocked.message).to.contain("non envoyée").and.to.contain("Plafond du lieu");
    expect(control(1)).to.equal(0); // the window was given up
    await run("rule.delete", { where: "venue", id: "plafond" });
    await run("fixture.reset", { id: "h1" });
    expect(control(1)).to.equal(227);
    await run("panic");
    expect(control(1)).to.equal(0); // the Panic gave the channel back to rest
    const standby = await setup({ standby: true });
    expect(((await standby.refusal("fixture.reset", { id: "h1" })) as Error).message).to.contain("veille");
  });

  it("never triggers what sits at 0: a Reset range holding 0 goes back to 0, and a neutral range under a Reset preset is no reset", () => {
    // « 0 No effect [ResetAll] / 1–10 Sound control »: the preset alone does not make it a reset
    const sound = oneChannel([[0, 0, "No Effect", "ResetAll"], [1, 10, "Sound Control"], [11, 255, "Auto"]]);
    expect(sound.ch.tags).to.not.include("reset");
    expect(resetChannels(sound)).to.deep.equal([]);
    expect(sound.hold(0, 0)).to.deep.equal([0, 0]); // never pushed to 1 (Sound control)
    // « 0–10 Reset to display fan setting / 11–20 Fans off »: a reset by its name, but at power-on
    const fan = oneChannel([[0, 10, "Reset to display fan setting"], [11, 20, "Fans Off"], [21, 255, "Fan speed"]]);
    expect(fan.ch.tags).to.include("reset");
    expect(fan.hold(0, 5, 0)).to.deep.equal([0, 0, 0]); // back to 0, its power-on value: never pushed to 11 (Fans off)
    expect(fan.hold(30, 5)).to.deep.equal([30, 0]); // not to the remembered 30 either: 0 stays in the same range
    expect(powerOnResets(fan)).to.deep.equal([{ channel: "Ctl", range: "Reset to display fan setting (0–10)" }]);
    expect(unprotectable(fan)).to.deep.equal([]);
    // the preset alone, under a name saying nothing, a speed, or « No resetting »
    expect(capabilityTags("Nothing", "ResetAll")).to.not.include("reset");
    expect(capabilityTags("", "ResetAll")).to.not.include("reset");
    expect(capabilityTags("No function", "ResetAll")).to.not.include("reset");
    expect(capabilityTags("Motor running speed (Slow to fast)", "ResetEffects")).to.not.include("reset");
    expect(capabilityTags("No resetting")).to.not.include("reset");
    expect(capabilityTags("XY motor resetting")).to.include("reset");
    expect(capabilityTags("Resets the gobo wheel")).to.include("reset");
    expect(capabilityTags("Home Color system", "ResetColor")).to.include("reset"); // a preset under a name that says something
  });

  it("brings a value written in a Reset range holding 0 back to 0, and fixture.reset still sends it", async () => {
    const whole = oneChannel([[0, 255, "Reset"]]);
    expect(whole.hold(255, 0, 128)).to.deep.equal([0, 0, 0]);
    expect(unprotectable(whole)).to.deep.equal([]);
    expect(resetChannels(whole)[0]).to.deep.include({ value: 127, range: "Reset (0–255)" });
    const motors = oneChannel([[0, 249, "Reset all motors"], [250, 255, "No function"]]);
    expect(motors.hold(200, 252, 100)).to.deep.equal([0, 252, 0]);
    // a wheel whose white range resets the fixture when 5, 6 or 7 is held 5 s
    const wheel = oneChannel([[0, 16, "White (5,6,7 held 5 s = reset)"], [17, 33, "Red"], [34, 255, "Rainbow"]]);
    expect(wheel.ch.tags).to.include("reset");
    expect(wheel.hold(6, 20, 6)).to.deep.equal([0, 20, 0]);
    expect(powerOnResets(wheel)).to.deep.equal([{ channel: "Ctl", range: "White (5,6,7 held 5 s = reset) (0–16)" }]);
    expect(powerOnResets(oneChannel([[0, 0, "Reset"], [1, 255, "Nothing"]]))).to.deep.equal([]); // 0–0: nothing to hold
    // the voluntary reset lifts the protection on such a channel too
    const { run, at } = await setup();
    const whole255 = `<?xml version="1.0" encoding="UTF-8"?><FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition"><Manufacturer>Test</Manufacturer><Model>Whole</Model><Type>Moving Head</Type><Channel Name="Ctl"><Group Byte="0">Maintenance</Group><Capability Min="0" Max="255">Reset</Capability></Channel><Mode Name="1"><Channel Number="0">Ctl</Channel></Mode></FixtureDefinition>`;
    await run("fixture.definition.add", { name: "whole.qxf", xml: whole255 });
    await run("venue.fixture.put", { fixture: { id: "w", name: "W", manufacturer: "Test", model: "Whole", mode: "1", universe: 1, address: 100 } });
    await run("dmx.set", { universe: 1, channel: 100, value: 255 });
    expect(at(100)).to.equal(0);
    await run("fixture.reset", { id: "w" });
    expect(at(100)).to.equal(127);
  });

  it("takes a Reset preset for a reset only when the name says so, and a setting switched off for none", () => {
    expect(capabilityTags("Enable blackout while pan/tilt move", "ResetAll")).to.not.include("reset");
    expect(capabilityTags("Shutdown", "ResetAll")).to.not.include("reset");
    expect(capabilityTags("Adjust motor", "ResetAll")).to.not.include("reset");
    expect(capabilityTags("Resetall", "ResetAll")).to.include("reset");
    expect(capabilityTags("Pan and tilt home", "ResetPanTilt")).to.include("reset");
    expect(capabilityTags("Machine Restoration", "ResetAll")).to.include("reset");
    expect(capabilityTags("Pan/Tilt", "ResetPanTilt")).to.include("reset");
    expect(capabilityTags("All", "ResetAll")).to.include("reset");
    expect(capabilityTags("Tilt reset off")).to.not.include("reset");
    expect(capabilityTags("Reset P/T Fade Off")).to.not.include("reset");
    expect(capabilityTags("Reset LED Fade On")).to.not.include("reset");
    expect(capabilityTags("Reset / Lamp Off")).to.include("reset");
  });

  it("finds the neutral rest under a Reset preset that is no reset", () => {
    // « No effect [ResetAll] » is no reset: the channel rests there, not on « Sound control »
    const ch = oneChannel([[0, 9, "Sound control"], [10, 19, "No function", "ResetAll"], [20, 29, "Reset"], [30, 255, "Auto"]]);
    expect(restValue(ch.ch)).to.equal(10);
    expect(ch.hold(25)).to.deep.equal([10]);
  });

  it("goes back to the last value outside its Reset ranges, a lamp range included, and never into Lamp off", () => {
    const lamp = oneChannel([[0, 127, "Lamp ON"], [128, 191, "Reset"], [192, 255, "Lamp OFF"]]);
    expect(lamp.hold(0, 170)).to.deep.equal([0, 170 - 170]); // the show's 0 (Lamp on), remembered
    expect(lamp.hold(200, 170)).to.deep.equal([200, 200]); // Lamp off written on purpose stays: the reset goes back to it
    expect(lamp.hold(170)).to.deep.equal([127]); // no memory: the nearest Lamp on, not 192 (Lamp off)
    expect(lamp.hold(190)).to.deep.equal([127]);
    expect(unprotectable(lamp)).to.deep.equal([]); // it has somewhere to go
  });

  it("sends the range named as a reset of everything, else a ResetAll named reset, else the first named reset", () => {
    const byName = (ranges: [number, number, string, string?][]) => resetChannels(oneChannel(ranges))[0]?.range;
    // « 0–254 No function [ResetAll] / 255 Reset »: never the « No function » range
    expect(byName([[0, 254, "No function", "ResetAll"], [255, 255, "Reset"]])).to.equal("Reset (255–255)");
    const blackout: [number, number, string, string?] = [10, 19, "Enable blackout while pan/tilt move", "ResetAll"];
    expect(byName([[0, 9, "No function"], blackout, [20, 29, "Reset pan", "ResetPan"], [30, 39, "Complete reset"]])).to.equal("Complete reset (30–39)");
    expect(byName([[0, 9, "No function"], blackout, [20, 29, "Reset pan", "ResetPan"], [30, 39, "Reset", "ResetAll"]])).to.equal("Reset (30–39)");
    expect(byName([[0, 9, "No function"], blackout, [20, 29, "XY motor resetting"]])).to.equal("XY motor resetting (20–29)");
    expect(byName([[0, 9, "No function"], blackout])).to.equal(undefined); // its preset alone makes no reset
    expect(byName([[0, 9, "No function"], [10, 19, "Pan/Tilt", "ResetPanTilt"]])).to.equal("Pan/Tilt (10–19)"); // nothing named reset: the first
  });

  it("holds after every fixture's rules: a fixture sharing the slot cannot write the reset after the protection", async () => {
    const { run, control } = await setup();
    // the lamp's Pan lands on h1's Control (DMX 4); its rule raises it into h1's Reset range
    await run("venue.fixture.put", { fixture: { id: "lamp", name: "Lamp", manufacturer: "Test", model: "Lamp", mode: "3 Channel", universe: 1, address: 4 } });
    await run("rule.put", { rule: { id: "pan-haut", name: "Pan haut", level: "show", target: { channel: "Pan" }, min: 220 } });
    expect(control(1)).to.equal(0);
  });

  it("is not prolonged nor kept from going out by a steady rule on the Reset channel", async () => {
    const { run, control, advance } = await setup();
    await run("rule.put", { rule: { id: "lent", name: "Lent", level: "show", target: { channel: "Control" }, steadySeconds: 15 } });
    expect(control(1)).to.equal(0);
    await run("fixture.reset", { id: "h1" });
    expect(control(1)).to.equal(227); // at once, not 15 s later
    advance(RESET_WINDOW_MS);
    expect(control(1)).to.equal(0); // and over with its window, not 15 s more
  });

  it("refuses a Blackout before asking an AI client, and names a Reset channel past 512", async () => {
    const { run, refusal } = await setup();
    await run("blackout", { on: true });
    const e = (await refusal("fixture.reset", { id: "h1" }, "mcp")) as Error;
    expect(e.message).to.contain("Blackout").and.not.to.contain("confirm: true"); // no yes asked for nothing
    await run("blackout", { on: false });
    await run("venue.fixture.put", { fixture: { id: "late", name: "Late", manufacturer: "Test", model: "Head", mode: "4 Channel", universe: 1, address: 510 } });
    const beyond = (await refusal("fixture.reset", { id: "late" })) as Error;
    expect(beyond.message).to.contain("Control est au-delà du canal 512").and.not.to.contain("reste à 0");
  });

  it("warns in show.lint of a Reset range holding 0 and more", async () => {
    const { run, plugin } = await setup();
    const fan = `<?xml version="1.0" encoding="UTF-8"?><FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition"><Manufacturer>Test</Manufacturer><Model>Fan</Model><Type>Moving Head</Type><Channel Name="Fan"><Group Byte="0">Maintenance</Group><Capability Min="0" Max="10">Reset to display fan setting</Capability><Capability Min="11" Max="255">Fans Off</Capability></Channel><Mode Name="1"><Channel Number="0">Fan</Channel></Mode></FixtureDefinition>`;
    await run("fixture.definition.add", { name: "fan.qxf", xml: fan });
    await run("venue.fixture.put", { fixture: { id: "fan", name: "Fan", manufacturer: "Test", model: "Fan", mode: "1", universe: 1, address: 100 } });
    expect(plugin.engine.render()[0]![99]).to.equal(0);
    const lint = (await run("show.lint")) as { issues: { level: string; message: string }[] };
    const note = lint.issues.find((i) => i.message.includes("Reset to display fan setting (0–10)"));
    expect(note).to.deep.include({ level: "attention" });
    expect(note!.message).to.contain("commence à 0").and.to.contain("ramène à 0");
  });
});
