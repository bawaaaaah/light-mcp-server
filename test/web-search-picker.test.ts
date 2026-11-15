import { expect } from "chai";
import { pickerRows, rowAfterKey, type SearchItem } from "../web/src/search-picker.js";

/**
 * The shared list with a search (T6, generalised by T32: SearchPicker): what a search keeps, folded without case or
 * accents, variants kept beside their parent, the badge and the keywords searched too; where the arrow keys go.
 */
describe("search picker: rows and keys", () => {
  const items: SearchItem[] = [
    { key: "a", label: "Avant-scène", color: "#ff0000" },
    { key: "b", label: "Contre-plongée", badge: "à revoir" },
    { key: "c", label: "Douche", keywords: ["chœur", "centre"] },
    { key: "m", label: "Strobe", detail: "64-95" },
    { key: "m1", label: "Lent", parent: "m", detail: "64-79" },
    { key: "m2", label: "Rapide", parent: "m", detail: "80-95" },
  ];
  const keys = (q: string) => {
    const { shown, picks } = pickerRows(items, q);
    return { shown: shown.map((i) => i.key), picks: picks.map((i) => i.key) };
  };

  it("keeps everything without a search, finds without case or accents, by every word typed", () => {
    expect(keys("").shown).to.deep.equal(["a", "b", "c", "m", "m1", "m2"]);
    expect(keys("AVANT SCENE").picks).to.deep.equal(["a"]);
    expect(keys("plongee").picks).to.deep.equal(["b"]);
    expect(keys("zzz")).to.deep.equal({ shown: [], picks: [] });
  });

  it("searches the badge, the detail and the keywords", () => {
    expect(keys("revoir").picks).to.deep.equal(["b"]);
    expect(keys("centre").picks).to.deep.equal(["c"]);
    expect(keys("80-95").picks).to.deep.equal(["m2"]);
  });

  it("a variant found keeps its parent in view, a parent found keeps its variants; Enter takes only what was found", () => {
    expect(keys("rapide")).to.deep.equal({ shown: ["m", "m2"], picks: ["m2"] });
    expect(keys("strobe")).to.deep.equal({ shown: ["m", "m1", "m2"], picks: ["m"] });
  });

  it("the arrows go from the search to the rows and between them, Home and End within the rows", () => {
    expect(rowAfterKey("ArrowDown", -1, 3)).to.equal(0);
    expect(rowAfterKey("ArrowDown", 2, 3)).to.equal(2);
    expect(rowAfterKey("ArrowUp", 0, 3)).to.equal(-1);
    expect(rowAfterKey("ArrowUp", -1, 3)).to.equal(-1);
    expect(rowAfterKey("Home", 2, 3)).to.equal(0);
    expect(rowAfterKey("End", 0, 3)).to.equal(2);
    expect(rowAfterKey("Home", -1, 3)).to.equal(undefined); // in the search field, Home moves the caret
    expect(rowAfterKey("ArrowDown", -1, 0)).to.equal(undefined);
    expect(rowAfterKey("Enter", 0, 3)).to.equal(undefined);
  });
});
