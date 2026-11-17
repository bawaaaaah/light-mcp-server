import { expect } from "chai";
import { MidiBatcher, type RelayBatch } from "../web/src/midi-coalesce.js";
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

describe("Web MIDI batches: one request per 15 ms window for the whole page", () => {
  const PAD = "Web MIDI · Pad";
  const KEYS = "Web MIDI · Keys";
  /** A clock run by hand, a millisecond at a time; the server's answer to each batch decided by `answer`. */
  const harness = (answer: (batch: RelayBatch, n: number) => "ok" | "dropped" | { later: number } = () => "ok") => {
    const sent: { at: number; batch: RelayBatch }[] = [];
    const timers: { fn: () => void; at: number; cancelled: boolean }[] = [];
    let now = 0;
    const b: MidiBatcher = new MidiBatcher(
      (batch, done) => {
        sent.push({ at: now, batch });
        const a = answer(batch, sent.length);
        if (a === "dropped") done.dropped();
        else if (a !== "ok") timers.push({ fn: () => done.dropped(), at: now + a.later, cancelled: false });
      },
      (fn, ms) => {
        const t = { fn, at: now + ms, cancelled: false };
        timers.push(t);
        return t;
      },
      (h) => void ((h as { cancelled: boolean }).cancelled = true),
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
    /** Every message that went, in order, as « port bytes ». */
    const messages = () => sent.flatMap((s) => s.batch.messages);
    return { b, sent, advance, messages, now: () => now };
  };

  it("the first message of a gesture goes at once; a note too, with what waits", () => {
    const h = harness();
    h.advance(1000);
    h.b.push(PAD, [0xb0, 20, 127]);
    expect(h.sent).to.deep.equal([{ at: 1000, batch: { messages: [{ port: PAD, bytes: [0xb0, 20, 127] }] } }]);
    h.advance(2);
    h.b.push(PAD, [0xb0, 20, 90]);
    h.b.push(PAD, [0x90, 40, 100]);
    expect(h.sent[1]).to.deep.equal({ at: 1002, batch: { messages: [{ port: PAD, bytes: [0xb0, 20, 90] }, { port: PAD, bytes: [0x90, 40, 100] }] } });
  });

  it("a press and its release in one window: 127 at once, then 0", () => {
    const h = harness();
    h.b.push(PAD, [0xb0, 20, 127]);
    h.advance(3);
    h.b.push(PAD, [0xb0, 20, 0]);
    h.advance(30);
    expect(h.messages().map((m) => m.bytes[2])).to.deep.equal([127, 0]);
  });

  it("three turns of a wheel in one window: every crossing of any threshold goes (64 → 100 → 30 → 100 → 64)", () => {
    const h = harness();
    h.b.push(PAD, [0xe0, 0, 64]); // at rest, sent
    for (const v of [80, 100, 70, 30, 60, 100, 90, 64]) {
      h.b.push(PAD, [0xe0, 0, v]);
      h.advance(1);
    }
    h.advance(30);
    expect(h.messages().map((m) => m.bytes[2])).to.deep.equal([64, 100, 30, 100, 64]);
  });

  for (const n of [8, 16]) {
    it(`${n} controls moving for 15 s: one request per window, every control in each, no gap longer than two windows`, () => {
      const h = harness();
      const lastAt = new Map<number, number>();
      let worst = 0;
      for (let ms = 0; ms < 15_000; ms++) {
        for (let k = 0; k < n; k++) h.b.push(PAD, [0xb0, 20 + k, (ms + k) % 128]);
        h.advance(1);
      }
      for (const { at, batch } of h.sent) {
        for (const m of batch.messages) {
          const k = m.bytes[1]!;
          worst = Math.max(worst, at - (lastAt.get(k) ?? 0));
          lastAt.set(k, at);
        }
      }
      expect(h.sent.length).to.be.at.most(15_000 / 15 + 2); // ~67 a second, whatever the number of controls
      expect(worst).to.be.at.most(30);
      for (let k = 0; k < n; k++) expect(h.messages().filter((m) => m.bytes[1] === 20 + k).at(-1)!.bytes[2]).to.equal((14_999 + k) % 128);
    });
  }

  it("a wheel pushed during a flood of faders: its push and its rest go", () => {
    const h = harness();
    for (let ms = 0; ms < 3000; ms++) {
      for (let k = 0; k < 8; k++) h.b.push(PAD, [0xb0, 20 + k, ms % 128]);
      if (ms === 1000) h.b.push(KEYS, [0xe0, 0, 127]);
      if (ms === 1003) h.b.push(KEYS, [0xe0, 0, 64]);
      h.advance(1);
    }
    expect(h.messages().filter((m) => m.port === KEYS).map((m) => m.bytes[2])).to.deep.equal([127, 64]);
  });

  it("two inputs: still one request per window", () => {
    const h = harness();
    for (let ms = 0; ms < 1500; ms++) {
      h.b.push(PAD, [0xb0, 20, ms % 128]);
      h.b.push(KEYS, [0xb0, 21, ms % 128]);
      h.advance(1);
    }
    expect(h.sent.length).to.be.at.most(1500 / 15 + 2);
    expect(h.sent.slice(2).every((s) => s.batch.messages.some((m) => m.port === PAD) && s.batch.messages.some((m) => m.port === KEYS))).to.equal(true);
  });

  it("a batch dropped (429) for good: sent again once, marked, never a third time — no loop", () => {
    const h = harness(() => "dropped");
    h.b.push(PAD, [0xe0, 0, 127]);
    h.advance(200);
    expect(h.sent.map((s) => s.batch.resend ?? false)).to.deep.equal([false, true, true]); // then its last value once more, at the next window, as a resend
    expect(h.sent[2]!.at - h.sent[1]!.at).to.be.at.least(15); // the next window, not at once
    h.advance(500);
    expect(h.sent).to.have.length(3);
  });

  it("a 429 that comes late: no duplicate, never an older value after a newer one", () => {
    const h = harness((_b, n) => (n === 1 ? { later: 40 } : "ok"));
    h.b.push(PAD, [0xe0, 0, 127]); // batch 1: its 429 comes 40 ms later
    h.advance(5);
    h.b.push(PAD, [0xe0, 0, 64]); // batch 2 at the window's end: newer
    h.b.push(PAD, [0x90, 40, 100]);
    h.advance(100);
    const wheel = h.messages().filter((m) => m.bytes[0] === 0xe0).map((m) => m.bytes[2]);
    expect(wheel).to.deep.equal([127, 64]); // the dropped 127 is not sent after the 64
  });

  it("a batch dropped while values wait: merged with them, in the order they came", () => {
    const h = harness((_b, n) => (n === 1 ? { later: 3 } : "ok"));
    h.b.push(PAD, [0xb0, 7, 10]);
    h.b.push(PAD, [0xb0, 8, 20]); // waits in the window
    h.advance(1);
    h.b.push(PAD, [0xb0, 8, 25]);
    h.advance(50);
    expect(h.sent[1]!.batch.resend).to.equal(true);
    expect(h.sent[1]!.batch.messages.map((m) => m.bytes)).to.deep.equal([
      [0xb0, 7, 10],
      [0xb0, 8, 20], // never sent before: its first value, where its gesture starts
      [0xb0, 8, 25],
    ]);
  });

  it("a batch dropped while a newer value of its control waits: only the newer one goes, never the older after it", () => {
    const h = harness((_b, n) => (n === 1 ? { later: 3 } : "ok"));
    h.b.push(PAD, [0xb0, 7, 10]); // batch 1, dropped 3 ms later
    h.advance(1);
    h.b.push(PAD, [0xb0, 7, 30]); // waits in the window
    h.advance(50);
    expect(h.messages().map((m) => m.bytes[2])).to.deep.equal([10, 30]);
    expect(h.sent[1]!.batch.resend).to.equal(true);
  });

  it("a batch with a note dropped late, after a newer batch went: its note is not sent again (a note on after its note off)", () => {
    const h = harness((_b, n) => (n === 1 ? { later: 40 } : "ok"));
    h.b.push(PAD, [0x90, 40, 100]); // batch 1, its 429 40 ms later
    h.b.push(PAD, [0x80, 40, 0]); // batch 2, at once
    h.advance(100);
    expect(h.messages().map((m) => m.bytes[0])).to.deep.equal([0x90, 0x80]);
  });

  it("the same CC on two inputs: two controls, each its own values", () => {
    const h = harness();
    h.b.push(PAD, [0xb0, 20, 10]);
    h.b.push(KEYS, [0xb0, 20, 11]);
    h.advance(2);
    h.b.push(PAD, [0xb0, 20, 12]); // both rising, interleaved: one control would keep only the last of all
    h.b.push(KEYS, [0xb0, 20, 13]);
    h.advance(30);
    const last = (port: string) => h.messages().filter((m) => m.port === port).at(-1)!.bytes[2];
    expect([last(PAD), last(KEYS)]).to.deep.equal([12, 13]);
  });

  it("after a flush the window is closed: the next message goes at once", () => {
    const h = harness();
    h.b.push(PAD, [0xb0, 20, 1]);
    h.advance(2);
    h.b.flush();
    h.advance(2);
    h.b.push(PAD, [0xb0, 20, 2]);
    expect(h.sent.at(-1)).to.deep.equal({ at: 4, batch: { messages: [{ port: PAD, bytes: [0xb0, 20, 2] }] } });
  });

  it("the page left: what waits goes at once, its rest never lost; the window closed with it", () => {
    const h = harness();
    h.b.push(PAD, [0xe0, 0, 127]);
    h.b.push(PAD, [0xe0, 0, 64]);
    h.b.flush();
    expect(h.messages().map((m) => m.bytes[2])).to.deep.equal([127, 64]);
    h.advance(30);
    expect(h.sent).to.have.length(2);
  });
});
