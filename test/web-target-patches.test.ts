import { expect } from "chai";
import { keepPatched, type PointPatch } from "../web/src/target-patches.js";

type P = { x: number };
const row = (id: string, x: number) => ({ id, name: id, point: { x } });

/** The target pad (T24, lot 4): a list read before the last target.set never moves the pad back. */
describe("targets store: the points target.set answered against the lists", () => {
  it("a list started before the patch keeps the patched point and asks for another read", () => {
    const patches = new Map<string, PointPatch<P>>([["a", { read: 3, point: { x: 9 } }]]);
    const r = keepPatched([row("a", 1), row("b", 2)], 3, patches);
    expect(r.list.map((x) => x.point.x)).to.deep.equal([9, 2]);
    expect(r.stale).to.equal(true);
    expect([...r.patches.keys()]).to.deep.equal(["a"]);
  });

  it("a list started after the patch is trusted, the patch dropped", () => {
    const patches = new Map<string, PointPatch<P>>([["a", { read: 3, point: { x: 9 } }]]);
    const r = keepPatched([row("a", 5)], 4, patches);
    expect(r.list[0]!.point.x).to.equal(5);
    expect(r.stale).to.equal(false);
    expect(r.patches.size).to.equal(0);
  });

  it("the patch of a target gone is dropped; a row without a patch is kept as it is", () => {
    const patches = new Map<string, PointPatch<P>>([["gone", { read: 7, point: { x: 1 } }]]);
    const b = row("b", 2);
    const r = keepPatched([b], 7, patches);
    expect(r.list[0]).to.equal(b);
    expect(r.stale).to.equal(false);
    expect(r.patches.size).to.equal(0);
  });
});
