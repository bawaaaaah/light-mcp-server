import { expect } from "chai";
import { alertLines, cleared, dismissed, dropReads, failed, failuresTogether, latestRead, sentence, started, type ReadList, type ReadRetry, type ReadStates } from "../web/src/list-reads.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const counters = (): Record<ReadList, number> => ({ looks: 0, groups: 0, faders: 0, snapshots: 0, folders: 0 });
/** A clock run by hand: the retries wait until the test runs them. */
function retrying() {
  const waiting: { fn: () => void; ms: number }[] = [];
  const errors: string[] = [];
  const retry: ReadRetry = { failures: { fail: (_list, message) => errors.push(message), drop: () => undefined }, delayMs: 500, later: (fn, ms) => (waiting.push({ fn, ms }), () => undefined) };
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

  describe("the failures of one refresh, said together", () => {
    /** A clock run by hand, whose waits can be cancelled. */
    function clock() {
      let now = 0;
      const timers: { at: number; fn: () => void; live: boolean }[] = [];
      const later = (fn: () => void, ms: number) => {
        const t = { at: now + ms, fn, live: true };
        timers.push(t);
        return () => (t.live = false);
      };
      const advance = (ms: number) => {
        now += ms;
        for (const t of timers) if (t.live && t.at <= now) (t.live = false), t.fn();
      };
      return { later, advance };
    }
    /** The page: its read states, changed by the batch as the page does. */
    function page() {
      const c = clock();
      let s: ReadStates = {};
      let updates = 0;
      const together = failuresTogether((batch) => ((updates += 1), (s = batch.reduce((next, [l, m]) => failed(next, l, m), s))), { delayMs: 150, later: c.later });
      return { ...c, together, state: () => s, set: (f: (s: ReadStates) => ReadStates) => (s = f(s)), updates: () => updates };
    }

    it("says two failures 50 ms apart in one update", () => {
      const p = page();
      p.set((s) => started(started(s, "groups"), "faders"));
      p.together.fail("groups", "down");
      p.advance(50);
      p.together.fail("faders", "down");
      p.advance(149);
      expect(p.updates()).to.equal(0); // the wait started again with the second
      p.advance(1);
      expect(p.updates()).to.equal(1);
      expect(alertLines(p.state())).to.deep.equal([{ lists: ["groups", "faders"], message: "down" }]);
    });

    it("says nothing of a failure whose list is read again, and read, before the wait ends", () => {
      const p = page();
      p.together.fail("groups", "down");
      p.advance(50);
      p.together.drop("groups"); // read again
      p.set((s) => cleared(started(s, "groups"), "groups")); // and read
      p.advance(500);
      expect([p.updates(), alertLines(p.state())]).to.deep.equal([0, []]);
    });

    it("keeps a list reading when its old failure's wait ends during a new read", () => {
      const p = page();
      p.together.fail("groups", "down");
      p.together.drop("groups");
      p.set((s) => started(s, "groups"));
      p.advance(500);
      expect(p.state().groups).to.deep.equal({ reading: true });
    });

    it("drops a list's failure still waiting when a read of that list starts", async () => {
      const p = page();
      const c = counters();
      const retry: ReadRetry = { failures: p.together, delayMs: 0, later: (fn) => (fn(), () => undefined) };
      latestRead(c, "groups", () => Promise.reject(new Error("down")), () => undefined, retry);
      await flush();
      await flush();
      p.advance(50); // failed twice, waiting to be said
      latestRead(c, "groups", () => new Promise<never>(() => undefined), () => undefined, retry); // read again, still under way
      p.advance(500);
      expect(p.updates()).to.equal(0);
    });

    it("keeps the other lists' failures when one list is read again", () => {
      const said: [ReadList, string][][] = [];
      const c = clock();
      const together = failuresTogether((batch) => said.push(batch), { delayMs: 150, later: c.later });
      together.fail("groups", "down");
      together.fail("faders", "down");
      c.advance(100);
      together.drop("groups");
      c.advance(50);
      expect(said).to.deep.equal([[["faders", "down"]]]);
    });

    it("says only what fails after a cancel, not what it dropped", () => {
      const said: [ReadList, string][][] = [];
      const c = clock();
      const together = failuresTogether((batch) => said.push(batch), { delayMs: 150, later: c.later });
      together.fail("looks", "down");
      together.cancel();
      together.fail("groups", "down");
      c.advance(150);
      expect(said).to.deep.equal([[["groups", "down"]]]);
    });

    it("says nothing once cancelled (the page left)", () => {
      const p = page();
      p.together.fail("looks", "down");
      p.together.cancel();
      p.advance(500);
      expect(p.updates()).to.equal(0);
    });
  });
});
