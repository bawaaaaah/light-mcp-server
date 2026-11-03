import { expect } from "chai";
import { flashRate, shouldFreeze, stepSeconds, type RateTiming } from "../web/src/preview-rate.js";
import { isTouchPrimary, prefersReducedMotion } from "../web/src/touch.js";

const timing = (every: RateTiming["every"], order = "loop", attack = 0): RateTiming => ({ every, attack, order });
const steps = (n: number) => Array.from({ length: n }, () => []);

describe("preview before launch: how fast a look flashes", () => {
  it("reads a step in seconds or in beats at the tempo, without dividing by zero", () => {
    expect(stepSeconds(timing({ seconds: 0.25 }), 120)).to.equal(0.25);
    expect(stepSeconds(timing({ beats: 1 }), 120)).to.equal(0.5);
    expect(stepSeconds(timing({ beats: 2 }), 60)).to.equal(2);
    expect(stepSeconds(timing({ beats: 1 }), 0)).to.equal(60); // a tempo of 0 counts as 1 bpm
  });

  it("is the flashes of a loop over its length", () => {
    // 2 flashes over 4 steps of 0.5 s: one a second
    expect(flashRate({ steps: steps(4), flashes: { perLoop: 2, max: 3 } }, timing({ seconds: 0.5 }), 120)).to.equal(1);
    // the cadence follows the tempo: the same look in beats goes twice as fast at 240 bpm
    const preview = { steps: steps(2), flashes: { perLoop: 1, max: 3 } };
    expect(flashRate(preview, timing({ beats: 1 }), 120)).to.equal(1);
    expect(flashRate(preview, timing({ beats: 1 }), 240)).to.equal(2);
  });

  it("divides by the cycle the server counted over (longer than the steps for ping-pong), else by the steps", () => {
    const pingpong = { steps: steps(3), flashes: { perLoop: 2, period: 4, max: 3 } };
    expect(flashRate(pingpong, timing({ seconds: 0.125 }, "pingpong"), 120)).to.equal(4); // 2 flashes / (4 steps × 0.125 s)
    expect(flashRate({ steps: steps(3), flashes: { perLoop: 2, max: 3 } }, timing({ seconds: 0.125 }), 120)).to.be.closeTo(5.3333, 1e-3); // an older server: the steps
  });

  it("is the worst second of the cycle when the server sends its windows, not the average", () => {
    // 5 flashes in the first 10 steps of a cycle of 40 steps of 0.05 s: 2.5 on average, 5 in the worst second
    const windows = Array.from({ length: 41 }, (_, w) => Math.min(5, Math.ceil(w / 2)));
    const burst = { steps: steps(40), flashes: { perLoop: 5, period: 40, windows, max: 3 } };
    expect(flashRate(burst, timing({ seconds: 0.05 }), 120)).to.equal(5);
    expect(flashRate(burst, timing({ seconds: 0.5 }), 120)).to.equal(1); // a second holds 2 steps
    expect(flashRate({ steps: steps(4), flashes: { perLoop: 2, period: 4, windows: [0, 1, 1, 2, 2], max: 3 } }, timing({ seconds: 0.125 }, "pingpong"), 120)).to.equal(4);
    // windows of another length than the cycle are not trusted: the average
    expect(flashRate({ steps: steps(4), flashes: { perLoop: 2, period: 4, windows: [0, 1], max: 3 } }, timing({ seconds: 0.5 }), 120)).to.equal(1);
  });

  it("is 0 when there is nothing to count: no flashes sent (an older server), no step, no duration", () => {
    expect(flashRate({ steps: steps(4) }, timing({ seconds: 0.1 }), 120)).to.equal(0);
    expect(flashRate({ steps: [], flashes: { perLoop: 2, max: 3 } }, timing({ seconds: 0.1 }), 120)).to.equal(0);
    expect(flashRate({ steps: steps(4), flashes: { perLoop: 2, max: 3 } }, timing({ seconds: 0 }), 120)).to.equal(0);
  });

  it("raises a random order to one flash every two steps, but only for a look that flashes", () => {
    const flashing = { steps: steps(8), flashes: { perLoop: 1, max: 3 } };
    expect(flashRate(flashing, timing({ seconds: 0.2 }, "loop"), 120)).to.be.closeTo(0.625, 1e-9); // looped: 1 / (8 × 0.2)
    expect(flashRate(flashing, timing({ seconds: 0.2 }, "random"), 120)).to.be.closeTo(2.5, 1e-9); // 1 / (2 × 0.2): a dark step, then a lit one
    expect(flashRate(flashing, timing({ seconds: 0.2 }, "weighted"), 120)).to.be.closeTo(2.5, 1e-9);
    // a random look that fades has no flash to put back to back
    expect(flashRate({ steps: steps(8), flashes: { perLoop: 0, max: 3 } }, timing({ seconds: 0.2 }, "random", 1), 120)).to.equal(0);
  });

  it("freezes strictly above the ceiling: exactly 3 flashes a second is allowed", () => {
    expect(shouldFreeze(3, 3)).to.equal(false);
    expect(shouldFreeze(3.0001, 3)).to.equal(true);
    expect(shouldFreeze(0, 3)).to.equal(false);
  });
});

describe("preview before launch: a touch screen as the primary pointer", () => {
  it("asks the browser the one query that tells a finger from a mouse", () => {
    const asked: string[] = [];
    const match = (query: string) => (asked.push(query), { matches: true });
    expect(isTouchPrimary(match)).to.equal(true);
    expect(asked).to.deep.equal(["(hover: none), (pointer: coarse)"]);
  });

  it("answers false when the browser says the pointer is a mouse", () => {
    expect(isTouchPrimary(() => ({ matches: false }))).to.equal(false);
  });

  it("answers false where there is no window to ask (a server, a test)", () => {
    expect(isTouchPrimary()).to.equal(false);
  });
});


describe("preview before launch: less motion asked of the system", () => {
  it("asks the browser for prefers-reduced-motion, and follows its answer", () => {
    const asked: string[] = [];
    expect(prefersReducedMotion((query) => (asked.push(query), { matches: true }))).to.equal(true);
    expect(asked).to.deep.equal(["(prefers-reduced-motion: reduce)"]);
    expect(prefersReducedMotion(() => ({ matches: false }))).to.equal(false);
  });

  it("answers false where there is no browser to ask", () => {
    expect(prefersReducedMotion()).to.equal(false);
  });
});
