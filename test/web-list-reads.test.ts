import { expect } from "chai";
import { dropReads, latestRead, type ReadList, type ReadRetry } from "../web/src/list-reads.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const counters = (): Record<ReadList, number> => ({ looks: 0, groups: 0, faders: 0, snapshots: 0, folders: 0 });
/** A clock run by hand: the retries wait until the test runs them. */
function retrying() {
  const waiting: { fn: () => void; ms: number }[] = [];
  const errors: string[] = [];
  const retry: ReadRetry = { onError: (e) => errors.push(e.message), delayMs: 500, later: (fn, ms) => waiting.push({ fn, ms }) };
  return { retry, waiting, errors, tick: () => waiting.splice(0).forEach((w) => w.fn()) };
}

describe("list reads", () => {
  it("applies a read only if no newer read of the same list started meanwhile", async () => {
    const c = counters();
    const { retry } = retrying();
    const applied: string[] = [];
    let first!: (v: string) => void;
    latestRead(c, "looks", () => new Promise<string>((r) => (first = r)), (v) => applied.push(v), retry);
    latestRead(c, "looks", () => Promise.resolve("new"), (v) => applied.push(v), retry);
    latestRead(c, "groups", () => Promise.resolve("groups"), (v) => applied.push(v), retry);
    first("old");
    await flush();
    expect(applied).to.deep.equal(["new", "groups"]);
  });

  it("tries a failed read once more after a short wait, then says it", async () => {
    const c = counters();
    const { retry, waiting, errors, tick } = retrying();
    let calls = 0;
    const applied: string[] = [];
    latestRead(c, "groups", () => (++calls === 1 ? Promise.reject(new Error("down")) : Promise.resolve("back")), (v) => applied.push(v), retry);
    await flush();
    expect([calls, waiting.map((w) => w.ms), errors]).to.deep.equal([1, [500], []]);
    tick();
    await flush();
    expect([calls, applied, errors]).to.deep.equal([2, ["back"], []]); // the second try read it

    latestRead(c, "faders", () => Promise.reject(new Error("still down")), (v) => applied.push(String(v)), retry);
    await flush();
    tick();
    await flush();
    expect(errors).to.deep.equal(["still down"]); // twice: said, once
  });

  it("drops a failed read overtaken by a newer one: the newer one decides", async () => {
    const c = counters();
    const { retry, waiting, errors, tick } = retrying();
    const applied: string[] = [];
    latestRead(c, "looks", () => Promise.reject(new Error("old")), (v) => applied.push(v), retry);
    await flush();
    latestRead(c, "looks", () => Promise.resolve("new"), (v) => applied.push(v), retry); // while the first waits to retry
    await flush();
    tick();
    await flush();
    expect([applied, errors, waiting]).to.deep.equal([["new"], [], []]);
  });

  it("drops a second try overtaken while it waits: a newer read decides", async () => {
    const c = counters();
    const { retry, waiting, errors, tick } = retrying();
    let tries = 0;
    const applied: string[] = [];
    latestRead(c, "groups", () => (tries++, Promise.reject(new Error("old"))), (v) => applied.push(v), retry);
    await flush();
    expect(waiting).to.have.length(1); // its second try waits
    latestRead(c, "groups", () => Promise.resolve("new"), (v) => applied.push(v), retry);
    await flush();
    tick(); // the old second try comes due: overtaken, it reads nothing
    await flush();
    expect([tries, applied, errors]).to.deep.equal([1, ["new"], []]);
  });

  it("says a rejection that is not an Error", async () => {
    const c = counters();
    const { retry, errors, tick } = retrying();
    latestRead(c, "looks", () => Promise.reject("offline" as unknown as Error), () => undefined, retry);
    await flush();
    tick();
    await flush();
    expect(errors).to.deep.equal(["offline"]);
  });

  it("drops every read under way when the page leaves: nothing applied, tried again or said", async () => {
    const c = counters();
    const { retry, waiting, errors, tick } = retrying();
    let tries = 0;
    const applied: string[] = [];
    let answer!: (v: string) => void;
    latestRead(c, "looks", () => new Promise<string>((r) => (answer = r)), (v) => applied.push(v), retry);
    latestRead(c, "groups", () => (tries++, Promise.reject(new Error("down"))), (v) => applied.push(v), retry);
    await flush();
    expect(waiting).to.have.length(1);
    dropReads(c);
    answer("late");
    tick();
    await flush();
    expect([applied, tries, errors]).to.deep.equal([[], 1, []]);
  });
});
