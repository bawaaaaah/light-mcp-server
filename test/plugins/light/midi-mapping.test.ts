import { expect } from "chai";
import { MidiMapper, MappingSchema, type Mapping } from "../../../src/plugins/light/midi/mapping.js";
import { NoteCollision, NoteRegistry, NoteRegistrySchema } from "../../../src/plugins/light/midi/note-registry.js";
import { parseMidi } from "../../../src/plugins/light/midi/parse.js";

const on = (n: number, v = 100) => parseMidi([0x90, n, v]);
const off = (n: number) => parseMidi([0x80, n, 0]);
const map = (m: Partial<Mapping> & Pick<Mapping, "id" | "mode">): Mapping =>
  MappingSchema.parse({ input: { type: "note", channel: 1, number: 36 }, on: { command: "section.go", args: { id: "refrain" } }, off: { command: "section.stop", args: { id: "refrain" } }, ...m });

describe("MIDI mapping modes", () => {
  it("trigger: note on always triggers, never turns off; duplicates are harmless", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([map({ id: "a", mode: "trigger" })]);
    expect(mapper.handle(on(36)).calls.map((c) => c.command)).to.deep.equal(["section.go"]);
    expect(mapper.handle(on(36)).calls.map((c) => c.command)).to.deep.equal(["section.go"]); // idempotent target
    expect(mapper.handle(off(36)).calls).to.deep.equal([]);
    expect(mapper.handle(parseMidi([0x90, 36, 0])).calls).to.deep.equal([]); // vel 0 = note off
  });

  it("latch: toggles on note on, ignores note off", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([map({ id: "a", mode: "latch" })]);
    expect(mapper.handle(on(36)).calls[0]!.command).to.equal("section.go");
    const released = mapper.handle(off(36));
    expect(released.calls).to.deep.equal([]);
    expect(released.matched).to.deep.equal([{ id: "a", label: "", mode: "latch" }]); // matched, did nothing: the monitor says so
    expect(mapper.handle(on(36)).calls[0]!.command).to.equal("section.stop");
    expect(mapper.handle(on(37)).matched).to.deep.equal([]); // no mapping
  });

  it("momentary: on while held, level = velocity, re-press updates the level, off at release", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([map({ id: "f", mode: "momentary", on: { command: "group.level", args: { id: "ambiance" } }, off: undefined, levelArg: "level" })]);
    expect(mapper.handle(on(36, 127)).calls).to.deep.equal([{ command: "group.level", args: { id: "ambiance", level: 1 } }]);
    expect(mapper.handle(on(36, 64)).calls[0]!.args.level).to.be.closeTo(0.504, 0.001);
    expect(mapper.handle(off(36)).calls).to.deep.equal([{ command: "group.level", args: { id: "ambiance", level: 0 } }]);
  });

  it("momentary button: a re-press while held does not re-trigger", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([map({ id: "fl", mode: "momentary", on: { command: "flash", args: { id: "blanc" } }, off: { command: "flash.release", args: { id: "blanc" } } })]);
    expect(mapper.handle(on(36)).calls).to.have.length(1);
    expect(mapper.handle(on(36, 50)).calls).to.have.length(0);
    expect(mapper.handle(off(36)).calls[0]!.command).to.equal("flash.release");
  });

  it("momentary can follow aftertouch while held", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([map({ id: "f", mode: "momentary", on: { command: "group.level", args: {} }, off: undefined, levelArg: "level", followAftertouch: true })]);
    mapper.handle(on(36, 100));
    expect(mapper.handle(parseMidi([0xa0, 36, 127])).calls[0]!.args.level).to.equal(1);
    expect(mapper.handle(parseMidi([0xd0, 0])).calls[0]!.args.level).to.equal(0);
  });

  it("CC drives a level with scaling and curve", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([MappingSchema.parse({ id: "cc", input: { type: "cc", channel: 1, number: 7 }, on: { command: "group.level", args: { id: "master" } }, levelArg: "level", scale: { outMax: 0.5 } })]);
    expect(mapper.handle(parseMidi([0xb0, 7, 127])).calls[0]!.args.level).to.equal(0.5);
  });

  it("CC answers only above the threshold, and releases below it (trigger)", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([MappingSchema.parse({ id: "cc", input: { type: "cc", channel: 1, number: 7 }, mode: "trigger", threshold: 64, on: { command: "look.go", args: { id: "pale" } } })]);
    expect(mapper.handle(parseMidi([0xb0, 7, 63])).calls).to.deep.equal([]); // raw 63: just below the threshold
    expect(mapper.handle(parseMidi([0xb0, 7, 65])).calls).to.deep.equal([{ command: "look.go", args: { id: "pale" } }]); // raw 65: just above
    expect(mapper.handle(parseMidi([0xb0, 7, 0])).calls).to.deep.equal([]); // released: a trigger never answers twice
  });

  it("CC latch toggles on above the threshold and releases below it", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([MappingSchema.parse({ id: "cc", input: { type: "cc", channel: 1, number: 7 }, mode: "latch", threshold: 64, on: { command: "look.go", args: { id: "pale" } }, off: { command: "look.stop", args: { id: "pale" } } })]);
    expect(mapper.handle(parseMidi([0xb0, 7, 65])).calls.map((c) => c.command)).to.deep.equal(["look.go"]);
    expect(mapper.handle(parseMidi([0xb0, 7, 0])).calls.map((c) => c.command)).to.deep.equal(["look.stop"]);
    expect(mapper.handle(parseMidi([0xb0, 7, 65])).calls.map((c) => c.command)).to.deep.equal(["look.go"]);
  });

  it("CC momentary acts above the threshold and releases below it", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([MappingSchema.parse({ id: "cc", input: { type: "cc", channel: 1, number: 7 }, mode: "momentary", threshold: 64, on: { command: "group.level", args: { id: "master" } }, levelArg: "level" })]);
    expect(mapper.handle(parseMidi([0xb0, 7, 65])).calls[0]!.args.level).to.be.closeTo(65 / 127, 0.001); // raw 65: engaged
    expect(mapper.handle(parseMidi([0xb0, 7, 0])).calls).to.deep.equal([{ command: "group.level", args: { id: "master", level: 0 } }]); // released
  });

  it("pitch bend follows the same mode and threshold as the CC", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([MappingSchema.parse({ id: "bend", input: { type: "pitchbend", channel: 1, number: 0 }, mode: "trigger", threshold: 64, on: { command: "look.go", args: { id: "pale" } } })]);
    expect(mapper.handle(parseMidi([0xe0, 0, 63])).calls.map((c) => c.command)).to.deep.equal([]); // raw 63: just below the threshold
    expect(mapper.handle(parseMidi([0xe0, 0, 65])).calls.map((c) => c.command)).to.deep.equal(["look.go"]); // raw 65: just above
  });

  it("toggle: an activation above the threshold toggles on, returning to 0 does nothing", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([MappingSchema.parse({ id: "cc", input: { type: "cc", channel: 1, number: 7 }, mode: "toggle", threshold: 64, on: { command: "look.go", args: { id: "pale" } }, off: { command: "look.stop", args: { id: "pale" } } })]);
    expect(mapper.handle(parseMidi([0xb0, 7, 65])).calls.map((c) => c.command)).to.deep.equal(["look.go"]);
    expect(mapper.handle(parseMidi([0xb0, 7, 0])).calls.map((c) => c.command)).to.deep.equal([]);
    expect(mapper.handle(parseMidi([0xb0, 7, 65])).calls.map((c) => c.command)).to.deep.equal(["look.stop"]); // second activation deactivates
  });

  it("toggle: an above-threshold CC send while engaged switches it off, then on again", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([MappingSchema.parse({ id: "cc", input: { type: "cc", channel: 1, number: 7 }, mode: "toggle", threshold: 64, on: { command: "look.go", args: { id: "pale" } }, off: { command: "look.stop", args: { id: "pale" } } })]);
    expect(mapper.handle(parseMidi([0xb0, 7, 65])).calls.map((c) => c.command)).to.deep.equal(["look.go"]); // raw 65: the toggle switches on
    expect(mapper.handle(parseMidi([0xb0, 7, 65])).calls.map((c) => c.command)).to.deep.equal(["look.stop"]); // raw 65 again: the toggle switches off
    expect(mapper.handle(parseMidi([0xb0, 7, 65])).calls.map((c) => c.command)).to.deep.equal(["look.go"]); // raw 65 once more: the toggle switches on again
  });

  const cc = (v: number) => parseMidi([0xb0, 7, v]);
  const ccMapping = (m: Record<string, unknown>) => MappingSchema.parse({ id: "cc", input: { type: "cc", channel: 1, number: 7 }, ...m });
  const fader = { on: { command: "group.level", args: { id: "master" } }, levelArg: "level" };
  const levels = (mapper: MidiMapper, v: number) => mapper.handle(cc(v)).calls.map((c) => c.args.level);

  it("CC latch: a level action follows the control while latched", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([ccMapping({ ...fader, mode: "latch" })]);
    expect(levels(mapper, 64)).to.deep.equal([0.504]);
    expect(levels(mapper, 127)).to.deep.equal([1]);
    expect(levels(mapper, 0)).to.deep.equal([0]);
  });

  it("CC momentary without off nor level does not fire again on release", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([ccMapping({ mode: "momentary", on: { command: "tempo.tap", args: {} } })]);
    expect(mapper.handle(cc(127)).calls.map((c) => c.command)).to.deep.equal(["tempo.tap"]);
    expect(mapper.handle(cc(0)).calls).to.deep.equal([]);
  });

  it("a released fader rests at the bottom of its scale (an inverted fader at its top)", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([ccMapping({ ...fader, mode: "trigger", scale: { outMin: 1, outMax: 0 } })]);
    expect(levels(mapper, 127)).to.deep.equal([0]);
    expect(levels(mapper, 0)).to.deep.equal([1]);
  });

  it("toggle switched off by a CC 127 brings a level action back to rest", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([ccMapping({ ...fader, mode: "toggle" })]);
    expect(levels(mapper, 127)).to.deep.equal([1]);
    expect(levels(mapper, 127)).to.deep.equal([0]); // a controller that only ever sends 127
  });

  it("CC trigger releases once when it crosses below the threshold", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([ccMapping({ ...fader, mode: "trigger", threshold: 64 })]);
    expect(levels(mapper, 10)).to.deep.equal([]); // never engaged: nothing to release
    expect(levels(mapper, 100)).to.have.length(1);
    expect(levels(mapper, 30)).to.deep.equal([0]);
    expect(levels(mapper, 20)).to.deep.equal([]);
  });

  it("a note on at or under the threshold (a light hit) does not answer", () => {
    for (const mode of ["trigger", "latch", "momentary", "toggle"] as const) {
      const mapper = new MidiMapper();
      mapper.setMappings([map({ id: "a", mode, threshold: 64 })]);
      expect(mapper.handle(on(36, 64)).calls, mode).to.deep.equal([]);
      expect(mapper.handle(off(36)).calls, mode).to.deep.equal([]);
      expect(mapper.handle(on(36, 65)).calls.map((c) => c.command), mode).to.deep.equal(["section.go"]);
    }
  });

  it("a threshold of 127 is refused: no 7-bit value could exceed it", () => {
    expect(() => ccMapping({ ...fader, threshold: 127 })).to.throw();
  });

  it("pickup ignores the fader until it meets the value set elsewhere", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([MappingSchema.parse({ id: "cc", input: { type: "cc", channel: 1, number: 7 }, on: { command: "group.level", args: {} }, levelArg: "level", pickup: true })]);
    mapper.syncState("cc", true, 0.8); // set from the UI
    expect(mapper.handle(parseMidi([0xb0, 7, 10])).calls).to.deep.equal([]);
    expect(mapper.handle(parseMidi([0xb0, 7, 102])).calls).to.have.length(1); // ≈ 0.80
  });

  it("emits feedback on every change, whatever its origin", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([map({ id: "a", mode: "latch" })]);
    expect(mapper.handle(on(36)).feedback).to.deep.equal([[0x90, 36, 127]]);
    expect(mapper.syncState("a", false)).to.deep.equal([[0x80, 36, 0]]);
    expect(mapper.syncState("a", false)).to.deep.equal([]); // no change, no message
  });

  it("program change trigger: three receipts give look.go each time, never look.stop", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([MappingSchema.parse({ id: "pc", input: { type: "programchange", channel: 1, number: 5 }, mode: "trigger", on: { command: "look.go", args: { id: "pale" } }, off: { command: "look.stop", args: { id: "pale" } } })]);
    const pc = () => parseMidi([0xc0, 5]);
    expect(mapper.handle(pc()).calls.map((c) => c.command)).to.deep.equal(["look.go"]);
    expect(mapper.handle(pc()).calls.map((c) => c.command)).to.deep.equal(["look.go"]);
    expect(mapper.handle(pc()).calls.map((c) => c.command)).to.deep.equal(["look.go"]);
  });

  it("program change in latch, momentary and toggle: look.go, then look.stop, then look.go", () => {
    for (const mode of ["latch", "momentary", "toggle"] as const) {
      const mapper = new MidiMapper();
      mapper.setMappings([MappingSchema.parse({ id: "pc", input: { type: "programchange", channel: 1, number: 5 }, mode, on: { command: "look.go", args: { id: "pale" } }, off: { command: "look.stop", args: { id: "pale" } } })]);
      const pc = () => parseMidi([0xc0, 5]);
      expect(mapper.handle(pc()).calls.map((c) => c.command), mode).to.deep.equal(["look.go"]);
      expect(mapper.handle(pc()).calls.map((c) => c.command), mode).to.deep.equal(["look.stop"]);
      expect(mapper.handle(pc()).calls.map((c) => c.command), mode).to.deep.equal(["look.go"]);
    }
  });

  it("a program change with another number or channel matches nothing", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([MappingSchema.parse({ id: "pc", input: { type: "programchange", channel: 1, number: 5 }, mode: "trigger", on: { command: "look.go", args: { id: "pale" } } })]);
    expect(mapper.handle(parseMidi([0xc0, 6])).matched).to.deep.equal([]);
    expect(mapper.handle(parseMidi([0xc1, 5])).matched).to.deep.equal([]);
  });

  it("program change release without off sends no call", () => {
    const mapper = new MidiMapper();
    mapper.setMappings([MappingSchema.parse({ id: "pc", input: { type: "programchange", channel: 1, number: 5 }, mode: "latch", on: { command: "look.go", args: { id: "pale" } } })]);
    const pc = () => parseMidi([0xc0, 5]);
    expect(mapper.handle(pc()).calls.map((c) => c.command)).to.deep.equal(["look.go"]);
    expect(mapper.handle(pc()).calls).to.deep.equal([]);
  });
});

