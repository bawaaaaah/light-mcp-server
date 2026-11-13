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

  it("releases a claim from both axes of its head at once, as the server does", () => {
    const keyed = (pan: [AxisLayer, string][], tilt: [AxisLayer, string][]): PressHead => ({
      motion: {
        pan: { layer: pan[0]![0], layers: pan.map(([layer]) => layer), claims: pan.map(([, key]) => key) },
        tilt: { layer: tilt[0]![0], layers: tilt.map(([layer]) => layer), claims: tilt.map(([, key]) => key) },
      },
    });
    const rest: [AxisLayer, string] = ["rest", ""];
    const look = (key: string): [AxisLayer, string] => ["look", key];
    // look B moves pan and tilt, look A (raw, later) writes the pan only: one press releases A on pan and B on tilt,
    // and B leaves the pan with it
    expect(pressesLeft([keyed([look("look:a#2"), look("look:b#1"), rest], [look("look:b#1"), rest])])).to.equal(1);
    // pan [A, B], tilt [C, D, A, B]: A and C go, A leaves the tilt too; then B and D go: two presses, not four
    expect(pressesLeft([keyed([look("A"), look("B"), rest], [look("C"), look("D"), look("A"), look("B"), rest])])).to.equal(2);
    // a key shared by two heads is released head by head: each head counts on its own stacks
    expect(pressesLeft([keyed([look("A"), rest], [look("A"), rest]), keyed([look("B"), look("A"), rest], [look("A"), rest])])).to.equal(1);
    // a hold has no key: it leaves only the axis where it is the top
    expect(pressesLeft([keyed([["manual", "manual#3"], ["hold", ""], rest], [["hold", ""], rest])])).to.equal(2);
  });

  it("falls back on the top layer when the report has no stack", () => {
    expect(pressesLeft([{ motion: { pan: { layer: "look" }, tilt: { layer: "rest" } } }])).to.equal(1);
  });
});
