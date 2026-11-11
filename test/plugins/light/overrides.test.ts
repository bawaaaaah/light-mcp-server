import { expect } from "chai";
import { mergeOverrides, modelKey } from "../../../src/plugins/light/venue/overrides.js";

describe("fixture overrides: a model's corrections, overridden by a fixture's own", () => {
  it("keys a model without case or punctuation", () => {
    expect(modelKey("Mac Mah", "Spot 200")).to.equal(modelKey("mac-mah", "SPOT_200"));
  });

  it("replaces each part as a whole by the fixture's own, and keeps the model's other parts", () => {
    const merged = mergeOverrides({ wheel: { a: 1 }, heads: { accent: [] } }, { wheel: { c: 3 } });
    expect(merged).to.deep.equal({ wheel: { c: 3 }, heads: { accent: [] } });
    expect(mergeOverrides(undefined, undefined)).to.deep.equal({});
  });
});
