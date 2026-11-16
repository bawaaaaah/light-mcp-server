import { expect } from "chai";
import { beyondStops, edgeOutside, fieldText, logicalDeg, movedSince, nudgeDeg, parseDeg, parseNumber, roundDeg, stopBar, stopProblem } from "../web/src/manualCalibration.js";

describe("manual calibration tab (T8, lot 6): what its fields read and check", () => {
  it("reads degrees typed with a comma, a point, a sign or a typographic minus", () => {
    expect(parseDeg("12,5")).to.equal(12.5);
    expect(parseDeg(" -3.25 ")).to.equal(-3.25);
    expect(parseDeg("−7,1")).to.equal(-7.1);
    expect(parseDeg("+4")).to.equal(4);
    expect(parseDeg(",5")).to.equal(0.5);
    for (const bad of ["", "-", "abc", "1,2,3", "1e3", "12°"]) expect(parseDeg(bad), bad).to.equal(undefined);
  });

  it("reads metres with the same rules (the mark's height)", () => {
    expect(parseNumber("1,2")).to.equal(1.2);
    expect(parseNumber("haut")).to.equal(undefined);
  });

  it("moves a field by a tenth of a degree, a whole one with Shift, keeping the hundredth it is stored at", () => {
    expect(nudgeDeg(0.2, "ArrowUp", false)).to.equal(0.3);
    expect(nudgeDeg(0.2, "ArrowDown", true)).to.equal(-0.8);
    expect(nudgeDeg(0.25, "ArrowUp", false)).to.equal(0.35);
    expect(nudgeDeg(0, "ArrowLeft", false)).to.equal(undefined);
    expect(roundDeg(0.1 + 0.2)).to.equal(0.3);
    expect(roundDeg(1.234)).to.equal(1.23);
    expect(Object.is(roundDeg(-0.001), 0)).to.equal(true);
  });

  it("shows a field's value as it reads back: two decimals, no thousands separator, a true minus, never −0", () => {
    expect(fieldText(1080, "en")).to.equal("1080");
    expect(fieldText(1080, "fr")).to.equal("1080");
    expect(parseDeg(fieldText(1080, "en"))).to.equal(1080);
    expect(fieldText(-3.25, "fr")).to.equal("−3,25");
    expect(fieldText(-0.001, "fr")).to.equal("0");
    expect(fieldText(0.1, "en")).to.equal("0.1");
    for (const v of [-179.99, -0.05, 0, 12.5, 359.99]) expect(parseDeg(fieldText(v, "fr")), String(v)).to.equal(v);
  });

  it("refuses a stop the wrong way round or beyond half the travel, as venue.fixture.orient does", () => {
    expect(stopProblem([-100, 100], 540)).to.equal(undefined);
    expect(stopProblem([-270, 270], 540)).to.equal(undefined);
    expect(stopProblem([10, -10], 540)).to.deep.equal({ kind: "order" });
    expect(stopProblem([-300, 0], 540)).to.deep.equal({ kind: "outside", half: 270 });
    expect(edgeOutside(-300, 540)).to.deep.equal({ kind: "outside", half: 270 });
    expect(edgeOutside(270, 540)).to.equal(undefined);
  });

  it("draws a stop over the travel, kept on the bar when it lies beyond it", () => {
    expect(stopBar(undefined, 540)).to.deep.equal({ left: 0, width: 100 });
    expect(stopBar([-135, 135], 540)).to.deep.equal({ left: 25, width: 50 });
    expect(stopBar([-400, 400], 540)).to.deep.equal({ left: 0, width: 100 });
    expect(stopBar([300, 400], 540)).to.deep.equal({ left: 100, width: 0 });
  });

  it("tells a head moved since a measure by more than one real step", () => {
    const travel = { pan: 540, tilt: 270 };
    const step = { pan: 540 / 65535, tilt: 270 / 65535 };
    const at = { pan: 0.5, tilt: 0.5 };
    expect(movedSince(at, at, travel, step)).to.equal(false);
    expect(movedSince(at, { pan: 0.5 + 1 / 65535, tilt: 0.5 }, travel, step)).to.equal(false);
    expect(movedSince(at, { pan: 0.5, tilt: 0.5 + 2 / 65535 }, travel, step)).to.equal(true);
  });

  it("tells the axes where the pad asks beyond a stop, one real step of slack", () => {
    const travel = { pan: 540, tilt: 270 };
    const step = { pan: 540 / 65535, tilt: 270 / 65535 };
    expect(logicalDeg(0.75, 540)).to.equal(135);
    expect(beyondStops({ pan: 0.75, tilt: 0.5 }, travel, undefined, step)).to.deep.equal([]);
    expect(beyondStops({ pan: 0.75, tilt: 0.5 }, travel, { pan: [-100, 100] }, step)).to.deep.equal(["pan"]);
    expect(beyondStops({ pan: 0.5 + 100 / 540 + 0.5 / 65535, tilt: 0.1 }, travel, { pan: [-100, 100], tilt: [-90, 90] }, step)).to.deep.equal(["tilt"]);
  });
});
