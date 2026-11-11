import { expect } from "chai";
import { decodeDmx, decodePollReply, encodeDmx, encodePollReply, portAddress } from "../../../src/plugins/light/output/artnet.js";
import { OutputRouter } from "../../../src/plugins/light/output/output-router.js";
import { MISDIRECTED_GRACE_MS, NodeRegistry, artnetDestinations, coverage } from "../../../src/plugins/light/output/artnet-discovery.js";
import { broadcastOf, isBroadcast, onSubnet, outOfSubnet } from "../../../src/plugins/light/output/subnet.js";
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

describe("Art-Net destinations", () => {
  const outputs = [{ ip: "192.0.2.1" }, { ip: "192.0.2.1" }, { ip: "192.0.2.2" }]; // a two-port node answers twice
  const bcast = "192.0.2.255";

  it("auto: the nodes announcing the address, once each; broadcast when none, unless turned off", () => {
    expect(artnetDestinations({ portAddress: 0 }, outputs, bcast)).to.deep.equal(["192.0.2.1", "192.0.2.2"]);
    expect(artnetDestinations({ portAddress: 0, send: "auto" }, [], bcast)).to.deep.equal([bcast]);
    expect(artnetDestinations({ portAddress: 0, broadcast: false }, [], bcast)).to.deep.equal([]);
  });

  it("broadcast: the whole network, even with nodes announcing the address", () => {
    expect(artnetDestinations({ portAddress: 0, send: "broadcast", targets: ["192.0.2.9"] }, outputs, bcast)).to.deep.equal([bcast]);
  });

  it("nodes: only the chosen IPs, never another node nor the broadcast; none chosen sends nothing", () => {
    expect(artnetDestinations({ portAddress: 0, send: "nodes", targets: ["192.0.2.9", "192.0.2.9"] }, outputs, bcast)).to.deep.equal(["192.0.2.9"]);
    expect(artnetDestinations({ portAddress: 0, send: "nodes" }, outputs, bcast)).to.deep.equal([]);
    // a route saved before the choice existed goes to its targets
    expect(artnetDestinations({ portAddress: 0, targets: ["192.0.2.9"] }, outputs, bcast)).to.deep.equal(["192.0.2.9"]);
  });

  it("the router sends each frame where the route says, and coverage trusts the chosen nodes", () => {
    const router = new OutputRouter({
      bindAddress: "127.0.0.1",
      routes: [
        { universe: 1, artnet: { portAddress: 0, send: "nodes", targets: ["192.0.2.30"] } },
        { universe: 2, artnet: { portAddress: 1, send: "nodes" } },
        { universe: 3, sacn: { universe: 3, unicast: ["192.0.2.40"] } },
      ],
    });
    router.registry.seen(decodePollReply(encodePollReply({ ip: "192.0.2.50", shortName: "all", longName: "answers every address", swOut: [0, 1] }))!, Date.now());
    const hosts: string[] = [];
    (router as unknown as { send: (s: unknown, b: Buffer, p: number, h: string) => void }).send = (_s, _b, _p, h) => void hosts.push(h);
    router.sendFrame([new Uint8Array(512), new Uint8Array(512), new Uint8Array(512)], 0);
    expect(hosts).to.deep.equal(["192.0.2.30", "192.0.2.40"]);
    expect(router.destinations()).to.deep.equal([
      { universe: 1, artnet: ["192.0.2.30"] },
      { universe: 2, artnet: [] },
      { universe: 3, sacn: ["192.0.2.40"] },
    ]);
    expect(coverage(router.getConfig().routes, router.registry.list()).unheard).to.deep.equal([]);
  });
});

