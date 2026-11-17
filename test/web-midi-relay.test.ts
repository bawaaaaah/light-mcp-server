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
      outcome: { ok: () => void said.push("ok"), refused: (why: string) => void said.push(`refused ${why}`), forbidden: () => void said.push("forbidden"), dropped: () => void said.push("dropped") },
      sent,
      said,
      reconnects: () => reconnects,
    };
  };
  const settle = () => new Promise<void>((r) => setImmediate(r));
  const bend = { port: "Web MIDI · Pad", bytes: [0xe0, 0, 127] };
  const relay = async (f: ReturnType<typeof fake>) => {
    relayOver(f.channel, "midi.in", bend, f.outcome);
    await settle();
  };

  it("a wheel pushed while reconnecting: nothing relayed, nothing kept for later", async () => {
    const f = fake(false, async () => ({ status: 200, body: {} }));
    await relay(f);
    expect(f.sent).to.deep.equal([]);
    expect(f.said).to.deep.equal([]);
  });

  it("online: sent over the connection as the command's route; accepted, a refusal said before is over", async () => {
    const f = fake(true, async () => ({ status: 200, body: { ok: true } }));
    await relay(f);
    expect(f.sent).to.deep.equal([{ path: "/api/plugins/light/commands/midi.in", body: bend }]);
    expect(f.said).to.deep.equal(["ok"]);
    expect(f.reconnects()).to.equal(0);
  });

  it("its connection said closed (422): said, and the connection opened again", async () => {
    const f = fake(true, async () => ({ status: 422, body: { error: "connexion fermée" } }));
    await relay(f);
    expect(f.said).to.deep.equal(["refused connexion fermée"]);
    expect(f.reconnects()).to.equal(1);
  });

  it("another refusal (500): said, the connection kept — only a 422 opens it again", async () => {
    const f = fake(true, async () => ({ status: 500, body: { error: "internal error" } }));
    await relay(f);
    expect(f.said).to.deep.equal(["refused internal error"]);
    expect(f.reconnects()).to.equal(0);
  });

  it("a right missing (403): the relay stops, said once (no server words beside), the shared connection left alone", async () => {
    const f = fake(true, async () => ({ status: 403, body: { error: "droit requis : midi:input" } }));
    await relay(f);
    expect(f.said).to.deep.equal(["forbidden"]);
    expect(f.reconnects()).to.equal(0);
  });

  it("dropped past the flow's rate (429): told to the page (to send it again), never said as a refusal", async () => {
    const f = fake(true, async () => ({ status: 429, body: {} }));
    await relay(f);
    expect(f.said).to.deep.equal(["dropped"]);
    expect(f.reconnects()).to.equal(0);
  });

  it("the connection gone meanwhile: nothing said; an error reply: said, the connection kept", async () => {
    const gone = fake(true, async () => Promise.reject(new Error("offline")));
    await relay(gone);
    expect(gone.said).to.deep.equal([]);
    const busy = fake(true, async () => Promise.reject(new Error("busy")));
    await relay(busy);
    expect(busy.said).to.deep.equal(["refused busy"]);
    expect(busy.reconnects()).to.equal(0);
  });
});

