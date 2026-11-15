import { expect } from "chai";
import { actionOf, build, newMapping } from "../web/src/mappingActions.js";

/**
 * A named position played from MIDI (T32, lot 4; docs/specs/ui-dashboards.md, « Position nommée »): the mapping the
 * widget's « Apprendre » and the mapping editor build recalls the position, in « Déclencher » whatever the mode asked
 * (a recall has nothing to switch off), and is read back as the same action and position.
 */
describe("named position as a MIDI action (T32)", () => {
  it("builds position.preset.go in trigger mode, without an off command, and reads it back", () => {
    const m = build({ ...newMapping(), mode: "latch" }, "position", "avant-scene");
    expect(m.on).to.deep.equal({ command: "position.preset.go", args: { id: "avant-scene" } });
    expect(m.off).to.equal(undefined);
    expect(m.mode).to.equal("trigger");
    expect(actionOf(m)).to.deep.equal({ action: "position", target: "avant-scene" });
  });
});