describe("note registry", () => {
  const registry = () => new NoteRegistry(NoteRegistrySchema.parse({ bands: [{ id: "common", from: 0, to: 2 }, { id: "songs", from: 36, to: 95 }] }));

  it("pins notes and never changes them", () => {
    const r = registry();
    expect(r.assign("palette:intime", "common").note).to.equal(0);
    expect(r.assign("palette:feu", "common").note).to.equal(1);
    expect(r.assign("palette:intime", "common").note).to.equal(0);
  });

  it("keeps a released note reserved", () => {
    const r = registry();
    r.assign("a", "common");
    r.release("a");
    expect(r.assign("b", "common").note).to.equal(1);
    expect(() => r.pin("c", "common", 0)).to.throw(NoteCollision);
  });

  it("throws on a full band and on manual collisions", () => {
    const r = registry();
    r.assign("a", "common");
    r.assign("b", "common");
    r.assign("c", "common");
    expect(() => r.assign("d", "common")).to.throw(NoteCollision);
    expect(() => r.pin("e", "songs", 36)).to.not.throw();
    expect(() => r.pin("f", "songs", 36)).to.throw(NoteCollision);
  });
});

describe("ignoreRepeats: one press sent twice is one press (decision of 2026-11-18)", () => {
  const harness = (mode: Mapping["mode"], ignoreRepeats?: boolean) => {
    let now = 0;
    const mapper = new MidiMapper(() => now);
    mapper.setMappings([MappingSchema.parse({ id: "pad", input: { type: "cc", channel: 1, number: 20 }, mode, ...(ignoreRepeats === undefined ? {} : { ignoreRepeats }), on: { command: "look.go", args: { id: "hole" } }, off: { command: "look.stop", args: { id: "hole" } } })]);
    const cc = (v: number, at: number) => {
      now = at;
      return mapper.handle(parseMidi([0xb0, 20, v])).calls.map((c) => c.command);
    };
    return { cc };
  };

  for (const mode of ["toggle", "trigger"] as const) {
    it(`${mode}: an equal value within 150 ms is ignored; after a pause, or after another value, it goes`, () => {
      const h = harness(mode, true);
      expect(h.cc(127, 0)).to.have.length(1);
      expect(h.cc(127, 40)).to.deep.equal([]); // the same press sent again
      expect(h.cc(127, 140)).to.deep.equal([]); // still within 150 ms of the one before
      expect(h.cc(127, 400)).to.have.length(1); // a new press after a pause
      expect(h.cc(0, 410)).to.deep.equal(mode === "trigger" ? ["look.stop"] : []); // another value: handled as such
      expect(h.cc(127, 420)).to.have.length(1); // after another value: a new press
    });
  }

  it("off by default: a pad sending CC 127 at each press toggles at each press, however fast", () => {
    const h = harness("toggle");
    expect([h.cc(127, 0), h.cc(127, 40), h.cc(127, 80)].map((c) => c.length)).to.deep.equal([1, 1, 1]);
  });

  it("only for a CC in « toggle » or « trigger »: a latch to a level keeps every value, equal ones included", () => {
    let now = 0;
    const mapper = new MidiMapper(() => now);
    mapper.setMappings([MappingSchema.parse({ id: "fader", input: { type: "cc", channel: 1, number: 20 }, mode: "latch", ignoreRepeats: true, on: { command: "group.level", args: { id: "front" } }, levelArg: "level" })]);
    const cc = (v: number, at: number) => {
      now = at;
      return mapper.handle(parseMidi([0xb0, 20, v])).calls.length;
    };
    expect([cc(127, 0), cc(127, 40), cc(127, 80)]).to.deep.equal([1, 1, 1]);
  });

  it("by controller: a second controller pressing within 150 ms goes; each its own repetitions (decision of 2026-11-18)", () => {
    let now = 0;
    const mapper = new MidiMapper(() => now);
    mapper.setMappings([MappingSchema.parse({ id: "pad", input: { type: "cc", channel: 1, number: 20 }, mode: "toggle", ignoreRepeats: true, on: { command: "look.go", args: { id: "hole" } }, off: { command: "look.stop", args: { id: "hole" } } })]);
    const cc = (at: number, port: string, client?: string) => {
      now = at;
      return mapper.handle(parseMidi([0xb0, 20, 127]), port, client).calls.length;
    };
    expect(cc(0, "USB Pad")).to.equal(1);
    expect(cc(20, "IAC Live")).to.equal(1); // another controller: its own press
    expect(cc(40, "USB Pad")).to.equal(0); // the first one's repetition
    expect(cc(60, "Web MIDI · Pad", "tab-a")).to.equal(1); // a browser
    expect(cc(80, "Web MIDI · Pad", "tab-b")).to.equal(1); // another browser with a pad of the same name
    expect(cc(100, "Web MIDI · Pad", "tab-a")).to.equal(0);
  });

  it("the limit is exact: 149 ms after, a repetition; 150 ms after, a new press", () => {
    const h = harness("toggle", true);
    expect(h.cc(127, 0)).to.have.length(1);
    expect(h.cc(127, 149)).to.deep.equal([]);
    const g = harness("toggle", true);
    expect(g.cc(127, 0)).to.have.length(1);
    expect(g.cc(127, 150)).to.have.length(1);
  });

  it("a clock that went back counts as a pause: the value goes", () => {
    const h = harness("toggle", true);
    expect(h.cc(127, 1000)).to.have.length(1);
    expect(h.cc(127, 900)).to.have.length(1);
  });

  it("not for a level action: a CC to a level in « trigger » keeps every value, even with the setting on", () => {
    let now = 0;
    const mapper = new MidiMapper(() => now);
    mapper.setMappings([MappingSchema.parse({ id: "fader", input: { type: "cc", channel: 1, number: 20 }, mode: "trigger", ignoreRepeats: true, on: { command: "group.level", args: { id: "front" } }, levelArg: "level" })]);
    const n = (at: number) => {
      now = at;
      return mapper.handle(parseMidi([0xb0, 20, 100])).calls.length;
    };
    expect([n(0), n(40)]).to.deep.equal([1, 1]);
  });

  it("a stream of the same value (Live's chase) stays ignored: each repetition's time counts, not only the first one's", () => {
    const h = harness("toggle", true);
    expect(h.cc(127, 0)).to.have.length(1);
    expect(h.cc(127, 100)).to.deep.equal([]);
    expect(h.cc(127, 200)).to.deep.equal([]); // 100 ms after the one before: still the same press
    expect(h.cc(127, 400)).to.have.length(1); // a pause: a new press
  });
});
