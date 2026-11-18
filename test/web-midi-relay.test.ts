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

  it("a value dropped again and again still goes: one request per window at most, never a burst, until the server takes it", () => {
    let down = true;
    const h = harness(() => (down ? "dropped" : "ok"));
    h.b.push(PAD, [0xe0, 0, 127]);
    h.advance(200);
    const tries = h.sent.length;
    expect(tries).to.be.within(10, 200 / 15 + 2);
    for (let k = 1; k < h.sent.length; k++) expect(h.sent[k]!.at - h.sent[k - 1]!.at).to.be.at.least(15);
    expect(h.messages().every((m) => m.bytes[2] === 127)).to.equal(true);
    down = false;
    h.advance(30);
    h.advance(300);
    expect(h.sent.length).to.equal(tries + 1); // taken: nothing more
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

  it("a batch dropped while values wait: they go together at the next window, in the order they came", () => {
    const h = harness((_b, n) => (n === 1 ? { later: 3 } : "ok"));
    h.b.push(PAD, [0xb0, 7, 10]);
    h.b.push(PAD, [0xb0, 8, 20]); // waits in the window
    h.advance(1);
    h.b.push(PAD, [0xb0, 8, 25]);
    h.advance(50);
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
  });

  it("a batch dropped late while the page is at rest: the window opens again and it goes", () => {
    const h = harness((_b, n) => (n === 1 ? { later: 40 } : "ok"));
    h.b.push(PAD, [0xe0, 0, 127]); // sent; the window closes at 15 ms, nothing else moving
    h.advance(100);
    expect(h.sent.map((s) => s.at)).to.deep.equal([0, 55]);
    expect(h.sent[1]!.batch.messages[0]!.bytes).to.deep.equal([0xe0, 0, 127]);
  });

  it("a note off dropped late is sent again — a fader moving or the page at rest — but not once a newer message of its key went", () => {
    for (const fader of [true, false]) {
      const h = harness((b) => (b.messages.some((m) => m.bytes[0] === 0x80) && h.sent.filter((s) => s.batch.messages.some((m) => m.bytes[0] === 0x80)).length === 1 ? { later: 20 } : "ok"));
      h.b.push(PAD, [0x90, 40, 100]);
      for (let ms = 0; ms < 100; ms++) {
        if (fader) h.b.push(PAD, [0xb0, 7, ms]);
        if (ms === 50) h.b.push(PAD, [0x80, 40, 0]);
        h.advance(1);
      }
      h.advance(100);
      expect(h.messages().filter((m) => m.bytes[0] === 0x80), `fader ${fader}`).to.have.length(2);
    }
  });

  it("a note dropped late is sent again though another note went since: notes are judged by their own key", () => {
    const h = harness((_b, n) => (n === 1 ? { later: 20 } : "ok"));
    h.b.push(PAD, [0x90, 40, 100]); // batch 1, dropped 20 ms later
    h.advance(5);
    h.b.push(PAD, [0x90, 41, 100]); // another key, sent at once
    h.advance(60);
    expect(h.messages().map((m) => m.bytes[1])).to.deep.equal([40, 41, 40]);
  });

  it("a rest dropped three times in a row (batch, then twice more) is not given up", () => {
    const got: number[] = [];
    const h = harness((b, n) => {
      if (n >= 2 && n <= 4) return { later: 2 };
      got.push(...b.messages.map((m) => m.bytes[2]!));
      return "ok";
    });
    h.b.push(PAD, [0xe0, 0, 127]);
    h.advance(100);
    h.b.push(PAD, [0xe0, 0, 64]);
    h.advance(300);
    expect(got).to.deep.equal([127, 64]); // the device's wheel is at rest: so is the server's
  });

  it("everything dropped for a second, the wheel pushed then let go meanwhile: once the server answers, it gets the rest", () => {
    let down = true;
    const got: number[] = [];
    const h = harness((b) => {
      if (down) return { later: 2 };
      got.push(...b.messages.map((m) => m.bytes[2]!));
      return "ok";
    });
    h.b.push(PAD, [0xe0, 0, 127]);
    h.advance(200);
    h.b.push(PAD, [0xe0, 0, 64]);
    h.advance(800);
    expect(h.sent.length).to.be.at.most(1000 / 15 + 3); // one per window, never a burst
    down = false;
    h.advance(200);
    expect(got).to.deep.equal([64]);
  });

  it("a value equal to the last one sent is not sent again", () => {
    const h = harness();
    h.b.push(PAD, [0xb0, 7, 64]);
    h.advance(20);
    h.b.push(PAD, [0xb0, 7, 64]);
    h.advance(20);
    expect(h.sent).to.have.length(1);
  });

  it("reads each kind's own value: a channel aftertouch's byte 1, a pitch bend's 14 bits, a poly aftertouch per key", () => {
    const h = harness();
    h.b.push(PAD, [0xd0, 10]);
    h.b.push(PAD, [0xd0, 90]);
    h.b.push(PAD, [0xd0, 10]); // turned at 90
    h.b.push(PAD, [0xe0, 0, 64]);
    h.advance(20);
    h.b.push(PAD, [0xe0, 5, 64]); // the same top 7 bits, another value
    h.b.push(PAD, [0xa0, 40, 10]);
    h.b.push(PAD, [0xa0, 41, 20]); // another key: its own control
    h.b.push(PAD, [0xa0, 40, 30]);
    h.b.push(PAD, [0xa0, 41, 40]);
    h.advance(20);
    expect(h.messages().map((m) => m.bytes)).to.deep.equal([[0xd0, 10], [0xd0, 90], [0xd0, 10], [0xe0, 0, 64], [0xe0, 5, 64], [0xa0, 40, 10], [0xa0, 41, 20], [0xa0, 40, 30], [0xa0, 41, 40]]);
  });

  it("more than 512 messages in a window: cut into requests of 512 at most, sent in order, the rest last", () => {
    const h = harness();
    h.b.push(PAD, [0xe0, 0, 127]); // the wheel pushed, at once
    for (let k = 0; k < 599; k++) h.b.push(PAD, [0xd0, k % 2 ? 90 : 10]); // an aftertouch shaking: every turn kept
    h.b.push(PAD, [0xe0, 0, 64]); // back at rest
    h.advance(20);
    expect(h.sent.every((x) => x.batch.messages.length <= 512)).to.equal(true);
    expect(h.sent.length).to.be.at.least(3);
    expect(h.messages().at(-1)).to.deep.equal({ port: PAD, bytes: [0xe0, 0, 64] });
    expect(h.messages()).to.have.length(601);
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
