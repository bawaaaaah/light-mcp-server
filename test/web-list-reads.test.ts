import { expect } from "chai";
import { latestRead, type ReadList } from "../web/src/list-reads.js";

describe("list reads", () => {
  it("applies a read only if no newer read of the same list started meanwhile", async () => {
    const counters: Record<ReadList, number> = { looks: 0, groups: 0, faders: 0, snapshots: 0, folders: 0 };
    const applied: string[] = [];
    let first!: (v: string) => void;
    latestRead(counters, "looks", new Promise<string>((r) => (first = r)), (v) => applied.push(v));
    latestRead(counters, "looks", Promise.resolve("new"), (v) => applied.push(v));
    latestRead(counters, "groups", Promise.resolve("groups"), (v) => applied.push(v));
    first("old");
    latestRead(counters, "faders", Promise.reject(new Error("down")), (v) => applied.push(String(v))); // a failed read: nothing
    await new Promise((r) => setTimeout(r, 0));
    expect(applied).to.deep.equal(["new", "groups"]);
  });
});
