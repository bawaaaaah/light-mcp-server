import { expect } from "chai";
import { alertLines, cleared, dismissed, dropReads, failed, latestRead, sentence, started, type ReadList, type ReadRetry, type ReadStates } from "../web/src/list-reads.js";

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

  describe("what is said of the failed reads", () => {
    it("says a failure until its list is read; a list read leaves the others' failures", () => {
      let s: ReadStates = started({}, "groups");
      expect(s.groups).to.deep.equal({ reading: true });
      s = failed(failed(s, "groups", "down"), "looks", "down");
      expect(s.groups).to.deep.equal({ reading: false, failure: { message: "down", dismissed: false } });
      s = started(s, "groups"); // read again: under way, and still said
      expect(s.groups).to.deep.equal({ reading: true, failure: { message: "down", dismissed: false } });
      s = cleared(s, "groups");
      expect(s.groups).to.equal(undefined);
      expect(s.looks?.failure?.message).to.equal("down");
      expect(cleared(s, "faders")).to.equal(s); // nothing to clear: the same state
    });

    it("keeps a failure closed by ✕ closed while it stays the same, and says it again once it changes", () => {
      let s = failed({}, "groups", "Failed to fetch");
      s = dismissed(s, ["groups"]);
      expect(alertLines(s)).to.deep.equal([]);
      s = failed(started(s, "groups"), "groups", "Failed to fetch"); // a look pressed: read again, failed again
      expect(alertLines(s)).to.deep.equal([]);
      s = failed(s, "groups", "server error");
      expect(alertLines(s)).to.deep.equal([{ lists: ["groups"], message: "server error" }]);
      s = failed(dismissed(cleared(s, "groups"), ["groups"]), "groups", "server error"); // read, then failing anew
      expect(alertLines(s)).to.have.length(1);
    });

    it("says one line per message, its lists in order: a server away once for all", () => {
      const lists: ReadList[] = ["snapshots", "looks", "faders"];
      let s: ReadStates = {};
      for (const l of lists) s = failed(s, l, "Failed to fetch");
      s = failed(s, "folders", "other");
      expect(alertLines(s)).to.deep.equal([
        { lists: ["looks", "faders", "snapshots"], message: "Failed to fetch" },
        { lists: ["folders"], message: "other" },
      ]);
    });

    it("ends a message with one point", () => {
      expect([sentence("down"), sentence("down."), sentence("down. ")]).to.deep.equal(["down.", "down.", "down."]);
    });
  });
});