describe("a route aimed at a node that discovery has not seen", () => {
  const node = (ip: string, swOut: number[], name = "node") => decodePollReply(encodePollReply({ ip, shortName: name, longName: name, swOut }))!;
  const known = (...replies: ReturnType<typeof node>[]) => {
    const registry = new NodeRegistry();
    for (const r of replies) registry.seen(r, 0);
    return registry.list();
  };
  const route = { universe: 1, artnet: { portAddress: 0, send: "nodes" as const, targets: ["192.0.2.30"] } };

  it("reports the node that outputs the address when no target answers discovery", () => {
    const c = coverage([route], known(node("198.51.100.7", [0], "lyre")));
    expect(c.misdirected).to.deep.equal([{ universe: 1, portAddress: 0, targets: ["192.0.2.30"], nodes: [{ key: "198.51.100.7#1", ip: "198.51.100.7", shortName: "lyre" }] }]);
  });

  it("stays quiet when a target is seen, when no node outputs the address, or in another mode", () => {
    expect(coverage([route], known(node("192.0.2.30", [0]))).misdirected).to.deep.equal([]);
    expect(coverage([route], known(node("198.51.100.7", [5]))).misdirected).to.deep.equal([]);
    expect(coverage([{ universe: 1, artnet: { portAddress: 0, send: "auto" as const } }], known(node("198.51.100.7", [0]))).misdirected).to.deep.equal([]);
    expect(coverage([route], []).misdirected).to.deep.equal([]);
  });

  it("waits a few polls after discovery started before calling a target unseen: discovery may be slow", () => {
    const nodes = known(node("198.51.100.7", [0], "lyre"));
    const watch = (nowMs: number) => ({ nowMs, discoverySince: 1000 });
    expect(coverage([route], nodes, watch(1000 + MISDIRECTED_GRACE_MS - 1)).misdirected).to.deep.equal([]);
    expect(coverage([route], nodes, watch(1000 + MISDIRECTED_GRACE_MS)).misdirected).to.have.length(1);
    // discovery not running: nothing to judge by
    expect(coverage([route], nodes, { nowMs: 1e9 }).misdirected).to.deep.equal([]);
  });

  it("a target that never answers ArtPoll stays quiet until the delay after its route changed", () => {
    const nodes = known(node("198.51.100.7", [0], "lyre"));
    const changedAt = (u: number) => (u === 1 ? 50_000 : undefined);
    expect(coverage([route], nodes, { nowMs: 55_000, discoverySince: 0, changedAt }).misdirected).to.deep.equal([]);
    expect(coverage([route], nodes, { nowMs: 50_000 + MISDIRECTED_GRACE_MS, discoverySince: 0, changedAt }).misdirected.map((m) => m.targets)).to.deep.equal([["192.0.2.30"]]);
  });

  it("never calls a broadcast target unseen: the x.x.x.255 of a network, the limited broadcast, the interface's", () => {
    const nodes = known(node("198.51.100.7", [0], "lyre"));
    const aimed = (ip: string) => [{ universe: 1, artnet: { portAddress: 0, send: "nodes" as const, targets: [ip] } }];
    expect(coverage(aimed("192.0.2.255"), nodes).misdirected).to.deep.equal([]);
    expect(coverage(aimed("255.255.255.255"), nodes).misdirected).to.deep.equal([]);
    const subnets = [{ address: "203.0.113.20", netmask: "255.255.255.128" }];
    expect(coverage(aimed("203.0.113.127"), nodes, { nowMs: 1e6, discoverySince: 0, isBroadcast: (ip) => isBroadcast(ip, subnets) }).misdirected).to.deep.equal([]);
    expect(coverage(aimed("203.0.113.126"), nodes, { nowMs: 1e6, discoverySince: 0, isBroadcast: (ip) => isBroadcast(ip, subnets) }).misdirected).to.have.length(1);
  });

  it("lists every node outputting the address, and stays quiet while the target itself is seen beside another one", () => {
    const two = known(node("198.51.100.7", [0], "lyre"), node("198.51.100.8", [0], "barre"));
    expect(coverage([route], two).misdirected[0]!.nodes.map((n) => n.ip)).to.deep.equal(["198.51.100.7", "198.51.100.8"]);
    expect(coverage([route], known(node("192.0.2.30", [0], "cible"), node("198.51.100.7", [0], "lyre"))).misdirected).to.deep.equal([]);
  });

  it("the router waits after discovery starts and after a route changes, on its own monotonic clock", () => {
    let now = 0;
    const router = new OutputRouter({ routes: [route] }, undefined, () => now);
    (router as unknown as { discoverySince: number }).discoverySince = 0; // as start() sets it, without a socket
    router.registry.seen(node("198.51.100.7", [0], "lyre"), 0);
    now = MISDIRECTED_GRACE_MS;
    expect(router.coverage().misdirected).to.have.length(1);
    router.setRoutes([{ universe: 1, artnet: { portAddress: 0, send: "nodes", targets: ["192.0.2.31"] } }]);
    expect(router.coverage().misdirected).to.deep.equal([]); // just chosen: give it its polls
    now += MISDIRECTED_GRACE_MS;
    expect(router.coverage().misdirected.map((m) => m.targets)).to.deep.equal([["192.0.2.31"]]);
  });
});

