import { expect } from "chai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { decodeLink, encodeLinkAlive, LinkPeers } from "../../../src/plugins/light/link/link.js";

const A = "0102030405060708";
const B = "1112131415161718";
const C = "2122232425262728";
const LIVE = "aaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbb";

describe("Ableton Link (listening)", () => {
  it("reads a peer's announcement: its node, its session and the session's tempo", () => {
    expect(decodeLink(encodeLinkAlive({ node: A, session: LIVE, bpm: 128 }))).to.deep.equal({ type: 1, ttl: 5, node: A, session: LIVE, bpm: 128 });
    expect(decodeLink(Buffer.from("_link_v\u0001xxxxxxxxxxxxxxx"))).to.equal(undefined); // a measurement message, not discovery
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
