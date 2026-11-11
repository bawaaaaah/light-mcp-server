import { expect } from "chai";
import { DcaIndex } from "../../../src/plugins/light/show/dca.js";
import { GroupSchema, type Group } from "../../../src/plugins/light/show/model.js";

const group = (id: string, fixtures: string[], groups: string[], level?: number): Group => GroupSchema.parse({ id, name: id, members: { fixtures, groups }, ...(level === undefined ? {} : { master: { level } }) });

/** Fixtures of a group with its sub-groups, as ShowRuntime.fixturesOf reads them. */
function indexOf(groups: Group[]): DcaIndex {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const fixturesOf = (id: string, seen = new Set<string>()): Set<string> => {
    const g = byId.get(id);
    if (!g || seen.has(id)) return new Set();
    seen.add(id);
    return new Set([...g.members.fixtures, ...g.members.groups.flatMap((sub) => [...fixturesOf(sub, seen)])]);
  };
  return new DcaIndex({ groups, isDca: (g) => !!g.master, fixturesOf: (id) => fixturesOf(id), own: (g) => (g.master ? g.master.level : 1) });
}

describe("DCA index: each DCA once (T35)", () => {
  it("finds the DCAs covering a fixture through sub-groups without a master", () => {
    const index = indexOf([group("sub", ["f"], []), group("top", [], ["sub"], 0.5)]);
    expect(index.covering("f")).to.deep.equal(["top"]);
    expect(index.product(index.covering("f"))).to.equal(0.5);
  });

  it("counts a parent reached by two paths once, in the chain and the effective level", () => {
    const index = indexOf([group("a", ["f"], [], 0.8), group("b", ["f"], [], 1), group("p", [], ["a", "b"], 0.5)]);
    expect([...index.covering("f")].sort()).to.deep.equal(["a", "b", "p"]);
    expect(index.product(index.covering("f"))).to.be.closeTo(0.4, 1e-9);
    expect([...index.above(["a", "b"])].sort()).to.deep.equal(["a", "b", "p"]);
    expect(index.effective("a")).to.be.closeTo(0.4, 1e-9);
  });

  it("leaves out the groups asked and stops on a cycle", () => {
    const index = indexOf([group("a", [], ["b"], 0.5), group("b", [], ["a"], 0.5)]);
    expect([...index.chain("a")].sort()).to.deep.equal(["a", "b"]);
    expect([...index.above(["a"], new Set(["b"]))]).to.deep.equal(["a"]);
    expect(index.effective("missing")).to.equal(1);
  });
});