describe("local subnets", () => {
  const subnets = [{ address: "192.0.2.10", netmask: "255.255.255.0" }, { address: "127.0.0.1", netmask: "255.0.0.0" }];

  it("tells an address on one of the machine's subnets from one out of reach", () => {
    expect(onSubnet("192.0.2.77", subnets)).to.equal(true);
    expect(onSubnet("198.51.100.7", subnets)).to.equal(false);
    expect(onSubnet("not an ip", subnets)).to.equal(false);
  });

  it("has no broadcast on a /31 or /32, and does not judge reach from a /32 interface", () => {
    expect(broadcastOf({ address: "10.0.0.1", netmask: "255.255.255.254" })).to.equal(undefined);
    expect(broadcastOf({ address: "10.0.0.1", netmask: "255.255.255.255" })).to.equal(undefined);
    expect(isBroadcast("10.0.0.1", [{ address: "10.0.0.1", netmask: "255.255.255.255" }])).to.equal(false);
    expect(outOfSubnet(["198.51.100.7"], [{ address: "10.0.0.1", netmask: "255.255.255.255" }])).to.deep.equal([]);
    expect(outOfSubnet(["198.51.100.7"], [{ address: "10.0.0.1", netmask: "255.255.255.255" }, ...subnets])).to.deep.equal(["198.51.100.7"]);
  });

  it("never calls a broadcast address out of the subnet", () => {
    expect(outOfSubnet(["192.0.2.255", "255.255.255.255", "198.51.100.255", "198.51.100.7", "198.51.100.7"], subnets)).to.deep.equal(["198.51.100.7"]);
  });

  it("computes a subnet's broadcast address", () => {
    expect(broadcastOf({ address: "203.0.113.20", netmask: "255.255.255.128" })).to.equal("203.0.113.127");
    expect(broadcastOf({ address: "192.0.2.10", netmask: "255.255.255.0" })).to.equal("192.0.2.255");
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

describe("the router's nodes and clock", () => {
  const node = (ip: string, swOut: number[], name = "node") => decodePollReply(encodePollReply({ ip, shortName: name, longName: name, swOut }))!;
  it("gives seenAgoMs and a wall-clock lastSeen, not the monotonic one", () => {
    let now = 5_000;
    const router = new OutputRouter({ routes: [] }, undefined, () => now);
    router.registry.seen(node("192.0.2.20", [0], "a"), 4_000);
    const [n] = router.nodes(now, 1_000_000);
    expect(n).to.include({ seenAgoMs: 1000, lastSeen: 999_000 });
    expect(n).to.not.have.property("firstSeen");
    now += 500;
    expect(router.nodes(now, 1_000_500)[0]).to.include({ seenAgoMs: 1500, lastSeen: 999_000 });
  });

  it("does not take a reordered route for a changed one, and forgets a removed universe's date", () => {
    let now = 0;
    const router = new OutputRouter({ routes: [{ universe: 1, artnet: { portAddress: 0, send: "nodes", targets: ["192.0.2.31"] } }] }, undefined, () => now);
    const dates = () => (router as unknown as { artnetChangedAt: Map<number, number> }).artnetChangedAt;
    now = 100;
    router.setRoutes([{ universe: 1, artnet: { targets: ["192.0.2.31"], send: "nodes", portAddress: 0 } }]);
    expect(dates().has(1)).to.equal(false); // same route, keys in another order
    router.setRoutes([{ universe: 1, artnet: { portAddress: 1 } }]);
    expect(dates().get(1)).to.equal(100);
    router.setRoutes([]);
    expect(dates().has(1)).to.equal(false);
  });
});
