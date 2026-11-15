import { expect } from "chai";
import { beyondStops, logicalDeg, nudgeDeg, parseDeg, roundDeg, stopProblem } from "../web/src/manualCalibration.js";

describe("manual calibration tab (T8, lot 6): what its fields read and check", () => {
  it("reads degrees typed with a comma, a point, a sign or a typographic minus", () => {
    expect(parseDeg("12,5")).to.equal(12.5);
    expect(parseDeg(" -3.25 ")).to.equal(-3.25);
    expect(parseDeg("−7,1")).to.equal(-7.1);
    expect(parseDeg("+4")).to.equal(4);
    expect(parseDeg(",5")).to.equal(0.5);
    for (const bad of ["", "-", "abc", "1,2,3", "1e3", "12°"]) expect(parseDeg(bad), bad).to.equal(undefined);
  });

  it("moves a field by a tenth of a degree, a whole one with Shift, on the tenth grid", () => {
    expect(nudgeDeg(0.2, "ArrowUp", false)).to.equal(0.3);
    expect(nudgeDeg(0.2, "ArrowDown", true)).to.equal(-0.8);
    expect(nudgeDeg(0, "ArrowLeft", false)).to.equal(undefined);
    expect(roundDeg(0.1 + 0.2)).to.equal(0.3);
  });

  it("refuses a stop the wrong way round or beyond half the travel, as venue.fixture.orient does", () => {
    expect(stopProblem([-100, 100], 540)).to.equal(undefined);
    expect(stopProblem([-270, 270], 540)).to.equal(undefined);
    expect(stopProblem([10, -10], 540)).to.deep.equal({ kind: "order" });
    expect(stopProblem([-300, 0], 540)).to.deep.equal({ kind: "outside", half: 270 });
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
