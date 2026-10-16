import { expect } from "chai";
import { swatchOf } from "../../../src/plugins/light/show/swatch.js";

describe("look swatch (the colour of its button)", () => {
  it("takes the most vivid colour, the most frequent on a tie, and ignores near-black", () => {
    expect(swatchOf({ kind: "plat", color: "#FF0000" })).to.equal("#ff0000");
    expect(swatchOf({ kind: "damier", colors: ["#ffffff", "#0000ff"], block: 4 })).to.equal("#0000ff"); // a colour beats white
    expect(swatchOf({ kind: "pas", steps: [["#000000", "#ff8800", "-", ""], ["#ff8800", "#00ff00", "#000000", "#ff8800"]] })).to.equal("#ff8800");
    expect(swatchOf({ kind: "plat", color: "#050505" })).to.equal(undefined);
    expect(swatchOf({ kind: "aucune" })).to.equal(undefined);
    expect(swatchOf({ kind: "flash", color: "#ffffff", steps: 4 })).to.equal("#ffffff");
  });
});
