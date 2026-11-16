import { expect } from "chai";
import { actionOf, build, colourGroupOf, newMapping } from "../web/src/mappingActions.js";

/**
 * A saved colour applied from MIDI (T41; docs/specs/ui-dashboards.md, « Couleurs favorites »): the mapping applies the
 * preset to a group's fixtures (or every fixture), in « Déclencher » whatever the mode asked, and reads back the same
 * action, preset and group.
 */
describe("colour preset as a MIDI action (T41)", () => {
  it("builds colour.apply in trigger mode for a group, keeps the group when rebuilt, and reads it back", () => {
    const m = build({ ...newMapping(), mode: "latch" }, "colour", "c-1", "face");
    expect(m.on).to.deep.equal({ command: "colour.apply", args: { id: "c-1", group: "face" } });
    expect(m.off).to.equal(undefined);
    expect(m.mode).to.equal("trigger");
    expect(actionOf(m)).to.deep.equal({ action: "colour", target: "c-1" });
    expect(colourGroupOf(m)).to.equal("face");
    // another preset, the group kept; then every fixture
    expect(build(m, "colour", "c-2").on.args).to.deep.equal({ id: "c-2", group: "face" });
    expect(build(m, "colour", "c-2", "").on.args).to.deep.equal({ id: "c-2" });
  });
});
