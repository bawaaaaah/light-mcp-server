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

  it("rearmed, then a value at or under the threshold: what was held is released (momentary, latch)", () => {
    for (const mode of ["momentary", "latch"] as const) {
      const m = mapper(mode);
      expect(play(m, [127], LIVE), mode).to.deep.equal(["look.go"]);
      m.handle(parseMidi([0xf2, 0, 0]), LIVE); // Live's locate
      expect(play(m, [0], LIVE), mode).to.deep.equal(["look.stop"]); // the automation back at 0: never left on
      expect(play(m, [0], LIVE), mode).to.deep.equal([]);
    }
  });

  it("a toggle rearmed then at rest keeps its state; its next push switches it", () => {
    const m = mapper("toggle");
    expect(play(m, [127], LIVE)).to.deep.equal(["look.go"]);
    m.handle(parseMidi([0xfa]), LIVE);
    expect(play(m, [0, 127], LIVE)).to.deep.equal(["look.stop"]);
  });

  it("two ports holding one mapping: released once neither pushes it", () => {
    const m = mapper("momentary");
    expect(play(m, [127], LIVE)).to.deep.equal(["look.go"]);
    expect(play(m, [127], KEYS)).to.deep.equal([]); // already on
    expect(play(m, [64], LIVE)).to.deep.equal([]); // the keyboard still holds it
    expect(play(m, [64], KEYS)).to.deep.equal(["look.stop"]);
  });

  it("a port gone: what only it held is released when asked, kept otherwise; the next push is new", () => {
    const released: string[] = [];
    const m = mapper("momentary");
    m.onRelease = (out) => released.push(...out.calls.map((c) => c.command));
    play(m, [127], LIVE);
    play(m, [127], KEYS);
    m.forgetPort(LIVE, true);
    expect(released).to.deep.equal([]); // the keyboard still holds it
    m.forgetPort(KEYS, true);
    expect(released).to.deep.equal(["look.stop"]);
    expect(play(m, [127], KEYS)).to.deep.equal(["look.go"]);
    m.forgetPort(KEYS, false); // « keep »: left on, forgotten
    expect(released).to.deep.equal(["look.stop"]);
    expect(play(m, [64], KEYS)).to.deep.equal([]);
  });

  it("« keep », a button without off: the push after the input comes back fires again", () => {
    const m = new MidiMapper();
    m.setMappings([MappingSchema.parse({ id: "bend", input: { type: "pitchbend", channel: 1, number: 0 }, mode: "momentary", threshold: 64, on: { command: "look.go", args: { id: "hole" } } })]);
    expect(play(m, [127], LIVE)).to.deep.equal(["look.go"]);
    m.forgetPort(LIVE, false); // kept: nothing released, still « on » here
    expect(play(m, [127], LIVE)).to.deep.equal(["look.go"]); // no other port holds it: a new push
  });

  it("two browsers relaying one « Web MIDI · Pad » stay apart; one closing lets go of its own push only", () => {
    const PAD = "Web MIDI · Pad";
    const released: string[] = [];
    const m = mapper("momentary");
    m.onRelease = (out) => released.push(...out.calls.map((c) => c.command));
    const bend = (v: number, client: string) => m.handle(parseMidi([0xe0, 0, v]), PAD, client).calls.map((c) => c.command);
    expect(bend(127, "tab-a")).to.deep.equal(["look.go"]);
    expect(bend(64, "tab-b")).to.deep.equal([]); // the other browser's wheel at rest: never pushed there
    expect(bend(127, "tab-b")).to.deep.equal([]);
    m.forgetPort(PAD, true, "tab-b"); // its page left: its own input only
    expect(released).to.deep.equal([]);
    m.forgetClient("tab-a", true); // the first tab closed
    expect(released).to.deep.equal(["look.stop"]);
    expect(bend(127, "tab-c")).to.deep.equal(["look.go"]); // reopened: no hold left behind, the mapping answers
  });

  it("back at rest, an action released elsewhere then started by hand stays on", () => {
    const m = mapper("momentary");
    play(m, [127], LIVE);
    m.syncState("bend", false);
    m.syncState("bend", true);
    expect(play(m, [64], LIVE)).to.deep.equal([]);
  });

  it("an action released elsewhere then started by hand is not the wheel's to release", () => {
    const released: string[] = [];
    const m = mapper("momentary");
    m.onRelease = (out) => released.push(...out.calls.map((c) => c.command));
    play(m, [127], LIVE);
    m.syncState("bend", false); // stopped from the interface
    m.syncState("bend", true); // started again by hand
    m.forgetPort(LIVE, true);
    expect(released).to.deep.equal([]);
  });

  it("a toggle held, a Start, the value sent back up: its state switches (each Play or jump with the wheel up)", () => {
    const m = mapper("toggle");
    expect(play(m, [127], LIVE)).to.deep.equal(["look.go"]);
    m.handle(parseMidi([0xfa]), LIVE);
    expect(play(m, [127], LIVE)).to.deep.equal(["look.stop"]);
    m.handle(parseMidi([0xf2, 0, 0]), LIVE);
    expect(play(m, [127], LIVE)).to.deep.equal(["look.go"]);
  });

  it("a mapping removed, or changed under the same id, releases what its wheel held and forgets it", () => {
    const base = { id: "bend", input: { type: "pitchbend" as const, channel: 1, number: 0 }, mode: "momentary" as const, threshold: 64, on: { command: "look.go", args: { id: "hole" } }, off: { command: "look.stop", args: { id: "hole" } } };
    for (const next of [[], [{ ...base, input: { ...base.input, channel: 2 } }], [{ ...base, input: { ...base.input, type: "cc" as const, number: 7 } }], [{ ...base, levelArg: "level" }], [{ ...base, on: { command: "look.go", args: { id: "other" } } }]]) {
      const gone: string[] = [];
      const changed = mapper("momentary");
      changed.onRelease = (out) => gone.push(...out.calls.map((c) => c.command));
      play(changed, [127], LIVE);
      changed.setMappings(next.map((x) => MappingSchema.parse(x)));
      expect(gone, JSON.stringify(next)).to.deep.equal(["look.stop"]);
    }
    // its label only changed: the hold stays
    const released: string[] = [];
    const m = mapper("momentary");
    m.onRelease = (out) => released.push(...out.calls.map((c) => c.command));
    play(m, [127], LIVE);
    m.setMappings([MappingSchema.parse({ ...base, label: "Molette" })]);
    expect(released).to.deep.equal([]);
    expect(play(m, [64], LIVE)).to.deep.equal(["look.stop"]);
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

/** A plugin without native MIDI, the synthetic show loaded, and a wheel mapped to the « hole » look. */
async function wheelPlugin(mode: Mapping["mode"], midi: object = {}) {
  const dataRoot = join(mkdtempSync(join(tmpdir(), "light-bend-")), "data");
  mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
  copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
  const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, os2l: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } }, y: { inputs: [], rtp: { enabled: false } } }, ...midi } };
  const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  /** A call made over a browser's live connection (REST over the WebSocket: the transport names it). */
  const over = (connection: string) => (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, { ...systemContext(), connection });
  await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
  await run("midi.mapping.put", { mapping: { id: "bend", input: { type: "pitchbend", channel: 1, number: 0 }, mode, threshold: 64, on: { command: "look.go", args: { id: "hole" } }, off: { command: "look.stop", args: { id: "hole" } } } });
  const active = async () => ((await run("look.list")) as { id: string; active: boolean }[]).find((l) => l.id === "hole")?.active;
  const until = async (want: boolean) => {
    for (let i = 0; i < 50 && (await active()) !== want; i++) await new Promise((r) => setTimeout(r, 10));
    return active();
  };
  return { run, over, active, until, plugin };
}

