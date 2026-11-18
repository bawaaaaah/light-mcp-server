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
      outcome: { ok: () => void said.push("ok"), refused: (why: string) => void said.push(`refused ${why}`), forbidden: () => void said.push("forbidden"), dropped: () => void said.push("dropped"), settled: () => void said.push("settled") },
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
    expect(f.said).to.deep.equal(["settled"]); // not sent: settled at once (a relay ending does not wait for it)
  });

  it("online: sent over the connection as the command's route; accepted, a refusal said before is over", async () => {
    const f = fake(true, async () => ({ status: 200, body: { ok: true } }));
    await relay(f);
    expect(f.sent).to.deep.equal([{ path: "/api/plugins/light/commands/midi.in", body: bend }]);
    expect(f.said).to.deep.equal(["settled", "ok"]);
    expect(f.reconnects()).to.equal(0);
  });

  it("its connection said closed (422): said, and the connection opened again", async () => {
    const f = fake(true, async () => ({ status: 422, body: { error: "connexion fermée" } }));
    await relay(f);
    expect(f.said).to.deep.equal(["settled", "refused connexion fermée"]);
    expect(f.reconnects()).to.equal(1);
  });

  it("another refusal (500): said, the connection kept — only a 422 opens it again", async () => {
    const f = fake(true, async () => ({ status: 500, body: { error: "internal error" } }));
    await relay(f);
    expect(f.said).to.deep.equal(["settled", "refused internal error"]);
    expect(f.reconnects()).to.equal(0);
  });

  it("a right missing (403): the relay stops, said once (no server words beside), the shared connection left alone", async () => {
    const f = fake(true, async () => ({ status: 403, body: { error: "droit requis : midi:input" } }));
    await relay(f);
    expect(f.said).to.deep.equal(["settled", "forbidden"]);
    expect(f.reconnects()).to.equal(0);
  });

  it("dropped past the flow's rate (429): told to the page (to send it again), never said as a refusal", async () => {
    const f = fake(true, async () => ({ status: 429, body: {} }));
    await relay(f);
    expect(f.said).to.deep.equal(["dropped"]); // not settled: the batcher sends it again
    expect(f.reconnects()).to.equal(0);
  });

  it("the connection gone meanwhile: nothing said; an error reply: said, the connection kept", async () => {
    const gone = fake(true, async () => Promise.reject(new Error("offline")));
    await relay(gone);
    expect(gone.said).to.deep.equal(["settled"]); // the link went: settled, nothing said
    const busy = fake(true, async () => Promise.reject(new Error("busy")));
    await relay(busy);
    expect(busy.said).to.deep.equal(["settled", "refused busy"]); // a request that failed
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
        else done.settled();
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
    expect(h.messages().map((m) => m.bytes[2])).to.deep.equal([64, 80, 100, 30, 100, 64]); // its first value in the window too
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
    h.advance(330);
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

  it("a value equal to the one sent before still goes, each time: a CC-127 pad pressed three times, a wheel at 127 after a Start", () => {
    const h = harness();
    for (let k = 0; k < 3; k++) {
      h.b.push(PAD, [0xb0, 20, 127]); // a pad that never sends 0 (a toggle flips at each press)
      h.advance(1000);
    }
    expect(h.messages().filter((m) => m.bytes[0] === 0xb0)).to.have.length(3);
    h.b.push(PAD, [0xe0, 0, 127]);
    h.advance(1000);
    h.b.push(PAD, [0xfa]); // Live's Start: the wheel rearmed
    h.b.push(PAD, [0xe0, 0, 127]); // Live sends its value again: it must go
    h.advance(30);
    expect(h.messages().slice(-3).map((m) => m.bytes)).to.deep.equal([[0xe0, 0, 127], [0xfa], [0xe0, 0, 127]]);
  });

  it("a repetition within one window is merged", () => {
    const h = harness();
    h.b.push(PAD, [0xb0, 7, 10]); // at once
    h.b.push(PAD, [0xb0, 7, 20]); // the window's first
    h.b.push(PAD, [0xb0, 7, 64]);
    h.b.push(PAD, [0xb0, 7, 64]);
    h.b.push(PAD, [0xb0, 7, 64]);
    h.advance(30);
    expect(h.messages().map((m) => m.bytes[2])).to.deep.equal([10, 20, 64]);
  });

  it("reads each kind's own value: a channel aftertouch's byte 1, a pitch bend's 14 bits, a poly aftertouch per key", () => {
    const h = harness();
    h.b.push(PAD, [0xd0, 10]);
    h.b.push(PAD, [0xd0, 90]);
    h.b.push(PAD, [0xd0, 10]); // turned at 90
    h.b.push(PAD, [0xe0, 0, 64]);
    h.b.push(PAD, [0xe0, 5, 64]); // the same top 7 bits, another value, in the same window: not merged
    h.b.push(PAD, [0xa0, 40, 10]);
    h.b.push(PAD, [0xa0, 41, 20]); // another key: its own control
    h.b.push(PAD, [0xa0, 40, 30]);
    h.b.push(PAD, [0xa0, 41, 40]);
    h.advance(20);
    expect(h.messages().map((m) => m.bytes)).to.deep.equal([[0xd0, 10], [0xd0, 90], [0xd0, 10], [0xe0, 0, 64], [0xe0, 5, 64], [0xa0, 40, 10], [0xa0, 41, 20], [0xa0, 40, 30], [0xa0, 41, 40]]);
  });

  it("a 429 that comes after the relay stopped sends nothing; the page left while the server drops: nothing after", () => {
    const late = harness((_b, n) => (n === 1 ? { later: 10 } : "ok"));
    late.b.push(PAD, [0xe0, 0, 127]); // its 429 comes 10 ms later
    late.advance(5);
    late.b.flush();
    late.b.stop(); // Web MIDI off: the relay ends before the inputs are said gone
    late.advance(500);
    expect(late.sent).to.have.length(1);
    const down = harness(() => ({ later: 2 }));
    down.b.push(PAD, [0xe0, 0, 127]);
    down.advance(100);
    down.b.flush();
    down.b.stop(); // the page left
    const before = down.sent.length;
    down.advance(2000);
    expect(down.sent.length).to.equal(before);
    down.b.push(PAD, [0xe0, 0, 64]); // nothing goes any more
    expect(down.sent.length).to.equal(before);
  });

  it("an input unplugged: what waits of it is forgotten, a later 429 of it sends nothing again; the other inputs go on", () => {
    const h = harness((_b, n) => (n === 1 ? { later: 10 } : "ok"));
    h.b.push(PAD, [0xe0, 0, 127]); // its 429 comes 10 ms later
    h.b.push(KEYS, [0xb0, 7, 1]);
    h.advance(2);
    h.b.push(KEYS, [0xb0, 7, 2]);
    h.b.push(PAD, [0xe0, 0, 100]); // waits in the window
    h.b.forgetPort(PAD); // the pad unplugged
    h.advance(100);
    expect(h.messages().filter((m) => m.port === PAD)).to.have.length(1);
    expect(h.messages().filter((m) => m.port === KEYS).at(-1)!.bytes).to.deep.equal([0xb0, 7, 2]);
    h.advance(100);
    h.b.push(PAD, [0xe0, 0, 64]); // plugged in again: it goes, and its drops are sent again
    expect(h.messages().at(-1)).to.deep.equal({ port: PAD, bytes: [0xe0, 0, 64] });
  });

  it("an input plugged in again after being forgotten: what the server drops of it goes again", () => {
    const h = harness((b) => (b.messages.some((m) => m.bytes[2] === 64) && h.sent.filter((x) => x.batch.messages.some((m) => m.bytes[2] === 64)).length === 1 ? "dropped" : "ok"));
    h.b.push(PAD, [0xe0, 0, 127]);
    h.b.forgetPort(PAD);
    h.advance(100);
    h.b.push(PAD, [0xe0, 0, 64]); // plugged in again; this one dropped
    h.advance(100);
    expect(h.messages().filter((m) => m.bytes[2] === 64)).to.have.length(2);
  });

  it("a Start dropped late is stale after a newer message of its input (a wheel, a Stop): never sent again after them", () => {
    for (const later of [20, 5]) {
      // its 429 comes after the wheel went (20 ms), or while the wheel still waits in the window (5 ms)
      const wheel = harness((_b, n) => (n === 1 ? { later } : "ok"));
      wheel.b.push(PAD, [0xfa]);
      wheel.advance(2);
      wheel.b.push(PAD, [0xe0, 0, 100]); // the wheel pushed after it
      wheel.advance(100);
      expect(wheel.messages().map((m) => m.bytes[0]), `429 after ${later} ms`).to.deep.equal([0xfa, 0xe0]);
    }
    const stop = harness((_b, n) => (n === 1 ? { later: 20 } : "ok"));
    stop.b.push(PAD, [0xfa]);
    stop.advance(5);
    stop.b.push(PAD, [0xfc]); // a Stop after it
    stop.advance(100);
    expect(stop.messages().map((m) => m.bytes[0])).to.deep.equal([0xfa, 0xfc]);
    const alone = harness((_b, n) => (n === 1 ? { later: 20 } : "ok"));
    alone.b.push(PAD, [0xfa]); // nothing newer: it goes again
    alone.advance(100);
    expect(alone.messages().map((m) => m.bytes[0])).to.deep.equal([0xfa, 0xfa]);
  });

  it("the relay ending (finish): a rest the last flush sent and the server dropped goes again before the inputs are said gone", () => {
    const got: string[] = [];
    let n = 0;
    const h = harness((b) => {
      n++;
      if (b.messages.some((m) => m.bytes[2] === 64) && got.filter((g) => g === "64").length === 0 && n <= 3) return { later: 3 };
      got.push(...b.messages.map((m) => String(m.bytes[2])));
      return "ok";
    });
    h.b.push(PAD, [0xe0, 0, 127]);
    h.advance(20);
    h.b.push(PAD, [0xe0, 0, 100]);
    h.advance(2);
    h.b.push(PAD, [0xe0, 0, 64]); // back at rest, waiting in the window
    let ended = false;
    void h.b.finish().then(() => {
      ended = true;
      got.push("closed");
    });
    for (let i = 0; i < 200 && !ended; i++) h.advance(1);
    return Promise.resolve().then(() => {
      expect(got).to.deep.equal(["127", "100", "64", "closed"]); // the 64 applied before « closed »
    });
  });

  it("finish(): what waits goes at once, and nothing new is taken while it ends", async () => {
    const h = harness((_b, n) => (n === 2 ? { later: 5 } : "ok"));
    h.b.push(PAD, [0xe0, 0, 127]);
    h.b.push(PAD, [0xe0, 0, 64]); // waits in the window
    let ended = false;
    void h.b.finish().then(() => (ended = true));
    expect(h.sent).to.have.length(2); // sent with the call, not at the window's end
    h.b.push(PAD, [0x90, 40, 100]); // played while the relay ends: not taken
    h.advance(100);
    await Promise.resolve();
    expect(ended).to.equal(true);
    expect(h.messages().some((m) => m.bytes[0] === 0x90)).to.equal(false);
  });

  it("finish(): what the server drops is let go again exactly 8 times, whatever its answer time", async () => {
    for (const later of [2, 80]) {
      const h = harness(() => ({ later }));
      h.b.push(PAD, [0xe0, 0, 127]);
      h.advance(200);
      const before = h.sent.length;
      let ended = false;
      void h.b.finish().then(() => (ended = true));
      h.advance(5000);
      await Promise.resolve();
      expect(ended, `answers ${later} ms`).to.equal(true);
      // its 8 tries (each a window that sends), after the flush when something waited for it (its 429 already back)
      expect(h.sent.length - before, `answers ${later} ms`).to.equal(later === 2 ? 1 + 8 : 8);
    }
  });

  it("a note and a Start dropped together both go again: the Start is not stale after its own batch's note", () => {
    const h = harness((_b, n) => (n === 2 ? { later: 5 } : "ok"));
    h.b.push(PAD, [0xb0, 7, 1]); // at once, opening the window
    h.b.push(PAD, [0x90, 40, 100]); // a note: at once, with...
    h.advance(1);
    h.b.push(PAD, [0xfa]); // ...then a Start in its own batch: both dropped, the second's 429 first
    h.advance(100);
    expect(h.messages().filter((m) => m.bytes[0] === 0x90 || m.bytes[0] === 0xfa).map((m) => m.bytes[0])).to.include.members([0x90, 0xfa]);
  });

  it("finish(): bounded — the server dropping everything, it gives up after a few windows, then nothing goes", async () => {
    const h = harness(() => ({ later: 2 }));
    h.b.push(PAD, [0xe0, 0, 127]);
    h.advance(50);
    let ended = false;
    void h.b.finish().then(() => (ended = true));
    h.advance(300);
    await Promise.resolve();
    expect(ended).to.equal(true);
    const before = h.sent.length;
    h.advance(1000);
    expect(h.sent.length).to.equal(before);
  });

  it("an input unplugged then plugged in again: a value from before is never sent again, the new ones are", () => {
    const h = harness((_b, n) => (n === 1 ? { later: 400 } : "ok"));
    h.b.push(PAD, [0xe0, 0, 127]); // its 429 comes at 400 ms
    h.advance(50);
    h.b.flush();
    h.b.forgetPort(PAD); // unplugged
    h.advance(250);
    h.b.push(PAD, [0xb0, 7, 10]); // plugged in again: a fader moves, before the old 429
    h.advance(300);
    expect(h.messages().map((m) => m.bytes)).to.deep.equal([
      [0xe0, 0, 127],
      [0xb0, 7, 10],
    ]);
  });

  it("stop() cancels the window: what waited is not sent", () => {
    const h = harness();
    h.b.push(PAD, [0xe0, 0, 127]);
    h.b.push(PAD, [0xe0, 0, 100]); // waits in the window
    h.b.stop();
    h.advance(50);
    expect(h.sent).to.have.length(1);
  });

  it("forgetPort lets go of its waiting notes and turns too", () => {
    const h = harness((b) => (b.messages.some((m) => m.bytes[0] === 0x90) && h.sent.length === 2 ? "dropped" : "ok"));
    h.b.push(PAD, [0xb0, 7, 10]); // at once, opening the window
    h.b.push(PAD, [0x90, 40, 100]); // a note, dropped: it waits again for the next window
    h.b.push(PAD, [0xb0, 7, 50]);
    h.b.push(PAD, [0xb0, 7, 20]); // a turn at 50, waiting
    h.b.forgetPort(PAD);
    h.advance(50);
    h.b.push(PAD, [0xb0, 7, 30]); // plugged in again: only the new value
    h.advance(50);
    expect(h.messages().map((m) => m.bytes)).to.deep.equal([
      [0xb0, 7, 10],
      [0x90, 40, 100],
      [0xb0, 7, 30],
    ]);
  });

  it("a batch dropped that mixes an input unplugged and one still there: only the latter goes again", () => {
    // two messages of two inputs in one request: pushed into the same window
    const g = harness((_b, n) => (n === 2 ? { later: 20 } : "ok"));
    g.b.push(PAD, [0xb0, 7, 1]); // at once
    g.b.push(PAD, [0xb0, 7, 2]);
    g.b.push(KEYS, [0xb0, 7, 3]); // both wait: one request at the window's end, dropped 20 ms later
    g.advance(15);
    g.b.forgetPort(PAD);
    g.advance(100);
    expect(g.messages().filter((m) => m.port === KEYS)).to.have.length(2);
    expect(g.messages().filter((m) => m.port === PAD).map((m) => m.bytes[2])).to.deep.equal([1, 2]);
  });

  it("a Song Position (0xF2) dropped is transport too: stale after a newer message of its input", () => {
    const h = harness((_b, n) => (n === 1 ? { later: 20 } : "ok"));
    h.b.push(PAD, [0xf2, 0x10, 0x00]);
    h.advance(2);
    h.b.push(PAD, [0xe0, 0, 100]);
    h.advance(100);
    expect(h.messages().map((m) => m.bytes[0])).to.deep.equal([0xf2, 0xe0]);
  });

  it("an older message sent again never lowers what its input sent last (a Start then stays stale)", () => {
    const h = harness((b, n) => (n === 1 ? { later: 30 } : n === 2 ? { later: 60 } : "ok"));
    h.b.push(PAD, [0xe0, 0, 127]); // batch 1, dropped at 30: sent again at the next window
    h.b.push(PAD, [0xfa]); // batch 2, dropped at 60
    h.b.push(PAD, [0xb0, 7, 5]); // waits, goes at 15: newer than the Start
    h.advance(200);
    expect(h.messages().filter((m) => m.bytes[0] === 0xfa)).to.have.length(1);
  });

  it("a note dropped is not judged by its input: a CC that went after it leaves it to be sent again", () => {
    const h = harness((_b, n) => (n === 1 ? { later: 20 } : "ok"));
    h.b.push(PAD, [0x90, 40, 100]);
    h.advance(2);
    h.b.push(PAD, [0xb0, 7, 10]); // a newer message of its input, not of its key
    h.advance(100);
    expect(h.messages().filter((m) => m.bytes[0] === 0x90)).to.have.length(2);
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
