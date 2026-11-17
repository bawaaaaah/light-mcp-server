import { expect } from "chai";
import { MidiMapper, MappingSchema } from "../src/plugins/light/midi/mapping.js";
import { PITCHBEND_REST, build, newMapping, withInputType, type MappingDraft } from "../web/src/mappingActions.js";

/**
 * A pitch bend in the mapping editor (docs/specs/midi.md, « CC et pitch bend »): the channel's wheel, played like a CC
 * on its top 7 bits. Choosing it gives the wheel's rest as threshold and no LED feedback; leaving it gives the number
 * back; a flash from it keeps the mode chosen, as the mapper plays it.
 */
describe("pitch bend mappings, as the editor builds them", () => {
  it("choosing pitch bend: number 0, threshold at the wheel's rest, no feedback; back to a note, its number returns", () => {
    const note: MappingDraft = { ...newMapping(), input: { type: "note", channel: 2, number: 36 }, feedback: "note" };
    const bend = withInputType(note, "pitchbend");
    expect(bend.input).to.deep.equal({ type: "pitchbend", channel: 2, number: 0 });
    expect(bend.threshold).to.equal(PITCHBEND_REST);
    expect(bend.feedback).to.equal("none");
    expect(withInputType(bend, "note", 36).input).to.deep.equal({ type: "note", channel: 2, number: 36 });
    // a threshold chosen before is kept
    expect(withInputType({ ...note, threshold: 100 }, "pitchbend").threshold).to.equal(100);
    // between two types with a number, the number stays
    expect(withInputType(note, "cc").input.number).to.equal(36);
  });

  it("a flash from a pitch bend or a CC keeps its mode; from a note it is held while pressed", () => {
    const bend = withInputType(newMapping(), "pitchbend");
    expect(build({ ...bend, mode: "toggle" }, "flash", "front").mode).to.equal("toggle");
    expect(build({ ...newMapping(), input: { type: "cc", channel: 1, number: 20 }, mode: "latch" }, "flash", "front").mode).to.equal("latch");
    expect(build({ ...newMapping(), mode: "toggle" }, "flash", "front").mode).to.equal("momentary");
  });

  it("the mapper: a flash from the wheel at its rest does nothing, pushed it flashes, back to rest it releases", () => {
    const draft = build({ ...withInputType(newMapping(), "pitchbend"), mode: "momentary", id: "bend" }, "flash", "front");
    const mapper = new MidiMapper();
    mapper.setMappings([MappingSchema.parse(draft)]);
    const commands = (value: number) => mapper.handle({ type: "pitchbend", channel: 1, value }).calls.map((c) => c.args.on);
    expect(commands(8192)).to.deep.equal([]); // at rest
    expect(commands(16383)).to.deep.equal([true]);
    expect(commands(8192)).to.deep.equal([false]);
  });
});
