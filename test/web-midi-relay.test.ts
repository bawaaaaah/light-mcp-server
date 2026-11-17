import { expect } from "chai";
import { MidiCoalescer } from "../web/src/midi-coalesce.js";
import { relayOver } from "../web/src/web-midi-relay.js";

/** The Web MIDI relay (docs/specs/midi.md, « Web MIDI »): over the live connection, only while online, a refusal said. */
describe("Web MIDI relay", () => {
  const fake = (online: boolean, answer: () => Promise<{ status: number; body: unknown }>) => {
    const sent: unknown[] = [];
    let reconnects = 0;
    const said: string[] = [];
    return {
      channel: { online, request: (_m: "POST", path: string, body: unknown) => (sent.push({ path, body }), answer()), reconnect: () => void reconnects++ },
      outcome: { ok: () => void said.push("ok"), refused: (why: string) => void said.push(`refused ${why}`), forbidden: (why: string) => void said.push(`forbidden ${why}`) },
      sent,
      said,
      reconnects: () => reconnects,
    };
  };
  const settle = () => new Promise<void>((r) => setImmediate(r));
  const bend = { port: "Web MIDI · Pad", bytes: [0xe0, 0, 127] };

  it("a wheel pushed while reconnecting: nothing relayed, nothing kept for later", async () => {
    const f = fake(false, async () => ({ status: 200, body: {} }));
    relayOver(f.channel, "midi.in", bend, f.outcome);
    await settle();
    expect(f.sent).to.deep.equal([]);
    expect(f.said).to.deep.equal([]);
  });

  it("online: sent over the connection as the command's route; accepted, a refusal said before is over", async () => {
    const f = fake(true, async () => ({ status: 200, body: { ok: true } }));
    relayOver(f.channel, "midi.in", bend, f.outcome);
    await settle();
    expect(f.sent).to.deep.equal([{ path: "/api/plugins/light/commands/midi.in", body: bend }]);
    expect(f.said).to.deep.equal(["ok"]);
    expect(f.reconnects()).to.equal(0);
  });

  it("its connection said closed (422): said, and the connection opened again", async () => {
    const f = fake(true, async () => ({ status: 422, body: { error: "connexion fermée" } }));
    relayOver(f.channel, "midi.in", bend, f.outcome);
    await settle();
    expect(f.said).to.deep.equal(["refused connexion fermée"]);
    expect(f.reconnects()).to.equal(1);
  });

  it("a right missing (403): the relay stops, said, and the connection every page shares is left alone", async () => {
    const f = fake(true, async () => ({ status: 403, body: { error: "droit requis : midi:input" } }));
    relayOver(f.channel, "midi.in", bend, f.outcome);
    await settle();
    expect(f.said).to.deep.equal(["forbidden droit requis : midi:input"]);
    expect(f.reconnects()).to.equal(0);
  });

  it("dropped by the server past the flow's rate (429), or the connection gone meanwhile: nothing said, nothing done", async () => {
    for (const answer of [async () => ({ status: 429, body: {} }), async () => Promise.reject(new Error("offline"))]) {
      const f = fake(true, answer);
      relayOver(f.channel, "midi.in", bend, f.outcome);
      await settle();
      expect(f.said).to.deep.equal([]);
      expect(f.reconnects()).to.equal(0);
    }
  });

  it("another refusal (an error reply): said, the connection kept", async () => {
    const f = fake(true, async () => Promise.reject(new Error("busy")));
    relayOver(f.channel, "midi.in", bend, f.outcome);
    await settle();
    expect(f.said).to.deep.equal(["refused busy"]);
    expect(f.reconnects()).to.equal(0);
  });
});

describe("Web MIDI coalescing: a sustained flow by last value, the rest in order", () => {
  /** A clock run by hand. */
  const harness = () => {
    const sent: number[][] = [];
    const timers: { fn: () => void; at: number; cancelled: boolean }[] = [];
    let now = 0;
    const c = new MidiCoalescer(
      (b) => sent.push(b),
      (fn, ms) => {
        const t = { fn, at: now + ms, cancelled: false };
        timers.push(t);
        return t;
      },
      (h) => void ((h as { cancelled: boolean }).cancelled = true),
    );
    const advance = (ms: number) => {
      now += ms;
      for (const t of timers.splice(0)) if (t.at <= now && !t.cancelled) t.fn();
      else if (!t.cancelled) timers.push(t);
    };
    return { c, sent, advance };
  };

  it("a wheel at 200 messages/s for 5 s: one message per 15 ms at most, and its final value sent", () => {
    const { c, sent, advance } = harness();
    for (let i = 0; i < 1000; i++) {
      c.push([0xe0, 0, i === 999 ? 64 : 64 + (i % 63)]); // back at rest at the end
      advance(5);
    }
    advance(20);
    expect(sent.length).to.be.at.most(Math.ceil(5000 / 15) + 1);
    expect(sent.at(-1)).to.deep.equal([0xe0, 0, 64]); // the rest is never lost
  });

  it("one value per control: two CCs keep theirs; an aftertouch too", () => {
    const { c, sent, advance } = harness();
    c.push([0xb0, 7, 10]);
    c.push([0xb0, 8, 20]);
    c.push([0xb0, 7, 30]);
    c.push([0xd0, 90]);
    advance(15);
    expect(sent).to.deep.equal([
      [0xb0, 8, 20],
      [0xb0, 7, 30],
      [0xd0, 90],
    ]);
  });

  it("a note, a program change and the transport go at once, in order, after what was pending", () => {
    const { c, sent } = harness();
    c.push([0xb0, 7, 100]);
    c.push([0x90, 40, 100]);
    c.push([0xc0, 3]);
    c.push([0xfa]);
    c.push([0x80, 40, 0]);
    expect(sent).to.deep.equal([[0xb0, 7, 100], [0x90, 40, 100], [0xc0, 3], [0xfa], [0x80, 40, 0]]);
  });
});
