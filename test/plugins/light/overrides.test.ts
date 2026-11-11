import { expect } from "chai";
import { mergeOverrides, modelKey } from "../../../src/plugins/light/venue/overrides.js";
import { sameName } from "../../../src/plugins/light/venue/qxf-import.js";

describe("fixture overrides: a model's corrections, overridden by a fixture's own", () => {
  it("keys a model without case or punctuation", () => {
    expect(modelKey("Mac Mah", "Spot 200")).to.equal(modelKey("mac-mah", "SPOT_200"));
  });

  it("keys a model as its definition is found: « Spot 200 » is « Spot200 », as sameName says", () => {
    expect(modelKey("Acme", "Spot 200")).to.equal(modelKey("Acme", "Spot200"));
    expect(sameName("Spot 200", "Spot200")).to.equal(true);
  });

  it("keeps manufacturer and model apart: (« A », « B C ») and (« A B », « C ») are two models", () => {
    expect(modelKey("A", "B C")).to.not.equal(modelKey("A B", "C"));
  });

  it("folds accents, for the key and for finding a definition alike", () => {
    expect(modelKey("Éclairage Lumière", "Pâr LED")).to.equal(modelKey("eclairage lumiere", "PAR LED"));
    expect(sameName("Lumière", "Lumiere")).to.equal(true);
  });

  it("refuses a name without a letter or digit, which would key every such model alike", () => {
    expect(() => modelKey("Acme", "★")).to.throw();
    expect(() => modelKey("", "Spot")).to.throw();
  });

  it("replaces each part as a whole by the fixture's own, and keeps the model's other parts", () => {
    const merged = mergeOverrides({ wheel: { doubles: false }, heads: { accent: [] } }, { wheel: { change: "black" } });
    expect(merged).to.deep.equal({ wheel: { change: "black" }, heads: { accent: [] } });
    expect(mergeOverrides(undefined, undefined)).to.deep.equal({});
  });
});
