/**
 * What a browser relays of a sustained MIDI flow (docs/specs/midi.md, « Web MIDI »): a CC, a wheel or an aftertouch sends
 * hundreds of values a second, which would spend the live connection's rate. Per control (its status, channel and number):
 * - a value with no window open goes **at once**, and opens a window of `everyMs`;
 * - within the window, the values are kept: at its end go the **extreme** of the window (the value farthest from the last
 *   sent: a push and its release inside one window, 127 then 0, or a wheel's 64, 100, 64, keep their crossing of any
 *   threshold) then the **last** one, each only if it differs from what went before; then a new window, while it moves.
 * Notes, program changes and the transport (Start, Continue, Song Position) go at once, in order, after what was pending.
 * Every send spends a token of a rate kept under the server's (300 a second, 300 ahead: the server allows 400 and 800):
 * with none left, a control's values wait for the next window, the last one first, and are never lost. A value the server
 * dropped (`dropped`, its 429) is sent again once, if nothing newer went. Pure of the browser: the clock is given.
 */

/** The message types sent by window: CC, pitch bend, channel and poly aftertouch. */
const continuous = (status: number): boolean => {
  const kind = status & 0xf0;
  return kind === 0xb0 || kind === 0xe0 || kind === 0xd0 || kind === 0xa0;
};
/** One control: its status byte (type and channel), and its number for a CC or a poly aftertouch. */
const controlOf = (bytes: readonly number[]): string => {
  const kind = bytes[0]! & 0xf0;
  return kind === 0xb0 || kind === 0xa0 ? `${bytes[0]}:${bytes[1]}` : `${bytes[0]}`;
};
/** A control's value: a pitch bend's 14 bits, a channel aftertouch's pressure, a CC's or a poly aftertouch's value. */
const valueOf = (bytes: readonly number[]): number => {
  const kind = bytes[0]! & 0xf0;
  return kind === 0xe0 ? ((bytes[2] ?? 0) << 7) | (bytes[1] ?? 0) : kind === 0xd0 ? (bytes[1] ?? 0) : (bytes[2] ?? 0);
};
const same = (a: readonly number[] | undefined, b: readonly number[]): boolean => a !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);

/** The rate the page keeps under the server's lossy route (400 a second, 800 ahead). */
const RATE_PER_SECOND = 300;
const BURST = 300;

interface Control {
  /** The window open (its timer), if any. */
  timer: unknown;
  /** What went last for this control. */
  sent: number[] | undefined;
  /** The window's extreme and last values, not sent yet. */
  peak: number[] | undefined;
  last: number[] | undefined;
  /** Sent again even if equal to what went (the server dropped it). */
  force: boolean;
}

export class MidiCoalescer {
  private readonly controls = new Map<string, Control>();
  private tokens = BURST;
  private refilledAt: number;

  constructor(
    private readonly send: (bytes: number[]) => void,
    private readonly later: (fn: () => void, ms: number) => unknown,
    private readonly cancel: (handle: unknown) => void,
    private readonly everyMs = 15,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.refilledAt = this.now();
  }

  /** A message received from the device. */
  push(bytes: number[]): void {
    if (!bytes.length) return;
    if (!continuous(bytes[0]!)) {
      this.flush(false); // what moved before it goes first: the order is kept
      this.send(bytes);
      return;
    }
    const key = controlOf(bytes);
    let c = this.controls.get(key);
    if (!c) this.controls.set(key, (c = { timer: undefined, sent: undefined, peak: undefined, last: undefined, force: false }));
    if (c.timer === undefined && c.last === undefined && this.take()) {
      // no window open: at once, and a window for what follows
      c.sent = bytes;
      this.send(bytes);
      this.open(key, c);
      return;
    }
    // within the window: its extreme (farthest from what went) and its last value
    const from = c.sent ? valueOf(c.sent) : valueOf(bytes);
    if (!c.peak || Math.abs(valueOf(bytes) - from) > Math.abs(valueOf(c.peak) - from)) c.peak = bytes;
    c.last = bytes;
    if (c.timer === undefined) this.open(key, c);
  }

  /** The server dropped `bytes` (its 429): sent again once, at the next window, if nothing newer went for its control. */
  dropped(bytes: number[]): void {
    if (!bytes.length || !continuous(bytes[0]!)) return;
    const key = controlOf(bytes);
    const c = this.controls.get(key);
    if (!c || !same(c.sent, bytes) || c.last !== undefined) return;
    c.last = bytes;
    c.force = true;
    if (c.timer === undefined) this.open(key, c);
  }

  /**
   * Sends what is pending now, ahead of a message that must follow it (`closing` false: the windows go on), or because the
   * input goes (`closing`: every window closed). The last value of each control always goes, whatever the rate.
   */
  flush(closing = true): void {
    for (const [key, c] of this.controls) {
      this.release(c, true);
      if (closing) {
        if (c.timer !== undefined) this.cancel(c.timer);
        this.controls.delete(key);
      }
    }
  }

  private open(key: string, c: Control): void {
    c.timer = this.later(() => {
      c.timer = undefined;
      // something went, or waits for a token: a new window while it moves; else the control is at rest
      if (this.release(c, false) || c.last !== undefined) this.open(key, c);
    }, this.everyMs);
  }

  /** Sends a window's extreme then its last value (what differs from what went); true if anything went. */
  private release(c: Control, always: boolean): boolean {
    const last = c.last;
    if (!last) return false;
    const peak = c.peak;
    let went = false;
    // the extreme first, when a token is left beside the last value's: a crossing kept
    if (peak && !same(peak, last) && !same(c.sent, peak) && (always || this.tokens >= 2) && this.take(always)) {
      c.sent = peak;
      this.send(peak);
      went = true;
    }
    if (same(c.sent, last) && !c.force) {
      c.peak = c.last = undefined;
      return went;
    }
    if (!this.take(always)) return went; // no token: it waits for the next window, never lost
    c.sent = last;
    c.peak = c.last = undefined;
    c.force = false;
    this.send(last);
    return true;
  }

  /** A token of the page's rate; `always`: a value that must go (a flush) goes anyway. */
  private take(always = false): boolean {
    const now = this.now();
    this.tokens = Math.min(BURST, this.tokens + ((now - this.refilledAt) / 1000) * RATE_PER_SECOND);
    this.refilledAt = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return always;
  }
}
