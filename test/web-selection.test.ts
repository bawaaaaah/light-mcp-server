import { expect } from "chai";
import { framed, pick, type Box } from "../web/src/selection.js";

// a 3 × 3 grid of 2 × 1 buttons, and a wide fader under them
const grid: Box[] = [];
for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) grid.push({ id: `b${row}${col}`, x: col * 2, y: row, w: 2, h: 1 });
grid.push({ id: "fader", x: 0, y: 3, w: 6, h: 2 });
const at = (id: string) => grid.find((b) => b.id === id)!;

describe("dashboard: several widgets selected at once", () => {
  it("frames the widgets between two, across and down, in reading order", () => {
    expect(framed(grid, at("b00"), at("b11"))).to.deep.equal(["b00", "b01", "b10", "b11"]);
    expect(framed(grid, at("b22"), at("b02"))).to.deep.equal(["b02", "b12", "b22"]); // a column, picked upwards
    expect(framed(grid, at("b10"), at("b12"))).to.deep.equal(["b10", "b11", "b12"]); // a row
    expect(framed(grid, at("b00"), at("fader"))).to.deep.equal(grid.map((b) => b.id)); // a widget as wide as the rest frames them all
  });

  it("selects alone, adds and takes out with Ctrl or ⌘, frames with Shift from the last one clicked", () => {
    let s = pick(grid, [], undefined, at("b00"), { add: false, frame: false });
    expect(s).to.deep.equal({ selection: ["b00"], anchor: "b00" });
    s = pick(grid, s.selection, s.anchor, at("b22"), { add: true, frame: false });
    expect(s).to.deep.equal({ selection: ["b00", "b22"], anchor: "b22" });
    s = pick(grid, s.selection, s.anchor, at("b00"), { add: true, frame: false });
    expect(s.selection).to.deep.equal(["b22"]); // clicked again: taken out
    s = pick(grid, s.selection, s.anchor, at("b20"), { add: false, frame: true });
    expect(s).to.deep.equal({ selection: ["b00", "b10", "b20"], anchor: "b00" }); // the column from the last one clicked (b00) down
    s = pick(grid, ["b11"], "b02", at("b12"), { add: true, frame: true });
    expect(s.selection).to.deep.equal(["b11", "b02", "b12"]); // Ctrl+Shift adds the frame to what was selected
    expect(pick(grid, [], undefined, at("b11"), { add: false, frame: true }).selection).to.deep.equal(["b11"]); // no corner yet: alone
  });
});
