import { expect } from "chai";
import { GHOST_RADIUS_PX, swallows } from "../web/src/ghost-guard.js";
import { SHEET_GUARD_MS } from "../web/src/preview-first.js";

describe("preview before launch: the echo of the press that closed the sheet", () => {
  const armed = { x: 200, y: 400, until: 1000 };

  it("swallows a press at the same spot while the guard lasts", () => {
    expect(swallows(900, armed, { x: 200, y: 400 })).to.equal(true);
    expect(swallows(999, armed, { x: 210, y: 395 })).to.equal(true);
  });

  it("lets a press through once the guard is over (strictly: at the end it is over)", () => {
    expect(swallows(1000, armed, { x: 200, y: 400 })).to.equal(false);
    expect(swallows(5000, armed, { x: 200, y: 400 })).to.equal(false);
  });

  it("lets a press elsewhere through, even inside the delay: a deliberate press is not dropped", () => {
    expect(swallows(900, armed, { x: 200 + GHOST_RADIUS_PX + 1, y: 400 })).to.equal(false);
    expect(swallows(900, armed, { x: 600, y: 90 })).to.equal(false);
    expect(swallows(900, armed, { x: 200 + GHOST_RADIUS_PX, y: 400 })).to.equal(true); // on the edge it still is the same spot
  });

  it("swallows nothing when nothing armed it", () => {
    expect(swallows(0, null, { x: 0, y: 0 })).to.equal(false);
  });

  it("lasts as long as the guard of the sheet (400 ms)", () => {
    expect(SHEET_GUARD_MS).to.equal(400);
  });
});
