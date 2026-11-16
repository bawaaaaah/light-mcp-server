import { expect } from "chai";
import { LookPlayer, stepSequence, TimingSchema } from "../../../src/plugins/light/engine/player.js";
import { rng } from "../../../src/plugins/light/engine/techniques.js";

/** The draw `LookPlayer` made before `stepSequence` was extracted (T28, lot 1): the reference the sequence must match. */
function legacy(order: string, n: number, seed: number, weights?: number[]): (i: number) => number {
  const cache = new Map<number, number>();
  const next = rng(seed);
  const w = weights?.length === n ? weights : undefined;
  const total = w?.reduce((a, b) => a + b, 0) ?? n;
  const random = (i: number) => {
    while (!cache.has(i)) {
      const k = cache.size;
      let pick: number;
      if (w && order === "weighted") {
        let x = next() * total;
        pick = 0;
        while (pick < n - 1 && x >= w[pick]!) x -= w[pick++]!;
      } else {
        pick = Math.floor(next() * n);
        if (n > 1 && k > 0 && pick === cache.get(k - 1)) pick = (pick + 1) % n;
      }
      cache.set(k, pick);
    }
    return cache.get(i)!;
  };
  return (i) => {
    if (n === 1) return 0;
    if (order === "loop") return i % n;
    if (order === "pingpong") {
      const period = 2 * n - 2;
      const p = i % period;
      return p < n ? p : period - p;
    }
    return random(i);
  };
}

describe("step sequence (T28, lot 1)", () => {
  const orders = ["loop", "pingpong", "random", "weighted"] as const;

  it("gives exactly the sequences the look player drew before", () => {
    for (const order of orders)
      for (const n of [1, 2, 3, 5])
        for (const seed of [1, 42, 0x7fffffff]) {
          const weights = order === "weighted" ? Array.from({ length: n }, (_, k) => k + 1) : undefined;
          const ref = legacy(order, n, seed, weights);
          const seq = stepSequence({ order, n, weights, seed });
          const got = Array.from({ length: 200 }, (_, i) => seq(i));
          expect(got, `${order} n=${n} seed=${seed}`).to.deep.equal(Array.from({ length: 200 }, (_, i) => ref(i)));
        }
  });

  it("is what LookPlayer.stepAt plays", () => {
    const steps = [[null], [null], [null], [null]];
    for (const order of orders) {
      const timing = TimingSchema.parse({ order, weights: [1, 2, 3, 4] });
      const player = new LookPlayer(steps, timing, 1234);
      const seq = stepSequence({ order, n: 4, weights: timing.weights, seed: 1234 });
      for (let i = 0; i < 100; i++) expect(player.stepAt(i)).to.equal(seq(i));
    }
  });

  it("replays the same draws in any reading order (memoised), and never repeats an item twice in a row out of weighted", () => {
    const a = stepSequence({ order: "random", n: 3, seed: 9 });
    const b = stepSequence({ order: "random", n: 3, seed: 9 });
    const late = a(500);
    const forward = Array.from({ length: 501 }, (_, i) => b(i));
    expect(forward[500]).to.equal(late);
    for (let i = 1; i < forward.length; i++) expect(forward[i]).to.not.equal(forward[i - 1]);
  });

  it("reads a negative or fractional index as its floor, never below the start", () => {
    const seq = stepSequence({ order: "random", n: 4, seed: 3 });
    expect(seq(-5)).to.equal(seq(0));
    expect(seq(2.7)).to.equal(seq(2));
    expect(stepSequence({ order: "loop", n: 3, seed: 0 })(-1)).to.equal(2);
  });
});
