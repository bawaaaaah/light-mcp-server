import { expect } from "chai";
import { diff } from "../../../src/plugins/light/data/diff.js";

describe("diff of two versions", () => {
  it("says what changes, field by field, and nothing for equal values", () => {
    const before = { id: "l", name: "Creux", timing: { attack: 0, every: { beats: 1 } }, tags: ["a", "b"], colors: ["#ff0000", "#0000ff"] };
    const after = { id: "l", name: "Creux bleu", timing: { attack: 0.5, every: { beats: 1 } }, tags: ["a"], colors: ["#ff0000", "#00ff00"], notes: "doux" };
    expect(diff(before, after)).to.deep.equal([
      { path: "colors[1]", before: "#0000ff", after: "#00ff00" },
      { path: "name", before: "Creux", after: "Creux bleu" },
      { path: "notes", after: "doux" },
      { path: "tags", before: ["a", "b"], after: ["a"] }, // another length: the whole list
      { path: "timing.attack", before: 0, after: 0.5 },
    ]);
    expect(diff(before, structuredClone(before))).to.deep.equal([]);
    expect(diff(undefined, { id: "x" })).to.deep.equal([{ path: "(objet)", after: { id: "x" } }]);
    expect(diff({ a: 1, b: 2, c: 3 }, { a: 2, b: 3, c: 4 }, 2)).to.have.length(2);
  });
});
