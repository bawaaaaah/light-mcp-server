import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { MappingSchema, MidiMapper, type Mapping } from "../../../src/plugins/light/midi/mapping.js";
import { parseMidi } from "../../../src/plugins/light/midi/parse.js";

/**
 * A pitch bend to a button action plays by edges (docs/specs/midi.md, « Pitch bend »; decisions of 2026-11-17): one
 * action per push above the threshold, one release back at it; by input port; a transport restart rearms the wheel.
 */
describe("pitch bend to a button: one action per push", () => {
  const KEYS = "Clavier";
  const LIVE = "IAC Live";
  const mapper = (mode: Mapping["mode"]): MidiMapper => {
    const m = new MidiMapper();
    m.setMappings([MappingSchema.parse({ id: "bend", input: { type: "pitchbend", channel: 1, number: 0 }, mode, threshold: 64, on: { command: "look.go", args: { id: "hole" } }, off: { command: "look.stop", args: { id: "hole" } } })]);
    return m;
  };
  /** The commands a wheel's top 7 bits give, one value after the other. */
  const play = (m: MidiMapper, values: number[], port = KEYS): string[] => values.flatMap((v) => m.handle(parseMidi([0xe0, 0, v]), port).calls.map((c) => c.command));

  it("a push sending 65, 70, 90, 127 then back to 64: one action, one release", () => {
    for (const mode of ["trigger", "latch", "momentary"] as const) expect(play(mapper(mode), [65, 70, 90, 127, 64]), mode).to.deep.equal(["look.go", "look.stop"]);
  });

  it("toggle: two pushes, two switches", () => {
    expect(play(mapper("toggle"), [65, 90, 127, 64, 30, 80, 127, 64])).to.deep.equal(["look.go", "look.stop"]);
  });

  it("a jump from 20 to 100 is one push", () => {
    expect(play(mapper("momentary"), [20, 100])).to.deep.equal(["look.go"]);
  });

  it("127 repeated three times (Live's chase) fires once", () => {
    expect(play(mapper("trigger"), [127, 127, 127])).to.deep.equal(["look.go"]);
  });

  it("two ports on one channel stay apart: the keyboard at rest does not release Live's push", () => {
    const m = mapper("momentary");
    expect(play(m, [127], LIVE)).to.deep.equal(["look.go"]);
    expect(play(m, [64], KEYS)).to.deep.equal([]); // the keyboard's wheel was never pushed
    expect(play(m, [127], LIVE)).to.deep.equal([]); // still pushed on Live's port
    expect(play(m, [64], LIVE)).to.deep.equal(["look.stop"]);
  });

  it("a Start, then 127: fires again, with no release at the rearm", () => {
    const m = mapper("trigger");
    expect(play(m, [127], LIVE)).to.deep.equal(["look.go"]);
    expect(m.handle(parseMidi([0xfa]), LIVE).calls).to.deep.equal([]); // no release
    expect(play(m, [127], LIVE)).to.deep.equal(["look.go"]);
  });

  it("a Song Position Pointer, then 127: fires again; a Continue too", () => {
    const m = mapper("trigger");
    play(m, [127], LIVE);
    expect(m.handle(parseMidi([0xf2, 0x10, 0x00]), LIVE).calls).to.deep.equal([]);
    expect(play(m, [127], LIVE)).to.deep.equal(["look.go"]);
    expect(m.handle(parseMidi([0xfb]), LIVE).calls).to.deep.equal([]);
    expect(play(m, [127], LIVE)).to.deep.equal(["look.go"]);
  });

  it("a rearm is by port: the keyboard's push stays", () => {
    const m = mapper("trigger");
    play(m, [127], KEYS);
    m.handle(parseMidi([0xfa]), LIVE);
    expect(play(m, [127], KEYS)).to.deep.equal([]);
  });

  it("a port gone forgets its wheels; the profile changed, every port's", () => {
    const m = mapper("trigger");
    play(m, [127], LIVE);
    play(m, [127], KEYS);
    m.forgetPort(LIVE);
    expect(play(m, [127], LIVE)).to.deep.equal(["look.go"]);
    expect(play(m, [127], KEYS)).to.deep.equal([]);
    m.forgetPort();
    expect(play(m, [127], KEYS)).to.deep.equal(["look.go"]);
  });

  it("a CC is unchanged: every value above the threshold answers in trigger", () => {
    const m = new MidiMapper();
    m.setMappings([MappingSchema.parse({ id: "cc", input: { type: "cc", channel: 1, number: 7 }, mode: "trigger", threshold: 64, on: { command: "look.go", args: { id: "hole" } } })]);
    expect([127, 127].flatMap((v) => m.handle(parseMidi([0xb0, 7, v])).calls.map((c) => c.command))).to.deep.equal(["look.go", "look.go"]);
  });

  it("a wheel to a level action still follows the wheel", () => {
    const m = new MidiMapper();
    m.setMappings([MappingSchema.parse({ id: "lvl", input: { type: "pitchbend", channel: 1, number: 0 }, mode: "latch", threshold: 0, scale: { inMin: 64 }, on: { command: "group.level", args: { id: "front" } }, levelArg: "level" })]);
    const levels = [64, 96, 127].map((v) => m.handle(parseMidi([0xe0, 0, v])).calls.map((c) => c.args.level));
    expect(levels).to.deep.equal([[0], [0.508], [1]]);
  });
});

describe("pitch bend rearmed through the plugin: a Start from Live fires the wheel again", () => {
  it("a wheel held up does nothing more; after a Start on its port, the next value starts the look again", async function () {
    this.timeout(10_000);
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-bend-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, os2l: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    await run("midi.mapping.put", { mapping: { id: "bend", input: { type: "pitchbend", channel: 1, number: 0 }, mode: "trigger", threshold: 64, on: { command: "look.go", args: { id: "hole" } } } });
    const active = async () => ((await run("look.list")) as { id: string; active: boolean }[]).find((l) => l.id === "hole")?.active;
    const until = async (want: boolean) => {
      for (let i = 0; i < 50 && (await active()) !== want; i++) await new Promise((r) => setTimeout(r, 10));
      return active();
    };
    const port = "Web MIDI · Live";
    await run("midi.in", { port, bytes: [0xe0, 0, 127] });
    expect(await until(true)).to.equal(true);
    await run("look.stopall");
    expect(await until(false)).to.equal(false);
    await run("midi.in", { port, bytes: [0xe0, 0, 127] }); // the chase: nothing new
    await new Promise((r) => setTimeout(r, 50));
    expect(await active()).to.equal(false);
    await run("midi.in", { port, bytes: [0xfa] }); // Live's Start
    await run("midi.in", { port, bytes: [0xe0, 0, 127] });
    expect(await until(true)).to.equal(true);
  });
});
