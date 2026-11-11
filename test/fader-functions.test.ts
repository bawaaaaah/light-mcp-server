import { expect } from "chai";
import { faderFunctions, functionsOf, searchFunctions, unfitted } from "../web/src/fader-functions.js";

describe("fader functions (T12): a channel fader narrowed to a named function", () => {
  const wheel = { offset: 7, name: "Color Wheel", ranges: [{ min: 0, max: 15, name: "White" }, { min: 16, max: 31, name: "Red" }] };
  const gobo = { offset: 8, name: "Gobo", ranges: [{ min: 0, max: 15, name: "Open" }, { min: 16, max: 31, name: "Gobo 1" }, { min: 64, max: 71, name: "Gobo 3" }] };
  const dimmer = { offset: 5, name: "Dimmer" };
  const fixtures = [
    { id: "spot-1", name: "Spot 1", model: "Maker Spot", channels: [wheel, gobo, dimmer] },
    { id: "spot-2", name: "Spot 2", model: "Maker Spot", channels: [wheel, gobo] },
    { id: "other", name: "Autre", model: "Maker Other", channels: [{ offset: 2, name: "Gobo", ranges: [{ min: 10, max: 19, name: "Gobo 1" }, { min: 20, max: 255, name: "" }] }] },
  ];

  it("lists one channel's functions with their values, once for every fixture of the model", () => {
    expect(faderFunctions(fixtures, [{ fixture: "spot-1", offset: 7 }, { fixture: "spot-2", offset: 7 }]).map(({ label, min, max }) => ({ label, min, max }))).to.deep.equal([
      { label: "White (0–15)", min: 0, max: 15 },
      { label: "Red (16–31)", min: 16, max: 31 },
    ]);
  });

  it("names the channel only when several channels with functions are ticked, and the model only when several models are", () => {
    expect(faderFunctions(fixtures, [{ fixture: "spot-1", offset: 7 }, { fixture: "spot-1", offset: 8 }]).map((f) => f.label)).to.include("Gobo · Gobo 3 (64–71)");
    // a dimmer has no functions: ticked with the wheel, the wheel's labels stay plain
    expect(faderFunctions(fixtures, [{ fixture: "spot-1", offset: 7 }, { fixture: "spot-1", offset: 5 }]).map((f) => f.label)).to.include("Red (16–31)");
    const twoModels = faderFunctions(fixtures, [{ fixture: "spot-1", offset: 8 }, { fixture: "other", offset: 2 }]).map((f) => f.label);
    expect(twoModels).to.include.members(["Maker Spot · Gobo 1 (16–31)", "Maker Other · Gobo 1 (10–19)"]); // one name, two ranges: told apart
    expect(twoModels).to.include("Maker Other · 20–255"); // a function without a name shows its values alone
    expect(faderFunctions(fixtures, [{ fixture: "spot-1", offset: 5 }])).to.deep.equal([]);
    expect(faderFunctions(fixtures, [{ fixture: "gone", offset: 7 }])).to.deep.equal([]);
  });

  it("finds every function a range covers, when two share it", () => {
    const list = faderFunctions(fixtures, [{ fixture: "spot-1", offset: 7 }, { fixture: "spot-1", offset: 8 }]);
    expect(functionsOf(list, { min: 16, max: 31 }).map((f) => f.label)).to.deep.equal(["Color Wheel · Red (16–31)", "Gobo · Gobo 1 (16–31)"]);
    expect(functionsOf(list, { min: 60, max: 71 })).to.deep.equal([]);
  });

  it("searches without case, accents or dash kind, every word somewhere in the label", () => {
    const list = faderFunctions(fixtures, [{ fixture: "spot-1", offset: 7 }, { fixture: "spot-1", offset: 8 }]);
    expect(searchFunctions(list, "gobo 3").map((f) => f.label)).to.deep.equal(["Gobo · Gobo 3 (64–71)"]);
    expect(searchFunctions(list, "red (16-31)").map((f) => f.label)).to.deep.equal(["Color Wheel · Red (16–31)"]);
    expect(searchFunctions([{ label: "Rouge clair (0–9)", min: 0, max: 9, key: "a" }], "rouge CLAIR")).to.have.length(1);
    expect(searchFunctions([{ label: "Éclair (0–9)", min: 0, max: 9, key: "b" }], "eclair")).to.have.length(1);
    expect(searchFunctions(list, "")).to.have.length(list.length);
  });

  it("keeps a function's key when its label gains a prefix (a second channel or model ticked)", () => {
    const alone = faderFunctions(fixtures, [{ fixture: "spot-1", offset: 8 }]).find((f) => f.label === "Gobo 1 (16–31)")!;
    const both = faderFunctions(fixtures, [{ fixture: "spot-1", offset: 8 }, { fixture: "other", offset: 2 }]).find((f) => f.key === alone.key)!;
    expect(both.label).to.equal("Maker Spot · Gobo 1 (16–31)");
  });

  it("names the ticked channels a narrowed range does not fit, and none for the whole travel", () => {
    const picked = [{ fixture: "spot-1", offset: 7 }, { fixture: "spot-1", offset: 8 }, { fixture: "spot-1", offset: 5 }, { fixture: "other", offset: 2 }];
    expect(unfitted(fixtures, picked, { min: 64, max: 71 })).to.deep.equal(["Spot 1 · Color Wheel", "Spot 1 · Dimmer", "Autre · Gobo"]);
    expect(unfitted(fixtures, picked, { min: 0, max: 255 })).to.deep.equal([]);
  });
});
