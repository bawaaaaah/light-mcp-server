import { expect } from "chai";
import { build, newMapping } from "../web/src/mappingActions.js";

/** A flash played from MIDI (docs/specs/midi.md, « CC et pitch bend »): from a CC or a pitch bend it keeps its mode, as the mapper plays it. */
describe("pitch bend mappings, as the editor builds them", () => {
  it("a flash from a pitch bend or a CC keeps its mode; from a note it is held while pressed", () => {
    expect(build({ ...newMapping(), input: { type: "pitchbend", channel: 1, number: 0 }, mode: "toggle" }, "flash", "front").mode).to.equal("toggle");
    expect(build({ ...newMapping(), input: { type: "cc", channel: 1, number: 20 }, mode: "latch" }, "flash", "front").mode).to.equal("latch");
    expect(build({ ...newMapping(), mode: "toggle" }, "flash", "front").mode).to.equal("momentary");
  });
});
