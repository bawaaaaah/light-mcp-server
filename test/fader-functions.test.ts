import { expect } from "chai";
import { faderFunctions, functionOf } from "../web/src/fader-functions.js";

describe("fader functions (T12): a channel fader narrowed to a named function", () => {
  const wheel = { offset: 7, name: "Color Wheel", ranges: [{ min: 0, max: 15, name: "White" }, { min: 16, max: 31, name: "Red" }] };
  const gobo = { offset: 8, name: "Gobo", ranges: [{ min: 0, max: 7, name: "Open" }, { min: 64, max: 71, name: "Gobo 3" }] };
  const fixtures = [
    { id: "spot-1", channels: [wheel, gobo, { offset: 5, name: "Dimmer" }] },
    { id: "spot-2", channels: [wheel, gobo] },
  ];

  it("lists one channel's functions with their values, once for every fixture of the model", () => {
    expect(faderFunctions(fixtures, [{ fixture: "spot-1", offset: 7 }, { fixture: "spot-2", offset: 7 }])).to.deep.equal([
      { label: "White (0–15)", min: 0, max: 15 },
      { label: "Red (16–31)", min: 16, max: 31 },
    ]);
  });

  it("names the channel when the fader drives several, and offers nothing for a plain channel", () => {
    expect(faderFunctions(fixtures, [{ fixture: "spot-1", offset: 7 }, { fixture: "spot-1", offset: 8 }]).map((f) => f.label)).to.include("Gobo · Gobo 3 (64–71)");
    expect(faderFunctions(fixtures, [{ fixture: "spot-1", offset: 5 }])).to.deep.equal([]);
    expect(faderFunctions(fixtures, [{ fixture: "gone", offset: 7 }])).to.deep.equal([]);
  });

  it("finds the function a range covers exactly, and none for a custom range", () => {
    const list = faderFunctions(fixtures, [{ fixture: "spot-1", offset: 8 }]);
    expect(functionOf(list, { min: 64, max: 71 })?.label).to.equal("Gobo 3 (64–71)");
    expect(functionOf(list, { min: 60, max: 71 })).to.equal(undefined);
  });
});
