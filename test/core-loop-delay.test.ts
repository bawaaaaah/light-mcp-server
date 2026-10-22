import { expect } from "chai";
import { LoopDelay } from "../src/core/loop-delay.js";

describe("event loop delay", () => {
  it("keeps the worst stall of the last hour", () => {
    const d = new LoopDelay();
    expect(d.stats()).to.deep.equal({ p50: 0, p99: 0, max: 0, worst: null });
    d.record(3, 0);
    d.record(42, 60_000);
    d.record(5, 120_000);
    expect(d.stats().worst).to.deep.equal({ ms: 42, at: 60_000 });
    d.record(4, 60_000 + 3_600_001); // an hour later: that stall is forgotten
    expect(d.stats().worst).to.deep.equal({ ms: 5, at: 120_000 });
  });

  it("measures the running loop", async () => {
    const d = new LoopDelay(100);
    d.start();
    await new Promise((r) => setTimeout(r, 30));
    const until = Date.now() + 80;
    while (Date.now() < until); // an 80 ms stall
    await new Promise((r) => setTimeout(r, 250));
    d.stop();
    expect(d.stats().worst!.ms).to.be.greaterThan(40);
  });
});
