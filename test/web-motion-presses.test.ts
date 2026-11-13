import { expect } from "chai";
import { pressesLeft, type PressHead } from "../web/src/motionPresses.js";
import type { AxisLayer } from "../src/plugins/light/engine/motion.js";

const head = (pan: AxisLayer[], tilt: AxisLayer[] = pan): PressHead => ({ motion: { pan: { layer: pan[0]!, layers: pan }, tilt: { layer: tilt[0]!, layers: tilt } } });

describe("motion pad: presses of « Rendre la main » still effective", () => {
  it("counts nothing at rest, under a hold once, and one press per stacked claim", () => {
    expect(pressesLeft([])).to.equal(0);
    expect(pressesLeft([head(["rest"])])).to.equal(0);
    expect(pressesLeft([head(["hold", "rest"])])).to.equal(1);
    expect(pressesLeft([head(["look", "look", "look", "rest"])])).to.equal(3); // three stacked looks: three presses
    expect(pressesLeft([head(["manual", "look", "rest"], ["manual", "rest"])])).to.equal(2); // both axes go with the first
    expect(pressesLeft([{ motion: null }])).to.equal(0);
  });

  it("descends a mixed group one layer at a time, the strongest present first", () => {
    // spot held by hand over a look, two heads on the look only: the manual goes, then the look everywhere
    expect(pressesLeft([head(["manual", "look", "rest"]), head(["look", "rest"]), head(["look", "rest"])])).to.equal(2);
    // a head with a target and a look, another with two looks: target, then a look on both, then the second look
    expect(pressesLeft([head(["target", "look", "rest"]), head(["look", "look", "rest"])])).to.equal(3);
    // the count drops as a press would: not the maximum of the heads (2) but the presses of the rule (3)
    expect(pressesLeft([head(["manual", "rest"]), head(["target", "rest"]), head(["look", "rest"])])).to.equal(3);
  });

  it("sets locked heads aside and counts only the manual claim above a soft lock", () => {
    expect(pressesLeft([head(["lock", "manual", "look", "rest"])])).to.equal(0); // hard lock: nothing
    expect(pressesLeft([head(["lock", "look", "rest"])])).to.equal(0); // soft lock without a manual claim above
    expect(pressesLeft([head(["manual", "lock", "look", "rest"])])).to.equal(1); // soft lock: the manual only
    expect(pressesLeft([head(["manual", "manual", "lock", "target", "rest"])])).to.equal(2);
    // a locked head never decides the layer nor lowers the count of the others
    expect(pressesLeft([head(["lock", "manual", "target", "look", "rest"]), head(["look", "rest"])])).to.equal(1);
  });

  it("falls back on the top layer when the report has no stack", () => {
    expect(pressesLeft([{ motion: { pan: { layer: "look" }, tilt: { layer: "rest" } } }])).to.equal(1);
  });
});
