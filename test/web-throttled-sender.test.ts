import { expect } from "chai";
import { createThrottledSender, SEND_INTERVAL_MS } from "../web/src/throttled-sender.js";

/** A clock and timers moved by hand: what the loop waits for, and when. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    clock: {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => {
        const id = next++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimer: (id: number) => void timers.delete(id),
    },
    timers,
    /** Moves the time on by `ms`, running the timers due on the way. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A writer that records each write with its time and settles only when told. */
function recorder(clock: { now: () => number }) {
  const writes: { value: unknown; at: number; done: () => void }[] = [];
  const write = (value: unknown) =>
    new Promise<void>((resolve) => {
      writes.push({ value, at: clock.now(), done: resolve });
    });
  return { writes, write };
}

/** The pads' send loop (T24, lot 4): latest wins, merge, one write in flight, 40 ms apart, drop, flush on unmount. */
describe("throttled sender (pads)", () => {
  it("sends the first value at once, then the latest only, at least 40 ms after the previous write started", async () => {
    const c = fakeClock();
    const r = recorder(c.clock);
    const s = createThrottledSender<number, number>(r.write, c.clock);
    s.send(1);
    await settle();
    expect(r.writes.map((w) => w.value)).to.deep.equal([1]);
    r.writes[0]!.done();
    await settle();
    for (const v of [2, 3, 4]) s.send(v);
    await settle();
    expect(r.writes).to.have.length(1); // within the interval: waits
    await c.advance(SEND_INTERVAL_MS);
    expect(r.writes.map((w) => [w.value, w.at])).to.deep.equal([
      [1, 0],
      [4, 40],
    ]);
  });

  it("keeps one write in flight: a slow link never builds a queue, the latest value goes when it settles", async () => {
    const c = fakeClock();
    const r = recorder(c.clock);
    let settled = 0;
    const s = createThrottledSender<number, number>(r.write, c.clock, { onSettled: () => settled++ });
    s.send(1);
    await settle();
    for (const v of [2, 3]) s.send(v);
    await c.advance(500); // the first write still on the wire
    expect(r.writes.map((w) => w.value)).to.deep.equal([1]);
    expect(s.idle()).to.equal(false);
    r.writes[0]!.done();
    await settle();
    expect(settled).to.equal(1);
    expect(r.writes.map((w) => w.value)).to.deep.equal([1, 3]); // the interval is long past: at once
    r.writes[1]!.done();
    await settle();
    expect(s.idle()).to.equal(true);
  });

  it("merges a new value into the pending one when asked (a pad's x/y and its Z fader)", async () => {
    const c = fakeClock();
    const r = recorder(c.clock);
    const s = createThrottledSender<Record<string, number>, number>(r.write, c.clock, { merge: (a, b) => ({ ...a, ...b }) });
    s.send({ x: 1 });
    await settle();
    r.writes[0]!.done();
    s.send({ x: 2 });
    s.send({ z: 3 });
    await c.advance(SEND_INTERVAL_MS);
    expect(r.writes.map((w) => w.value)).to.deep.equal([{ x: 1 }, { x: 2, z: 3 }]);
  });

  it("never writes two values less than 40 ms apart, however fast they come", async () => {
    const c = fakeClock();
    const r = recorder(c.clock);
    const s = createThrottledSender<number, number>(r.write, c.clock);
    for (let i = 0; i < 100; i++) {
      s.send(i);
      await c.advance(3);
      for (const w of r.writes) w.done();
    }
    await c.advance(100);
    const at = r.writes.map((w) => w.at);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).to.be.at.least(SEND_INTERVAL_MS);
    expect(r.writes.at(-1)!.value).to.equal(99); // the last value always goes out
  });

  it("drop forgets the pending value and waits for the write on the wire", async () => {
    const c = fakeClock();
    const r = recorder(c.clock);
    const s = createThrottledSender<number, number>(r.write, c.clock);
    s.send(1);
    await settle();
    s.send(2);
    let dropped = false;
    void s.drop().then(() => (dropped = true));
    await settle();
    expect(dropped).to.equal(false);
    r.writes[0]!.done();
    await settle();
    expect(dropped).to.equal(true);
    await c.advance(100);
    expect(r.writes.map((w) => w.value)).to.deep.equal([1]);
    expect(c.timers.size).to.equal(0);
  });

  it("flush (the pad unmounted) sends the pending value without waiting for the interval, and sets no timer", async () => {
    const c = fakeClock();
    const r = recorder(c.clock);
    const s = createThrottledSender<number, number>(r.write, c.clock);
    s.send(1);
    await settle();
    r.writes[0]!.done();
    await settle();
    s.send(2);
    expect(c.timers.size).to.equal(1);
    s.flush();
    await settle();
    expect(c.timers.size).to.equal(0);
    expect(r.writes.map((w) => [w.value, w.at])).to.deep.equal([
      [1, 0],
      [2, 0],
    ]);
  });

  it("a failed write does not stop the loop", async () => {
    const c = fakeClock();
    const values: number[] = [];
    const s = createThrottledSender<number, number>(async (v) => {
      values.push(v);
      if (v === 1) throw new Error("refused");
    }, c.clock);
    s.send(1);
    await settle();
    s.send(2);
    await c.advance(SEND_INTERVAL_MS);
    expect(values).to.deep.equal([1, 2]);
  });
});
