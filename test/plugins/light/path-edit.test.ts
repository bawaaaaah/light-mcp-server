import { expect } from "chai";
import { moveStop, typedNumber } from "../../../web/src/path-edit.js";
import { radioTabIndex, radioTarget } from "../../../web/src/radio-keys.js";

/** The look editor's path helpers (T28, review 1): pure, tested without a browser. */
describe("look editor, path helpers (T28)", () => {
  it("moves a stop, the others keeping their order; out of range changes nothing", () => {
    expect(moveStop(["a", "b", "c", "d"], 3, 0)).to.deep.equal(["d", "a", "b", "c"]);
    expect(moveStop(["a", "b", "c"], 0, 2)).to.deep.equal(["b", "c", "a"]);
    expect(moveStop(["a", "b"], 0, 5)).to.deep.equal(["a", "b"]);
  });

  it("reads a typed number as typed: a minus first, a decimal comma, nothing for what is not a number", () => {
    expect(typedNumber("-3")).to.equal(-3);
    expect(typedNumber("1,5")).to.equal(1.5);
    expect(typedNumber(" 2.25 ")).to.equal(2.25);
    for (const bad of ["", "-", ".", "abc", "1e400"]) expect(typedNumber(bad), bad).to.equal(undefined);
  });

  it("radio groups: one stop in the Tab order, arrows wrap round and skip a disabled radio", () => {
    expect([0, 1, 2].map((i) => radioTabIndex(i === 1, i, true))).to.deep.equal([-1, 0, -1]);
    expect([0, 1, 2].map((i) => radioTabIndex(false, i, false))).to.deep.equal([0, -1, -1]);
    expect(radioTarget("ArrowRight", 2, 3)).to.equal(0);
    expect(radioTarget("ArrowLeft", 0, 3)).to.equal(2);
    expect(radioTarget("ArrowDown", 0, 3, (i) => i !== 1)).to.equal(2);
    expect(radioTarget("End", 0, 3, (i) => i !== 2)).to.equal(1);
    expect(radioTarget("Home", 2, 3)).to.equal(0);
    expect(radioTarget("Enter", 0, 3)).to.equal(undefined);
  });
});
