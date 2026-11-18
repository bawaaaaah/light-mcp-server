/**
 * What a page relays of its Web MIDI inputs (docs/specs/midi.md, « Web MIDI »): **one request per window of 15 ms for the
 * whole page**, every input together (at most ~67 a second, whatever the number of controls), carrying all that changed:
 * - notes, program changes and the transport (Start, Continue, Song Position): every one, in the order they came;
 * - per continuous control that moved (a CC, a wheel, an aftertouch: its input, status, channel and number): every value
 *   where it turned within the window (its successive extremes, which a window's minimum and maximum alone would not all
 *   be: 64 → 100 → 30 → 100 → 64 turns three times; its first value too), in the order they came, then its last value —
 *   so no crossing of any threshold is lost. Only a repetition within one window is merged: a value is never compared
 *   with what went before, so a pad sending CC 127 at each press, or a wheel at 127 sent again after a Start, goes each
 *   time.
 * The first message of a gesture goes at once, opening the window; a note goes at once too, with what waits. A batch is
 * cut to `MAX_BATCH` messages (the server refuses more), the parts sent in order. A message the server dropped (its 429)
 * waits again for the next window, unless a newer one of its control, of its key (a note's channel and number, a program
 * change's channel) or, for the transport, of its input already went or waits: so a rest dropped again and again still
 * goes, one request per window at most, never in a burst, and never an older message after a newer one. `forgetPort`
 * (an input unplugged) and `stop` (the relay ending) let nothing of theirs go again. Pure of the browser: the clock is given.
 */
import { MAX_BATCH } from "../../src/plugins/light/midi/relay-limits.js";

/** One MIDI message of an input. */
export interface RelayedMessage {
  port: string;
  bytes: number[];
}
/** What one request carries. */
export interface RelayBatch {
  messages: RelayedMessage[];
}

/** The message types sent by window: CC, pitch bend, channel and poly aftertouch. */
const continuous = (status: number): boolean => {
  const kind = status & 0xf0;
  return kind === 0xb0 || kind === 0xe0 || kind === 0xd0 || kind === 0xa0;
};
/** One control: its input, its status byte (type and channel), and its number for a CC or a poly aftertouch. */
const controlOf = (m: RelayedMessage): string => {
  const kind = m.bytes[0]! & 0xf0;
  return kind === 0xb0 || kind === 0xa0 ? `${m.port}\u0000${m.bytes[0]}:${m.bytes[1]}` : `${m.port}\u0000${m.bytes[0]}`;
};
/** A discrete message's key, for « a newer one already went »: a note by its channel and number (on and off alike). */
const keyOf = (m: RelayedMessage): string => {
  const kind = m.bytes[0]! & 0xf0;
  return kind === 0x80 || kind === 0x90 ? `${m.port}\u0000note:${m.bytes[0]! & 0x0f}:${m.bytes[1]}` : `${m.port}\u0000${m.bytes[0]}`;
};
/** The transport and the other system messages (Start, Continue, Stop, Song Position…): they concern their whole input. */
const system = (status: number): boolean => status >= 0xf0;
/** A control's value: a pitch bend's 14 bits, a channel aftertouch's pressure, a CC's or a poly aftertouch's value. */
const valueOf = (bytes: readonly number[]): number => {
  const kind = bytes[0]! & 0xf0;
  return kind === 0xe0 ? ((bytes[2] ?? 0) << 7) | (bytes[1] ?? 0) : kind === 0xd0 ? (bytes[1] ?? 0) : (bytes[2] ?? 0);
};

/** A message with the order it came in (to keep every control's own order, and the page's, in a batch). */
interface Arrived {
  seq: number;
  message: RelayedMessage;
}
interface Control {
  /** The order of the last value of it that went. */
  sentSeq: number;
  /** This window's turns (where the control changed direction) and its last value, not sent yet. */
  turns: Arrived[];
  last: Arrived | undefined;
  /** The direction it moves in within the window (-1, 0 before its first move, 1). */
  dir: number;
}

export class MidiBatcher {
  private readonly controls = new Map<string, Control>();
  /** Notes, program changes, transport: waiting for the batch they go in. */
  private discrete: Arrived[] = [];
  /** Per discrete key, the order of the last message of it that went. */
  private readonly keySent = new Map<string, number>();
  /** Per input, the order of the last message of it that went (a transport message is stale after any newer one). */
  private readonly portSent = new Map<string, number>();
  /** Inputs unplugged: what the server drops of theirs is not sent again (until they send again). */
  private readonly gone = new Set<string>();
  /** The relay ended: nothing goes any more, a late 429 changes nothing. */
  private stopped = false;
  private seq = 0;
  private timer: unknown;

  constructor(
    private readonly send: (batch: RelayBatch, done: { dropped: () => void }) => void,
    private readonly later: (fn: () => void, ms: number) => unknown,
    private readonly cancel: (handle: unknown) => void,
    private readonly everyMs = 15,
  ) {}

