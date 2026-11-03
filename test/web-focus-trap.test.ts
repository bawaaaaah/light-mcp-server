import { expect } from "chai";
import { wrappedFocus } from "../web/src/focus-trap.js";

describe("focus trap: wrapped focus target", () => {
  it("returns undefined for an empty list", () => {
    expect(wrappedFocus([], "x", false)).to.be.undefined;
    expect(wrappedFocus([], null, true)).to.be.undefined;
  });
  it("going forward from the last item gives the first", () => {
    const items = ["a", "b", "c"];
    expect(wrappedFocus(items, "c", false)).to.equal("a");
  });
  it("going back from the first item gives the last", () => {
    const items = ["a", "b", "c"];
    expect(wrappedFocus(items, "a", true)).to.equal("c");
  });
  it("from a middle item gives undefined either way", () => {
    const items = ["a", "b", "c"];
    expect(wrappedFocus(items, "b", false)).to.be.undefined;
    expect(wrappedFocus(items, "b", true)).to.be.undefined;
  });
  it("a single item: forward and back both give that same item", () => {
    const items = ["only"];
    expect(wrappedFocus(items, "only", false)).to.equal("only");
    expect(wrappedFocus(items, "only", true)).to.equal("only");
  });
  it("an active element not in the list gives undefined", () => {
    const items = ["a", "b", "c"];
    expect(wrappedFocus(items, null, false)).to.be.undefined;
    expect(wrappedFocus(items, null, true)).to.be.undefined;
    expect(wrappedFocus(items, "body", false)).to.be.undefined;
    expect(wrappedFocus(items, "body", true)).to.be.undefined;
  });
  it("does not modify the list", () => {
    const items = ["a", "b", "c"];
    const before = [...items];
    wrappedFocus(items, "c", false);
    wrappedFocus(items, "a", true);
    expect(items).to.deep.equal(before);
  });
});
