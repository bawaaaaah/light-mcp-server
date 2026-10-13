import { expect } from "chai";
import { decodePollReply, encodePollReply, portAddress } from "../../../src/plugins/light/output/artnet.js";
import { NodeRegistry } from "../../../src/plugins/light/output/artnet-discovery.js";
import { Ticker, type TickerClock } from "../../../src/plugins/light/engine/ticker.js";

/** Manual clock: timers fire only when advance() passes their due time. */
class FakeClock implements TickerClock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

describe("Art-Net node registry", () => {
  const reply = (ip: string, swOut: number[]) => decodePollReply(encodePollReply({ ip, shortName: ip, longName: ip, swOut }))!;

  it("adds, updates and expires nodes", () => {
    const reg = new NodeRegistry(10_000);
    expect(reg.seen(reply("10.0.0.1", [0]), 0)).to.equal("added");
    expect(reg.seen(reply("10.0.0.1", [0]), 3000)).to.equal("updated");
    reg.seen(reply("10.0.0.2", [1]), 3000);
    expect(reg.expire(12_000).map((n) => n.ip)).to.deep.equal([]);
    expect(reg.expire(13_500).map((n) => n.ip)).to.deep.equal(["10.0.0.1", "10.0.0.2"]);
    expect(reg.list()).to.have.length(0);
  });

  it("finds the nodes outputting a port-address", () => {
    const reg = new NodeRegistry();
    reg.seen(reply("10.0.0.1", [0, 1]), 0);
    reg.seen(reply("10.0.0.2", [1]), 0);
    expect(reg.outputsFor(portAddress(0, 0, 1)).map((n) => n.ip)).to.deep.equal(["10.0.0.1", "10.0.0.2"]);
    expect(reg.outputsFor(portAddress(0, 0, 0)).map((n) => n.ip)).to.deep.equal(["10.0.0.1"]);
  });
});

describe("Ticker", () => {
  it("produces frames at the configured rate without drift", () => {
    const clock = new FakeClock();
    const frames: number[] = [];
    const ticker = new Ticker((t) => frames.push(t), { rateHz: 40, clock });
    ticker.start();
    clock.advance(1000);
    ticker.stop();
    expect(frames.length).to.be.within(40, 41);
    expect(frames[40]).to.be.closeTo(1000, 1e-6);
  });

  it("renders a requested frame immediately, then respects the minimum gap", () => {
    const clock = new FakeClock();
    const frames: { t: number; reason: string }[] = [];
    const ticker = new Ticker((t, reason) => frames.push({ t, reason }), { rateHz: 40, minGapMs: 4, clock });
    ticker.start();
    clock.advance(10); // tick at 0; next regular tick at 25
    ticker.requestFrame();
    clock.advance(0);
    expect(frames.at(-1)).to.deep.equal({ t: 10, reason: "request" });
    ticker.requestFrame();
    ticker.requestFrame(); // coalesced
    clock.advance(5);
    expect(frames.filter((f) => f.reason === "request").map((f) => f.t)).to.deep.equal([10, 14]);
    ticker.stop();
  });

  it("skips a regular tick right after a requested frame", () => {
    const clock = new FakeClock();
    const frames: number[] = [];
    const ticker = new Ticker((t) => frames.push(t), { rateHz: 40, minGapMs: 4, clock });
    ticker.start();
    clock.advance(23);
    ticker.requestFrame();
    clock.advance(0); // request at 23, regular tick due at 25 is skipped
    clock.advance(30);
    ticker.stop();
    expect(frames).to.deep.equal([0, 23, 50]);
  });
});
