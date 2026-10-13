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
    expect(mapper.handle(off(36)).calls).to.deep.equal([]);
    expect(mapper.handle(on(36)).calls[0]!.command).to.equal("section.stop");
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
