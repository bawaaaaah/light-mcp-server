import { expect } from "chai";
import { MidiMapper, MappingSchema } from "../src/plugins/light/midi/mapping.js";
import { PITCHBEND_REST, bendThreshold, build, keptOf, newMapping, wheelRangeOf, withInputType, withWheelRange, type MappingDraft } from "../web/src/mappingActions.js";

/**
 * A pitch bend in the mapping editor (docs/specs/midi.md, « Pitch bend »): the channel's wheel, played like a CC on its
 * top 7 bits. Choosing it gives the wheel's rest as a button's threshold (0 for a level) and no LED feedback, its mode
 * kept (a toggle switches once per push); leaving it gives back what it took; a flash from it keeps the mode chosen.
 */
describe("pitch bend mappings, as the editor builds them", () => {
  it("choosing pitch bend: number 0, threshold at the wheel's rest, no feedback; back to a note, all it took returns", () => {
    const note: MappingDraft = { ...newMapping(), input: { type: "note", channel: 2, number: 36 }, threshold: 20, feedback: "cc" };
    const kept = keptOf(note);
    const bend = withInputType({ ...note, threshold: 0 }, "pitchbend", "look", kept);
    expect(bend.input).to.deep.equal({ type: "pitchbend", channel: 2, number: 0 });
    expect(bend.threshold).to.equal(PITCHBEND_REST);
    expect(bend.feedback).to.equal("none");
    const back = withInputType(bend, "note", "look", kept);
    expect(back.input).to.deep.equal({ type: "note", channel: 2, number: 36 });
    expect(back).to.deep.include({ threshold: 20, feedback: "cc" }); // velocities up to 64 answer again, the LED lights
    // a threshold chosen before is kept for a button
    expect(withInputType({ ...note, threshold: 100 }, "pitchbend", "look").threshold).to.equal(100);
    // between two types with a number, nothing moves
    expect(withInputType(note, "cc", "look")).to.deep.include({ input: { type: "cc", channel: 2, number: 36 }, threshold: 20, feedback: "cc" });
  });

  it("a level action from a wheel starts from 0: no jump at the rest", () => {
    expect(withInputType(newMapping(), "pitchbend", "dca").threshold).to.equal(0);
    expect(bendThreshold(64, "fader")).to.equal(0);
    expect(bendThreshold(0, "flash")).to.equal(PITCHBEND_REST);
  });

  it("a wheel keeps « toggle »: the mapper switches it once per push", () => {
    expect(withInputType({ ...newMapping(), mode: "toggle" }, "pitchbend", "look").mode).to.equal("toggle");
    const bend = { ...newMapping(), input: { type: "pitchbend" as const, channel: 1, number: 0 }, mode: "toggle" as const };
    expect(build(bend, "look", "hole").mode).to.equal("toggle");
    expect(build(bend, "flash", "front").mode).to.equal("toggle");
  });

  it("a wheel to a level: its upper half (scale from 64) or its whole travel (from 0), read back; a note gets its scale back", () => {
    const bend = withInputType(newMapping(), "pitchbend", "dca");
    expect(withWheelRange(bend, "upper").scale?.inMin).to.equal(PITCHBEND_REST);
    expect(wheelRangeOf(withWheelRange(bend, "upper"))).to.equal("upper");
    expect(wheelRangeOf(withWheelRange(bend, "full"))).to.equal("full");
    // a start written by hand is « custom », never rewritten
    const custom = { ...bend, scale: { inMin: 32 } };
    expect(wheelRangeOf(custom)).to.equal("custom");
    expect(withWheelRange(custom, "custom")).to.equal(custom);
    const note = { ...newMapping(), scale: { inMin: 0, inMax: 127 } };
    const upper = withWheelRange(withInputType(note, "pitchbend", "dca"), "upper");
    expect(withInputType(upper, "note", "dca", keptOf(note)).scale).to.deep.equal({ inMin: 0, inMax: 127 });
  });

  it("a flash from a pitch bend or a CC keeps its mode; from a note it is held while pressed", () => {
    const bend = withInputType(newMapping(), "pitchbend", "flash");
    expect(build({ ...bend, mode: "latch" }, "flash", "front").mode).to.equal("latch");
    expect(build({ ...newMapping(), input: { type: "cc", channel: 1, number: 20 }, mode: "latch" }, "flash", "front").mode).to.equal("latch");
    expect(build({ ...newMapping(), mode: "toggle" }, "flash", "front").mode).to.equal("momentary");
  });

  it("the mapper: a flash from the wheel at its rest does nothing, pushed it flashes, back to rest it releases", () => {
    const draft = build({ ...withInputType(newMapping(), "pitchbend", "flash"), mode: "momentary", id: "bend" }, "flash", "front");
    const mapper = new MidiMapper();
    mapper.setMappings([MappingSchema.parse(draft)]);
    const commands = (value: number) => mapper.handle({ type: "pitchbend", channel: 1, value }).calls.map((c) => c.args.on);
    expect(commands(8192)).to.deep.equal([]); // at rest
    expect(commands(16383)).to.deep.equal([true]);
    expect(commands(8192)).to.deep.equal([false]);
  });
});
