import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

describe("rule programs (per section, by MIDI Program Change)", () => {
  let plugin: LightPlugin;
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  const dimmer = () => plugin.engine.render()[0]![0];

  before(async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-programs-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    await run("venue.fixture.put", { fixture: { id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1 } });
    await run("venue.canvas.put", { canvas: { id: "mur", name: "Mur", cells: 4, render: [{ from: 0, to: 3, targets: [{ fixture: "bar", head: -1 }] }] } });
    await run("look.put", { look: { id: "a", name: "A", canvas: "mur", technique: { kind: "plat", color: "#ff0000" } } });
    await run("program.put", { program: { id: "priere", name: "Prière", programChange: 99, channel: 1 } });
    await run("rule.put", { where: "show", rule: { id: "priere-40", name: "Prière : max 40 %", target: { attribute: "intensity" }, max: 102, program: "priere" } });
    await run("look.go", { id: "a" });
  });

  it("applies a program's rules only while it is active", async () => {
    expect(dimmer()).to.equal(255);
    await run("program.select", { id: "priere" });
    expect(dimmer()).to.equal(102);
    await run("program.select", { id: null });
    expect(dimmer()).to.equal(255);
  });

  it("is selected by a MIDI Program Change on its channel (a clip « Prière #100 » in Live)", async () => {
    await run("midi.in", { port: "test", bytes: [0xc0, 99] }); // channel 1, program 99 (Live shows #100)
    expect(plugin.runtime.activeProgram).to.equal("priere");
    expect(dimmer()).to.equal(102);
    await run("midi.in", { port: "test", bytes: [0xc1, 99] }); // another channel: not ours
    expect(plugin.runtime.activeProgram).to.equal("priere");
    await run("program.select", { id: null });
  });

  it("follows the song: the prayer section activates it, a section without a program keeps it", async () => {
    await run("song.put", { song: { id: "s", title: "S", bpm: 120, sections: [{ id: "c", name: "Couplet", look: "a", bars: 4 }, { id: "p", name: "Prière", look: "a", bars: 4, program: "priere" }, { id: "f", name: "Final", look: "a", bars: 4 }] } });
    await run("song.section.go", { song: "s", section: "p" });
    expect(plugin.runtime.activeProgram).to.equal("priere");
    await run("song.section.go", { song: "s", section: "f" });
    expect(plugin.runtime.activeProgram).to.equal("priere"); // only another program (or a hand, a PC) replaces it
    await run("program.select", { id: null });
    // following playback too
    await run("song.play", { song: "s", bar: 4 });
    expect(plugin.runtime.activeProgram).to.equal("priere");
    await run("song.stop");
    await run("program.select", { id: null });
  });

  it("refuses a program number already taken, and an unknown program on a section", async () => {
    const taken = await run("program.put", { program: { id: "autre", name: "Autre", programChange: 99, channel: 1 } }).then(() => "ok", (e: Error) => e.message);
    expect(taken).to.match(/déjà pris par « Prière »/);
    const unknown = await run("song.put", { song: { id: "x", title: "X", sections: [{ id: "a", name: "A", program: "nope" }] } }).then(() => "ok", (e: Error) => e.message);
    expect(unknown).to.match(/programme inconnu nope/);
  });

  it("shows the program's rules in the effective view when asked", async () => {
    const without = (await run("rule.effective", { fixture: "bar" })) as { dmx: number; max?: number }[];
    expect(without.find((c) => c.dmx === 1)).to.equal(undefined);
    const withIt = (await run("rule.effective", { fixture: "bar", program: "priere" })) as { dmx: number; max?: number }[];
    expect(withIt.find((c) => c.dmx === 1)!.max).to.equal(102);
  });
});