  /** A message received from one of the page's inputs. */
  push(port: string, bytes: number[]): void {
    if (!bytes.length || this.stopped) return;
    this.gone.delete(port); // plugged in again
    const arrived: Arrived = { seq: ++this.seq, message: { port, bytes } };
    if (!continuous(bytes[0]!)) {
      // a note: at once, with what waits; the window goes on for the controls
      this.discrete.push(arrived);
      this.emit();
      this.open();
      return;
    }
    const key = controlOf(arrived.message);
    let c = this.controls.get(key);
    if (!c) this.controls.set(key, (c = { sentSeq: 0, turns: [], last: undefined, dir: 0 }));
    // within the window only: its first value always goes (never compared with what went before)
    const dir = c.last ? Math.sign(valueOf(bytes) - valueOf(c.last.message.bytes)) : 0;
    if (c.last && dir === 0) return; // the same value again within the window: merged
    // it turned (or this follows its first value): the value before is one of its extremes, kept
    if (c.last && dir !== c.dir) c.turns.push(c.last);
    c.dir = dir;
    c.last = arrived;
    if (this.timer === undefined) {
      // the first message of a gesture: at once, opening the window
      this.emit();
      this.open();
    }
  }

  /** Sends what waits now and closes the window (an input going, the relay stopping): its last values never lost. */
  flush(): void {
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
    this.emit();
  }

  /** The relay ends (Web MIDI off, the page left): after a last `flush`, nothing goes again, no window, a late 429 ignored. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
  }

  /** An input unplugged: what waits of it is forgotten, and what the server drops of it later is not sent again. */
  forgetPort(port: string): void {
    this.gone.add(port);
    this.discrete = this.discrete.filter((a) => a.message.port !== port);
    for (const c of this.controls.values()) {
      if (c.last?.message.port !== port) continue;
      c.turns = [];
      c.last = undefined;
    }
  }

  private open(): void {
    if (this.timer !== undefined) return; // after stop() nothing opens one: no push, and dropped() sends nothing again
    this.timer = this.later(() => {
      this.timer = undefined;
      // something went: a new window while it moves; else the page is at rest until its next message
      if (this.emit()) this.open();
    }, this.everyMs);
  }

  /** What waits: the notes, and per control its turns then its last value (each control's own order kept). */
  private take(): Arrived[] {
    const out: Arrived[] = [...this.discrete];
    this.discrete = [];
    for (const c of this.controls.values()) {
      if (!c.last) continue;
      // its turns then its last value: never one equal to the one before it (push() skips a repeated value)
      out.push(...c.turns, c.last);
      c.sentSeq = c.last.seq;
      c.turns = [];
      c.last = undefined; // its direction starts again with its next value (no turn without a value before it)
    }
    return out;
  }

  /** Sends what waits, in the order it came, cut to `MAX_BATCH` messages per request; true if anything went. */
  private emit(): boolean {
    const arrived = this.take().sort((a, b) => a.seq - b.seq);
    if (!arrived.length) return false;
    for (const a of arrived) {
      if (!continuous(a.message.bytes[0]!)) this.keySent.set(keyOf(a.message), a.seq);
      this.portSent.set(a.message.port, Math.max(this.portSent.get(a.message.port) ?? 0, a.seq));
    }
    for (let i = 0; i < arrived.length; i += MAX_BATCH) {
      const part = arrived.slice(i, i + MAX_BATCH);
      this.send({ messages: part.map((a) => a.message) }, { dropped: () => this.dropped(part) });
    }
    return true;
  }

  /**
   * The server dropped a batch (its 429): each of its messages waits again for the next window, unless a newer one of its
   * control or key already went or waits. One request per window at most: a value dropped again and again still goes,
   * never in a burst.
   */
  private dropped(arrived: Arrived[]): void {
    if (this.stopped) return; // the relay ended: nothing goes again
    arrived = arrived.filter((a) => !this.gone.has(a.message.port)); // an input unplugged: nothing of it either
    const latest = new Map<string, Arrived>();
    for (const a of arrived) if (continuous(a.message.bytes[0]!)) latest.set(controlOf(a.message), a);
    let again = false;
    for (const [key, a] of latest) {
      const c = this.controls.get(key)!;
      if (c.sentSeq > a.seq || c.last) continue; // a newer value went, or waits: this one is stale
      c.last = a; // its last value, sent at the next window even though it went (it was not applied)
      again = true;
    }
    for (const a of arrived) {
      if (continuous(a.message.bytes[0]!)) continue;
      const key = keyOf(a.message);
      // a newer message of its key (a note off after its note on) went: this one would come after it (one that waits
      // again went too, so it is counted there)
      if ((this.keySent.get(key) ?? 0) > a.seq) continue;
      // the transport concerns its whole input: after any newer message of it (a Stop after a Start, a wheel after a
      // Start that would rearm it), it is stale
      if (system(a.message.bytes[0]!) && (this.portSent.get(a.message.port)! > a.seq || this.waits(a.message.port))) continue;
      this.discrete.push(a);
      again = true;
    }
    if (again) this.open();
  }

  /** Whether something of this input waits to go. */
  private waits(port: string): boolean {
    return this.discrete.some((a) => a.message.port === port) || [...this.controls.values()].some((c) => c.last?.message.port === port);
  }
}
