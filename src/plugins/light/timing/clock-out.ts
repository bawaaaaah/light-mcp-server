/**
 * MIDI clock out (docs/specs/midi.md, « Horloge en sortie ») : the light's tempo — set by hand,
 * tapped, heard by the microphone or told by the DJ — sent as 24 clocks per beat, so Ableton or a
 * drum machine set to follow it keeps that tempo. Driven by the engine's beat count, so a tempo
 * change or a phase catch-up goes out as it happens. Only clocks: no Start or Stop, which would
 * start or stop the transport of whatever follows. Silent while the tempo itself follows an incoming
 * MIDI clock (it would echo it). Pure: a beat count in, bytes out; the plugin calls `tick` often.
 */

const CLOCK = 0xf8;
const PER_BEAT = 24;

export class ClockOut {
  private sent: number | undefined;

  constructor(
    private readonly tempo: () => { beats: number; source: string },
    private readonly send: (bytes: number[]) => void,
  ) {}

  /** Sends the clocks due since the last call. */
  tick(): void {
    const { beats, source } = this.tempo();
    if (source === "midi") {
      this.sent = undefined; // following a clock: never echo it; start afresh after
      return;
    }
    const due = Math.floor(beats * PER_BEAT);
    if (this.sent === undefined || due < this.sent) {
      this.sent = due; // the first call, or the count went back (a reset): from now on
      return;
    }
    // a stall (a busy machine) sends one clock, not a burst: the follower takes the pace up again
    const n = due - this.sent > PER_BEAT ? 1 : due - this.sent;
    for (let i = 0; i < n; i++) this.send([CLOCK]);
    this.sent = due;
  }
}
