/**
 * What a browser relays of a sustained MIDI flow (docs/specs/midi.md, « Web MIDI »): a CC, a wheel or an aftertouch sends
 * hundreds of values a second, which would spend the live connection's rate. Of those, only the last value per control
 * (its status, channel and number) is sent, at most every `everyMs`; notes, program changes and the transport (Start,
 * Continue, Song Position) all go at once, in order, after what was pending. The last value is never lost: a rest or an
 * end goes out with the next flush. Pure of the browser: the clock is given.
 */

/** The message types sent by last value: CC, pitch bend, channel and poly aftertouch. */
const continuous = (status: number): boolean => {
  const kind = status & 0xf0;
  return kind === 0xb0 || kind === 0xe0 || kind === 0xd0 || kind === 0xa0;
};
/** One control: its status byte (type and channel), and its number for a CC or a poly aftertouch. */
const controlOf = (bytes: number[]): string => {
  const kind = bytes[0]! & 0xf0;
  return kind === 0xb0 || kind === 0xa0 ? `${bytes[0]}:${bytes[1]}` : `${bytes[0]}`;
};

export class MidiCoalescer {
  /** The last value per control, in the order the controls first moved since the last flush. */
  private readonly pending = new Map<string, number[]>();
  private timer: unknown;

  constructor(
    private readonly send: (bytes: number[]) => void,
    private readonly later: (fn: () => void, ms: number) => unknown,
    private readonly cancel: (handle: unknown) => void,
    private readonly everyMs = 15,
  ) {}

  /** A message received from the device. */
  push(bytes: number[]): void {
    if (!bytes.length) return;
    if (!continuous(bytes[0]!)) {
      this.flush(); // what moved before it goes first: the order is kept
      this.send(bytes);
      return;
    }
    const key = controlOf(bytes);
    this.pending.delete(key); // its latest value, at its latest place
    this.pending.set(key, bytes);
    this.timer ??= this.later(() => {
      this.timer = undefined;
      this.flush();
    }, this.everyMs);
  }

  /** Sends what is pending now (the relay stopping, or a message that must follow it). */
  flush(): void {
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    const values = [...this.pending.values()];
    this.pending.clear();
    for (const bytes of values) this.send(bytes);
  }
}