describe("Web MIDI coalescing: at once, then a window per control; the rest in order", () => {
  /** A clock run by hand, a millisecond at a time. */
  const harness = () => {
    const sent: { at: number; bytes: number[] }[] = [];
    const timers: { fn: () => void; at: number; cancelled: boolean }[] = [];
    let now = 0;
    const c = new MidiCoalescer(
      (bytes) => sent.push({ at: now, bytes }),
      (fn, ms) => {
        const t = { fn, at: now + ms, cancelled: false };
        timers.push(t);
        return t;
      },
      (h) => void ((h as { cancelled: boolean }).cancelled = true),
      15,
      () => now,
    );
    const advance = (ms: number) => {
      for (let i = 0; i < ms; i++) {
        now++;
        for (const t of timers.splice(0)) {
          if (t.cancelled) continue;
          if (t.at <= now) t.fn();
          else timers.push(t);
        }
      }
    };
    return { c, sent, advance, values: () => sent.map((s) => s.bytes) };
  };

  it("the first value of a gesture goes at once", () => {
    const h = harness();
    h.advance(1000);
    h.c.push([0xb0, 20, 127]);
    expect(h.sent).to.deep.equal([{ at: 1000, bytes: [0xb0, 20, 127] }]);
  });

  it("a press and its release in one window: 127 at once, then 0 — never the 0 alone", () => {
    const h = harness();
    h.c.push([0xb0, 20, 127]);
    h.advance(3);
    h.c.push([0xb0, 20, 0]);
    h.advance(30);
    expect(h.values()).to.deep.equal([
      [0xb0, 20, 127],
      [0xb0, 20, 0],
    ]);
  });

  it("a wheel 64, 100, 64 within 7 ms: its push kept (the window's extreme), then its rest", () => {
    const h = harness();
    h.c.push([0xe0, 0, 64]);
    h.advance(2);
    h.c.push([0xe0, 0, 100]);
    h.advance(5);
    h.c.push([0xe0, 0, 64]);
    h.advance(30);
    expect(h.values()).to.deep.equal([
      [0xe0, 0, 64],
      [0xe0, 0, 100],
      [0xe0, 0, 64],
    ]);
  });

  it("a wheel at 200 messages/s for 5 s: kept under the page's rate, and its final value sent", () => {
    const h = harness();
    for (let i = 0; i < 1000; i++) {
      h.c.push([0xe0, 0, i === 999 ? 64 : 64 + (i % 63)]); // back at rest at the end
      h.advance(5);
    }
    h.advance(50);
    expect(h.sent.length).to.be.below(5000 / 15 * 2 + 2);
    expect(h.sent.at(-1)!.bytes).to.deep.equal([0xe0, 0, 64]); // the rest is never lost
  });

  it("8 faders and a wheel moving together: never over 300 a second past the 300 ahead, and every last value sent", () => {
    const h = harness();
    for (let ms = 0; ms < 2000; ms++) {
      for (let k = 0; k < 8; k++) h.c.push([0xb0, 20 + k, (ms + k * 7) % 128]);
      if (ms % 3 === 0) h.c.push([0xe0, 0, ms < 1990 ? 127 : 64]);
      h.advance(1);
    }
    h.advance(500);
    expect(h.sent.length).to.be.at.most(300 + 300 * 2.5 + 20);
    for (let k = 0; k < 8; k++) expect(h.values().filter((b) => b[1] === 20 + k).at(-1)).to.deep.equal([0xb0, 20 + k, (1999 + k * 7) % 128]);
    expect(h.values().filter((b) => b[0] === 0xe0).at(-1)).to.deep.equal([0xe0, 0, 64]);
  });

  it("one value per control: two CCs keep theirs; an aftertouch too", () => {
    const h = harness();
    h.c.push([0xb0, 7, 10]);
    h.c.push([0xb0, 8, 20]);
    h.c.push([0xb0, 7, 30]);
    h.c.push([0xd0, 90]);
    h.advance(20);
    expect(h.values()).to.deep.equal([
      [0xb0, 7, 10],
      [0xb0, 8, 20],
      [0xd0, 90],
      [0xb0, 7, 30],
    ]);
  });

  it("a note, a program change and the transport go at once, in order, after what was pending", () => {
    const h = harness();
    h.c.push([0xb0, 7, 100]);
    h.c.push([0xb0, 7, 90]);
    h.c.push([0x90, 40, 100]);
    h.c.push([0xc0, 3]);
    h.c.push([0xfa]);
    h.c.push([0x80, 40, 0]);
    expect(h.values()).to.deep.equal([[0xb0, 7, 100], [0xb0, 7, 90], [0x90, 40, 100], [0xc0, 3], [0xfa], [0x80, 40, 0]]);
  });

  it("the input going: what is pending goes at once, its rest never lost", () => {
    const h = harness();
    h.c.push([0xe0, 0, 127]);
    h.c.push([0xe0, 0, 64]);
    h.c.flush();
    expect(h.values()).to.deep.equal([
      [0xe0, 0, 127],
      [0xe0, 0, 64],
    ]);
    h.advance(30);
    expect(h.values()).to.have.length(2); // nothing more: the window closed with it
  });

  it("a value the server dropped (429) goes again once, if nothing newer went", () => {
    const h = harness();
    h.c.push([0xe0, 0, 64]);
    h.c.dropped([0xe0, 0, 64]);
    h.advance(20);
    expect(h.values()).to.deep.equal([
      [0xe0, 0, 64],
      [0xe0, 0, 64],
    ]);
    h.advance(50);
    expect(h.values()).to.have.length(2); // once: no loop
    // something newer went meanwhile: the dropped one is not sent again
    h.c.push([0xe0, 0, 100]);
    h.advance(20);
    h.c.dropped([0xe0, 0, 64]);
    h.advance(30);
    expect(h.values().at(-1)).to.deep.equal([0xe0, 0, 100]);
  });
});
