import { expect } from "chai";
import { createSocket } from "node:dgram";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { beatAgoMs, decodeLink, decodePong, encodeLinkAlive, encodePing, encodePong, GhostMeasure, LinkListener, LinkPeers } from "../../../src/plugins/light/link/link.js";

const A = "0102030405060708";
const B = "1112131415161718";
const C = "2122232425262728";
const LIVE = "aaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbb";

describe("Ableton Link (listening)", () => {
  it("reads a peer's announcement: its node, its session and the session's tempo", () => {
    expect(decodeLink(encodeLinkAlive({ node: A, session: LIVE, bpm: 128, beatOrigin: 32.5, timeOrigin: 9_000_000, endpoint: { address: "192.0.2.7", port: 51234 } }))).to.deep.equal({
      type: 1,
      ttl: 5,
      node: A,
      session: LIVE,
      bpm: 128,
      timeline: { microsPerBeat: 468750, beatOrigin: 32.5, timeOrigin: 9_000_000 },
      endpoint: { address: "192.0.2.7", port: 51234 },
    });
    expect(decodeLink(Buffer.from("_link_v\u0001xxxxxxxxxxxxxxx"))).to.equal(undefined); // a measurement message, not discovery
  });

  it("measures the session's time as Link does: pings answered, the median offset of a hundred", () => {
    // what a peer answers: its session, its session time, then our ping's own entries
    const ping = encodePing(1000, 777);
    expect(decodePong(encodePong(LIVE, 5000, ping))).to.deep.equal({ session: LIVE, ghost: 5000, host: 1000, prevGhost: 777 });
    expect(decodePong(ping)).to.equal(undefined); // a ping is not an answer
    // a peer whose session time is ours + 2 s, the way there 300 µs and back 500 µs, now and then a slow one
    const OFFSET = 2_000_000;
    const m = new GhostMeasure(LIVE);
    let host = 10_000_000;
    let next: Buffer | undefined = encodePing(host);
    let rounds = 0;
    while (next) {
      const there = rounds % 7 === 3 ? 9000 : 300;
      const ghost = host + there + OFFSET;
      host += there + 500;
      next = m.answer(decodePong(encodePong(LIVE, ghost, next))!, host); // the next ping leaves at once, as in Link
      rounds++;
    }
    expect(m.done).to.equal(true);
    expect(m.offset()).to.equal(OFFSET - 100); // the slow answers set aside; half the difference between the two ways is the error, as in Link
    expect(rounds).to.be.within(50, 52); // two measures an answer after the first
    expect(new GhostMeasure(LIVE).answer({ session: OTHER, ghost: 1, host: 1 }, 2)).to.equal(undefined); // another session: stop
  });

  it("places the session's beats on our clock", () => {
    const t = { microsPerBeat: 500_000, beatOrigin: 4, timeOrigin: 1_000_000 }; // 120 BPM, beat 4 at 1 s of session time
    expect(beatAgoMs(t, 0, 1_000_000)).to.equal(0);
    expect(beatAgoMs(t, 0, 1_100_000)).to.be.closeTo(100, 1e-9);
    expect(beatAgoMs(t, 250_000, 1_100_000)).to.be.closeTo(350, 1e-9); // the session's time runs 250 ms ahead of ours
    expect(beatAgoMs(t, 0, 900_000)).to.be.closeTo(400, 1e-9); // before the origin too
  });

  it("measures a peer of the leading session, then tells how long ago its beat fell", async function () {
    this.timeout(5000);
    const micros = () => Number(process.hrtime.bigint() / 1000n);
    const OFFSET = 123_456_789;
    const peer = createSocket("udp4");
    let pings = 0;
    peer.on("message", (buf, from) => {
      pings++;
      peer.send(encodePong(LIVE, micros() + OFFSET, buf), from.port, from.address);
    });
    await new Promise<void>((r) => peer.bind(0, "127.0.0.1", r));
    const heard: { bpm: number; beatAgoMs?: number; at: number }[] = [];
    const link = new LinkListener((bpm, ago) => heard.push({ bpm, ...(ago === undefined ? {} : { beatAgoMs: ago }), at: micros() }), Date.now, micros);
    await link.start();
    try {
      if (!link.listening) this.skip(); // no multicast on this machine
      const timeOrigin = micros() + OFFSET - 10_000_000;
      link.handle(encodeLinkAlive({ node: A, session: LIVE, bpm: 120, beatOrigin: 0.25, timeOrigin, endpoint: { address: "127.0.0.1", port: (peer.address() as { port: number }).port } }));
      expect(heard[0]).to.deep.include({ bpm: 120 }); // the tempo at once, the phase not yet known
      expect(heard[0]!.beatAgoMs).to.equal(undefined);
      for (let i = 0; i < 100 && !link.status().phase; i++) await new Promise((r) => setTimeout(r, 10));
      expect(link.status()).to.deep.include({ phase: true, bpm: 120 });
      expect(pings).to.be.within(50, 60);
      const last = heard[heard.length - 1]!;
      const beats = 0.25 + (last.at + OFFSET - timeOrigin) / 500_000;
      expect(last.beatAgoMs).to.be.closeTo((beats - Math.floor(beats)) * 500, 3);
    } finally {
      await link.stop();
      peer.close();
    }
  });

  it("follows the session with the most peers, forgets the silent and the leaving ones", () => {
    const peers = new LinkPeers();
    const hear = (node: string, session: string, bpm: number, at: number, type = 1) => peers.receive(decodeLink(encodeLinkAlive({ node, session, bpm, type }))!, at);
    hear(A, LIVE, 120, 0);
    hear(B, LIVE, 120, 0);
    hear(C, OTHER, 90, 0);
    expect(peers.state(100)).to.deep.equal({ peers: 3, sessions: 2, bpm: 120 });
    hear(A, LIVE, 124, 1000); // the session's tempo moved
    expect(peers.state(1100).bpm).to.equal(124);
    hear(A, LIVE, 124, 2000, 3); // bye
    hear(B, LIVE, 124, 2000, 3);
    expect(peers.state(2100)).to.deep.equal({ peers: 1, sessions: 1, bpm: 90 });
    expect(peers.state(10_000)).to.deep.equal({ peers: 0, sessions: 0 }); // its time to live is over
  });

  it("is listened to only while it leads the tempo, which then follows the session", async () => {
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, os2l: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot: join(mkdtempSync(join(tmpdir(), "light-link-")), "data"), midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    plugin.link.handle(encodeLinkAlive({ node: A, session: LIVE, bpm: 128 }));
    expect(plugin.tempo.state().bpm).to.equal(120); // not chosen: not followed
    await run("tempo.set", { source: "link" });
    for (let i = 0; i < 50 && !plugin.link.listening; i++) await new Promise((r) => setTimeout(r, 10));
    plugin.link.handle(encodeLinkAlive({ node: A, session: LIVE, bpm: 132 }));
    expect(plugin.tempo.state()).to.deep.include({ bpm: 132, source: "link" });
    await run("tempo.set", { source: "manual" });
    for (let i = 0; i < 50 && plugin.link.listening; i++) await new Promise((r) => setTimeout(r, 10));
    expect(plugin.link.listening).to.equal(false);
    plugin.link.handle(encodeLinkAlive({ node: A, session: LIVE, bpm: 100 }));
    expect(plugin.tempo.state().bpm).to.equal(132); // a manual tempo again: Link no longer leads
    await plugin.link.stop();
  });
});
