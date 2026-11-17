/**
 * What a page relays of its Web MIDI inputs (docs/specs/midi.md, « Web MIDI »): **one request per window of 15 ms for the
 * whole page**, every input together (at most ~67 a second, whatever the number of controls), carrying all that changed:
 * - notes, program changes and the transport (Start, Continue, Song Position): every one, in the order they came;
 * - per continuous control that moved (a CC, a wheel, an aftertouch: its input, status, channel and number): every value
 *   where it turned within the window (its successive extremes, which a window's minimum and maximum alone would not all
 *   be: 64 → 100 → 30 → 100 → 64 turns three times), in the order they came, then its last value — so no crossing of any
 *   threshold is lost, whatever the turns the control made. A value equal to the one before it is not repeated.
 * The first message of a gesture goes at once, opening the window; a note goes at once too, with what waits. A batch the
 * server dropped (its 429) is sent again once, marked as such, merged with what came since (per control, the most recent
 * value only: never an older one after a newer), and a resend is never sent again: if it is dropped too, only the last
 * values go at the next window. Pure of the browser: the clock is given.
 */

/** One MIDI message of an input. */
export interface RelayedMessage {
  port: string;
  bytes: number[];
}
/** What one request carries. */
export interface RelayBatch {
  messages: RelayedMessage[];
  /** Sent again after the server dropped it (its 429): never sent a third time. */
  resend?: true;
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
/** A control's value: a pitch bend's 14 bits, a channel aftertouch's pressure, a CC's or a poly aftertouch's value. */
const valueOf = (bytes: readonly number[]): number => {
  const kind = bytes[0]! & 0xf0;
  return kind === 0xe0 ? ((bytes[2] ?? 0) << 7) | (bytes[1] ?? 0) : kind === 0xd0 ? (bytes[1] ?? 0) : (bytes[2] ?? 0);
};

/** A message with the order it came in (to keep every control's own order, and the page's, in a batch). */
interface Arrived {
  seq: number;
  message: RelayedMessage;
  /** Waiting again because its resend was dropped too: if dropped once more, given up (no loop). */
  retry?: true;
}
interface Control {
  /** The value that went last, and the order it came in. */
  sent: number | undefined;
  sentSeq: number;
  /** This window's turns (where the control changed direction) and its last value, not sent yet. */
  turns: Arrived[];
  last: Arrived | undefined;
  /** The direction it moves in within the window (-1, 0 before its first move, 1). */
  dir: number;
}

export class MidiBatcher {
  private readonly controls = new Map<string, Control>();
  /** Notes, program changes, transport: waiting for the batch they go in (only while a window is being built). */
  private discrete: Arrived[] = [];
  private seq = 0;
  private timer: unknown;
  /** Batches sent so far: a resend of an older one never carries its notes after a newer batch went. */
  private batches = 0;

  constructor(
    private readonly send: (batch: RelayBatch, done: { dropped: () => void }) => void,
    private readonly later: (fn: () => void, ms: number) => unknown,
    private readonly cancel: (handle: unknown) => void,
    private readonly everyMs = 15,
  ) {}

  /** A message received from one of the page's inputs. */
  push(port: string, bytes: number[]): void {
    if (!bytes.length) return;
    const arrived: Arrived = { seq: ++this.seq, message: { port, bytes } };
    if (!continuous(bytes[0]!)) {
      // a note: at once, with what waits; the window goes on for the controls
      this.discrete.push(arrived);
      this.emit(false);
      this.open();
      return;
    }
    const key = controlOf(arrived.message);
    let c = this.controls.get(key);
    if (!c) this.controls.set(key, (c = { sent: undefined, sentSeq: 0, turns: [], last: undefined, dir: 0 }));
    const v = valueOf(bytes);
    const before = c.last ? valueOf(c.last.message.bytes) : c.sent;
    const dir = before === undefined ? 0 : Math.sign(v - before);
    if (before !== undefined && dir === 0) return; // the same value again: nothing new
    // it turned: the value before is one of its extremes, kept (a control never sent yet: its first value too)
    if (c.last && dir !== c.dir) c.turns.push(c.last);
    c.dir = dir;
    c.last = arrived;
    if (this.timer === undefined) {
      // the first message of a gesture: at once, opening the window
      this.emit(false);
      this.open();
    }
  }

  /** Sends what waits now and closes the window (an input going, the relay stopping): its last values never lost. */
  flush(): void {
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
    this.emit(false);
  }

  private open(): void {
    if (this.timer !== undefined) return;
    this.timer = this.later(() => {
      this.timer = undefined;
      // something went: a new window while it moves; else the page is at rest until its next message
      if (this.emit(false)) this.open();
    }, this.everyMs);
  }

  /** What waits, in the order it came: notes all, per control its min and max (when new), then its last. */
  private take(): Arrived[] {
    const out: Arrived[] = [...this.discrete];
    this.discrete = [];
    for (const c of this.controls.values()) {
      if (!c.last) continue;
      // its turns then its last value: never one equal to the one before it (push() skips a repeated value)
      out.push(...c.turns, c.last);
      c.sent = valueOf(c.last.message.bytes);
      c.sentSeq = c.last.seq;
      c.turns = [];
      c.last = undefined;
      c.dir = 0;
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  /** Sends one batch of what waits (a resend's `extra` merged in front); true if anything went. */
  private emit(resend: boolean, extra: Arrived[] = []): boolean {
    const arrived = [...extra, ...this.take()].sort((a, b) => a.seq - b.seq);
    if (!arrived.length) return false;
    // only values whose resend was dropped: a resend itself (dropped again, given up)
    if (arrived.every((a) => a.retry)) resend = true;
    const batch: RelayBatch = { messages: arrived.map((a) => a.message), ...(resend ? { resend: true as const } : {}) };
    const number = ++this.batches;
    this.send(batch, { dropped: () => this.dropped(arrived, number, resend) });
    return true;
  }

  /**
   * The server dropped a batch (its 429). Sent again once, marked, merged with what came since: per control only its most
   * recent value (one newer already sent or waiting wins), its notes only if no batch went after it. A resend dropped in
   * turn is not sent again: only its controls' last values go at the next window, if nothing newer came.
   */
  private dropped(arrived: Arrived[], number: number, wasResend: boolean): void {
    const latest = new Map<string, Arrived>();
    const notes: Arrived[] = [];
    for (const a of arrived) {
      if (!continuous(a.message.bytes[0]!)) notes.push(a);
      else latest.set(controlOf(a.message), a);
    }
    const kept: Arrived[] = [];
    for (const [key, a] of latest) {
      const c = this.controls.get(key)!;
      // something newer for it already went (a later batch), or waits (it goes with what follows): this one is stale
      if (c.sentSeq > a.seq || c.last) continue;
      if (wasResend) {
        // the resend dropped too: its last value only, once, at the next window; a value already given that chance, given up
        if (a.retry) continue;
        c.last = { ...a, retry: true };
        c.turns = [];
        c.dir = 0;
        c.sent = undefined;
        continue;
      }
      kept.push(a);
    }
    if (wasResend) {
      if (latest.size) this.open();
      return;
    }
    const resent = [...(number === this.batches ? notes : []), ...kept];
    if (resent.length || [...this.controls.values()].some((c) => c.last)) this.emit(true, resent);
  }
}
