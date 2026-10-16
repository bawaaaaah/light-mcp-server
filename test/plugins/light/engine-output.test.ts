import { expect } from "chai";
import { decodeDmx, decodePollReply, encodeDmx, encodePollReply, portAddress } from "../../../src/plugins/light/output/artnet.js";
import { OutputRouter } from "../../../src/plugins/light/output/output-router.js";
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

describe("sharing the nodes with another console", () => {
  const dmx = (pa: number) => encodeDmx({ sequence: 1, physical: 0, portAddress: pa, data: new Uint8Array(512) });

  it("reads the nodes' « merging » flag per output port", () => {
    const r = decodePollReply(encodePollReply({ ip: "192.0.2.20", shortName: "n", longName: "n", swOut: [0, 1], merging: [false, true] }))!;
    expect(r.outputAddresses).to.deep.equal([0, 1]);
    expect(r.merging).to.deep.equal([1]);
  });

  it("tells its own packets (echoed by the broadcast) from another instance on the same machine and port", () => {
    const router = new OutputRouter({ routes: [{ universe: 1, artnet: { portAddress: 0, targets: ["192.0.2.30"] } }] });
    const frame = new Uint8Array(512);
    frame[0] = 200;
    router.sendFrame([frame], 1000);
    const ours = encodeDmx({ sequence: 1, physical: 0, portAddress: 0, data: frame });
    router.received(ours, "127.0.0.1", 6454, 1100); // our own broadcast, back to us
    expect(router.foreignSources(1200)).to.deep.equal([]);
    const twin = encodeDmx({ sequence: 1, physical: 0, portAddress: 0, data: new Uint8Array(512) });
    router.received(twin, "127.0.0.1", 6454, 1100); // another instance on this computer, same port
    expect(router.foreignSources(1200)).to.deep.include({ ip: "127.0.0.1", port: 6454, portAddresses: [0], lastSeen: 1100, local: true });
    router.received(ours, "127.0.0.1", 6454, 4000); // the same bytes long after: not an echo any more
    expect(router.foreignSources(4000).map((f) => f.ip)).to.deep.equal(["127.0.0.1"]);
  });

  it("notices another controller sending Art-Net, and forgets it when it stops", () => {
    const router = new OutputRouter({ routes: [] });
    router.received(dmx(0), "192.0.2.10", 6454, 1000);
    router.received(dmx(1), "192.0.2.10", 6454, 1500);
    router.received(dmx(0), "127.0.0.1", 6454, 1500); // another program on this machine
    router.received(Buffer.from("not art-net"), "192.0.2.11", 6454, 1500);
    expect(router.foreignSources(2000).map((f) => [f.ip, f.portAddresses])).to.deep.equal([
      ["192.0.2.10", [0, 1]],
      ["127.0.0.1", [0]],
    ]);
    expect(router.foreignSources(5000)).to.deep.equal([]);
  });

  it("leaves with a neutral all-zero frame, sends nothing on standby, and everything again when it ends", () => {
    const router = new OutputRouter({ routes: [{ universe: 1, artnet: { portAddress: 0, targets: ["192.0.2.30"] } }] });
    const sent: number[][] = [];
    (router as unknown as { send: (s: unknown, b: Buffer, p: number, h: string) => void }).send = (_s, b) => void sent.push([...decodeDmx(b)!.data.slice(0, 2)]);
    const frame = [new Uint8Array(512).fill(200)];
    router.sendFrame(frame, 0);
    router.setStandby(true, 5);
    expect(sent).to.deep.equal([[200, 200], [0, 0], [0, 0], [0, 0]]);
    router.sendFrame(frame, 10);
    router.sendFrame(frame, 5000); // not even a keep-alive
    expect(sent).to.have.length(4);
    router.setStandby(true, 6000); // already on standby: no new zeros
    expect(sent).to.have.length(4);
    router.setStandby(false);
    router.sendFrame(frame, 6010);
    expect(sent.at(-1)).to.deep.equal([200, 200]);
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