describe("pitch bend through the plugin", () => {
  const port = "Web MIDI · Live";
  for (const [name, bytes] of [["Start", [0xfa]], ["Continue", [0xfb]], ["Song Position Pointer", [0xf2, 0x10, 0x00]]] as const) {
    it(`a wheel held up does nothing more; after a ${name} on its port, the next value starts the look again`, async function () {
      this.timeout(10_000);
      const { run, active, until } = await wheelPlugin("trigger");
      await run("midi.in", { port, bytes: [0xe0, 0, 127] });
      expect(await until(true)).to.equal(true);
      await run("look.stopall");
      expect(await until(false)).to.equal(false);
      await run("midi.in", { port, bytes: [0xe0, 0, 127] }); // the chase: nothing new
      await new Promise((r) => setTimeout(r, 50));
      expect(await active()).to.equal(false);
      await run("midi.in", { port, bytes: [...bytes] });
      await run("midi.in", { port, bytes: [0xe0, 0, 127] });
      expect(await until(true)).to.equal(true);
    });
  }

  it("midi.profile.select lets go only what the inputs it closes held, and journals why", async function () {
    this.timeout(10_000);
    const { run, active, until, plugin } = await wheelPlugin("momentary");
    await run("midi.in", { port, bytes: [0xe0, 0, 127] });
    expect(await until(true)).to.equal(true);
    await run("midi.profile.select", { name: "y" }); // the browser's input stays open: it keeps its push
    await new Promise((r) => setTimeout(r, 50));
    expect(await active()).to.equal(true);
    // a profile that closes the input (as the hub says of a port it no longer watches): released, the cause journalled
    const setConfig = plugin.hub.setConfig.bind(plugin.hub);
    plugin.hub.setConfig = async (c) => {
      plugin.hub.closeInput(port, "web");
      await setConfig(c);
    };
    await run("midi.profile.select", { name: "x" });
    expect(await until(false)).to.equal(false);
    const journal = (await run("midi.journal")) as { port: string; msg: { type: string; cause?: string }; matched: { id: string }[] }[];
    expect(journal[0]).to.deep.include({ port, msg: { type: "release", cause: "profile" }, matched: [{ id: "bend", label: "", mode: "momentary" }] });
  });

  it("refuses to close a port that is not a browser's", async function () {
    this.timeout(10_000);
    const { run } = await wheelPlugin("momentary");
    await run("midi.web.closed", { port: "IAC Live" }).then(
      () => expect.fail("a local port"),
      (e: Error) => expect(e.message).to.match(/Web MIDI/),
    );
  });

  it("a tab closed with its wheel pushed: released (by default), and the mapping answers its reopening", async function () {
    this.timeout(10_000);
    const { over, until, plugin } = await wheelPlugin("momentary");
    const pad = "Web MIDI · Pad";
    await over("tab-a")("midi.in", { port: pad, bytes: [0xe0, 0, 127] });
    expect(await until(true)).to.equal(true);
    plugin.liveConnectionClosed("tab-a");
    expect(await until(false)).to.equal(false);
    await over("tab-b")("midi.in", { port: pad, bytes: [0xe0, 0, 127] });
    expect(await until(true)).to.equal(true);
    const journal = (await over("tab-b")("midi.journal")) as { port: string; msg: { type: string; cause?: string } }[];
    expect(journal.find((e) => e.msg.type === "release")).to.deep.include({ port: pad, msg: { type: "release", cause: "input" } });
  });

  it("a closed connection kept when the « web » setting says so; a late message on it refused", async function () {
    this.timeout(10_000);
    const { run, over, active, until, plugin } = await wheelPlugin("momentary");
    await run("midi.portloss.set", { web: "keep" });
    await over("tab-a")("midi.in", { port: "Web MIDI · Pad", bytes: [0xe0, 0, 127] });
    expect(await until(true)).to.equal(true);
    plugin.liveConnectionClosed("tab-a");
    await new Promise((r) => setTimeout(r, 50));
    expect(await active()).to.equal(true);
    await over("tab-a")("midi.in", { port: "Web MIDI · Pad", bytes: [0xe0, 0, 64] }).then(
      () => expect.fail("a closed connection"),
      (e: Error) => expect(e.message).to.match(/connexion fermée|connection closed/),
    );
  });

  it("applies a batch whole and in order (a page's 15 ms), its messages on their own ports; one message still taken alone", async function () {
    this.timeout(10_000);
    const { over, run, active, until } = await wheelPlugin("momentary");
    // push and rest of the wheel, then a push again, in one batch: in order, so the look ends on
    const r = (await over("tab-a")("midi.in", { messages: [{ port: "Web MIDI · Pad", bytes: [0xe0, 0, 127] }, { port: "Web MIDI · Pad", bytes: [0xe0, 0, 64] }, { bytes: [0x90, 40, 1] }, { port: "Web MIDI · Pad", bytes: [0xe0, 0, 127] }] })) as { applied: number };
    expect(r.applied).to.equal(4);
    expect(await until(true)).to.equal(true);
    const journal = (await run("midi.journal")) as { port: string; msg: { type: string; value?: number } }[];
    expect(journal.slice(0, 4).map((e) => `${e.port} ${e.msg.type}`).reverse()).to.deep.equal(["Web MIDI · Pad pitchbend", "Web MIDI · Pad pitchbend", "Web MIDI noteon", "Web MIDI · Pad pitchbend"]);
    await run("midi.in", { port: "Web MIDI · Pad", bytes: [0xe0, 0, 64] }); // one message, as before
    expect(await active()).to.equal(true); // plain HTTP releases nothing the tab holds
    await run("midi.in", { port: "Web MIDI · Pad", bytes: [0xe0, 0, 64], messages: [{ bytes: [0x90, 1, 1] }] }).then(
      () => expect.fail("both"),
      (e: Error) => expect(e.message).to.match(/bytes ou messages/),
    );
  });

  it("remembers the last 256 closed connections: an older one's late message is no longer refused", async function () {
    this.timeout(10_000);
    const { over, plugin } = await wheelPlugin("momentary");
    for (let i = 0; i <= 256; i++) plugin.liveConnectionClosed(`gone-${i}`);
    const late = (id: string) => over(id)("midi.in", { port: "Web MIDI · Pad", bytes: [0x90, 40, 100] }).then(() => "accepted", () => "refused");
    expect(await late("gone-0")).to.equal("accepted"); // evicted: the 257th closed pushed it out
    expect(await late("gone-1")).to.equal("refused");
    expect(await late("gone-256")).to.equal("refused");
  });

  it("a plain HTTP caller can neither release a browser's hold nor tie one to a connection", async function () {
    this.timeout(10_000);
    const { run, over, active, until, plugin } = await wheelPlugin("momentary");
    const pad = "Web MIDI · Pad";
    await over("tab-a")("midi.in", { port: pad, bytes: [0xe0, 0, 127] });
    expect(await until(true)).to.equal(true);
    // the same port name over HTTP (a script, MCP): its rest and its « closed » reach nothing the browser holds
    await run("midi.in", { port: pad, bytes: [0xe0, 0, 0], client: "tab-a" }); // a « client » argument is no identity
    await run("midi.web.closed", { port: pad, client: "tab-a" });
    await new Promise((r) => setTimeout(r, 50));
    expect(await active()).to.equal(true);
    // its own push holds nothing a browser's connection could lose: the tab's close leaves it to its own rest
    await over("tab-a")("midi.in", { port: pad, bytes: [0xe0, 0, 0] });
    expect(await until(false)).to.equal(false);
    await run("midi.in", { port: pad, bytes: [0xe0, 0, 127] });
    expect(await until(true)).to.equal(true);
    plugin.liveConnectionClosed("tab-a");
    await new Promise((r) => setTimeout(r, 50));
    expect(await active()).to.equal(true);
  });

  it("a mapping changed while its wheel holds: journalled as « mapping »", async function () {
    this.timeout(10_000);
    const { run, until } = await wheelPlugin("momentary");
    await run("midi.in", { port, bytes: [0xe0, 0, 127] });
    expect(await until(true)).to.equal(true);
    await run("midi.mapping.put", { mapping: { id: "bend", input: { type: "pitchbend", channel: 2, number: 0 }, mode: "momentary", threshold: 64, on: { command: "look.go", args: { id: "hole" } }, off: { command: "look.stop", args: { id: "hole" } } } });
    expect(await until(false)).to.equal(false);
    const journal = (await run("midi.journal")) as { port: string; source: string; msg: { type: string; cause?: string }; matched: { id: string }[] }[];
    expect(journal[0]).to.deep.include({ port, source: "web", msg: { type: "release", cause: "mapping" } });
  });

  it("the setting is read again after a restart", async function () {
    this.timeout(10_000);
    let stored: unknown = { discovery: false, output: { routes: [] }, osc: { enabled: false }, os2l: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const config = { get: () => stored, set: async (v: unknown) => void (stored = v) };
    const start = () => {
      const dataRoot = join(mkdtempSync(join(tmpdir(), "light-portloss-")), "data");
      const plugin = new LightPlugin({ eventBus: new EventBus(), config, dataRoot, midiNative: null } as never);
      return (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    };
    await start()("midi.portloss.set", { rtp: "keep" });
    expect(((await start()("midi.status")) as { portLoss: object }).portLoss).to.deep.equal({ local: "release", rtp: "keep", web: "release" });
  });

  it("a browser's Web MIDI input closed: released by default, kept when the setting says so", async function () {
    this.timeout(10_000);
    const { run, active, until } = await wheelPlugin("momentary");
    expect(((await run("midi.status")) as { portLoss: object }).portLoss).to.deep.equal({ local: "release", rtp: "release", web: "release" });
    await run("midi.in", { port, bytes: [0xe0, 0, 127] });
    expect(await until(true)).to.equal(true);
    await run("midi.web.closed", { port });
    expect(await until(false)).to.equal(false);
    expect(await run("midi.portloss.set", { web: "keep" })).to.deep.equal({ local: "release", rtp: "release", web: "keep" });
    await run("midi.in", { port, bytes: [0xe0, 0, 127] });
    expect(await until(true)).to.equal(true);
    await run("midi.web.closed", { port });
    await new Promise((r) => setTimeout(r, 50));
    expect(await active()).to.equal(true);
  });
});
