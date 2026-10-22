/**
 * Tempo source for the whole engine: manual BPM, tap tempo, MIDI clock (with SPP position), or the
 * tempo a microphone in the interface hears (its beats too, caught up smoothly).
 * Raises `clockMissing` when MIDI clock is the selected source but no clock arrives — the real
 * trap where nothing follows the tempo and nothing says so (docs/specs/midi.md).
 *
 * Two clocks, never mixed up:
 * - `beats` drives the looks' cadence: monotonic, it follows the clock ticks while the DAW plays,
 *   free-runs at the last known tempo when the clock stops or is missing (looks never freeze
 *   between songs), and ignores position jumps (a scrub must not hold a look on its first step);
 * - `position` is the song position (SPP + ticks) while the DAW plays, for following sections.
 */
import type { MidiMessage } from "../midi/parse.js";
import { MidiClockFollower } from "./midi-clock.js";

export type TempoSource = "manual" | "tap" | "midi" | "audio" | "os2l" | "link";

export interface TempoState {
  bpm: number;
  source: TempoSource;
  /** MIDI clock: ticks arriving; manual/tap: always true. */
  receiving: boolean;
  running: boolean;
  /** Engine beats (quarter notes) for the looks' cadence: monotonic, never frozen. */
  beats: number;
  /** Song position in beats from the MIDI clock (SPP), only while the DAW plays. */
  position: number | null;
  clockMissing: boolean;
  /** MIDI clock ticks arrive, whatever the source: Ableton plays, followed or not. */
  clock: boolean;
}

const TAP_WINDOW = 4;
const TAP_RESET_MS = 2000;
/** A heard beat's phase is caught up over this many beats, never by a jump. */
const CATCH_UP_BEATS = 2;

export class TempoClock {
  private source: TempoSource = "manual";
  private manualBpm = 120;
  private taps: number[] = [];
  private readonly follower = new MidiClockFollower();
  /** free-running phase anchor for manual/tap, and the last followed point for MIDI */
  private anchor = { atMs: 0, beats: 0 };
  /** MIDI: beats played at the last followed point (undefined while not running). */
  private lastPlayed: number | undefined;
  private lastMidiBpm: number | undefined;
  /** audio: a slightly faster or slower pace until `untilMs`, catching up the music's beats. */
  private nudge: { untilMs: number; bpm: number } | undefined;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.anchor.atMs = now();
  }

  setSource(source: TempoSource): void {
    this.reanchor();
    this.lastPlayed = undefined;
    this.source = source;
  }

  setBpm(bpm: number): void {
    if (!(bpm >= 20 && bpm <= 400)) throw new RangeError(`BPM ${bpm} hors de 20..400`);
    this.reanchor();
    this.manualBpm = bpm;
    if (this.source === "midi") this.source = "manual";
  }

  tap(): number | null {
    const t = this.now();
    if (this.taps.length && t - this.taps[this.taps.length - 1]! > TAP_RESET_MS) this.taps = [];
    this.taps.push(t);
    if (this.taps.length > TAP_WINDOW + 1) this.taps.shift();
    if (this.taps.length < 2) return null;
    const span = this.taps[this.taps.length - 1]! - this.taps[0]!;
    const bpm = (60000 * (this.taps.length - 1)) / span;
    this.reanchor();
    this.manualBpm = Math.round(bpm * 10) / 10;
    this.source = "tap";
    this.anchor = { atMs: t, beats: Math.ceil(this.anchor.beats) }; // a tap lands on a beat
    return this.manualBpm;
  }

  /**
   * The tempo of the music from outside: heard in the room (a microphone in the interface, « audio »)
   * or told by DJ software (OS2L, on each beat): its BPM, and how long ago one of its beats fell. The
   * count then runs slightly faster or slower for two beats, until its beats fall on the music's:
   * never a jump (a step would flash twice or be skipped), never backward.
   */
  follow(bpm: number, beatAgoMs?: number, source: "audio" | "os2l" | "link" = "audio"): void {
    if (!(bpm >= 20 && bpm <= 400)) throw new RangeError(`BPM ${bpm} hors de 20..400`);
    this.reanchor();
    this.manualBpm = Math.round(bpm * 10) / 10;
    this.source = source;
    if (beatAgoMs === undefined || beatAgoMs < 0) return;
    // where the count was when the music's beat fell, and how far that is from a whole beat
    const then = this.anchor.beats - (beatAgoMs / 60000) * this.manualBpm;
    const error = Math.round(then) - then;
    if (Math.abs(error) < 0.01) return;
    const span = (CATCH_UP_BEATS * 60000) / this.manualBpm;
    this.nudge = { untilMs: this.anchor.atMs + span, bpm: this.manualBpm * (1 + error / CATCH_UP_BEATS) };
  }

  /** MIDI clock ticks arrive (whatever the selected source). */
  midiReceiving(): boolean {
    return this.follower.state(this.now()).receiving;
  }

  handleMidi(msg: MidiMessage): void {
    this.follower.handle(msg, this.now());
  }

  private reanchor(): void {
    const s = this.state();
    this.anchor = { atMs: this.now(), beats: s.beats };
    this.nudge = undefined;
  }

  state(): TempoState {
    const t = this.now();
    if (this.source === "midi") {
      const s = this.follower.state(t);
      if (s.bpm) this.lastMidiBpm = s.bpm;
      const bpm = s.bpm ?? this.lastMidiBpm ?? this.manualBpm;
      const freeRun = this.anchor.beats + ((t - this.anchor.atMs) / 60000) * bpm;
      let beats: number;
      if (s.running) {
        // Follow the ticks played (SPP jumps do not move them); a start continues from the free-run.
        beats = this.lastPlayed === undefined ? freeRun : this.anchor.beats + (s.played - this.lastPlayed);
        this.lastPlayed = s.played;
        this.anchor = { atMs: t, beats };
      } else {
        this.lastPlayed = undefined; // stopped or missing: free-run from the last followed point
        beats = freeRun;
      }
      return { bpm, source: "midi", receiving: s.receiving, running: s.running, beats, position: s.running ? s.beats : null, clockMissing: !s.receiving, clock: s.receiving };
    }
    let beats = this.anchor.beats + ((t - this.anchor.atMs) / 60000) * this.manualBpm;
    if (this.nudge) {
      const caught = Math.min(t, this.nudge.untilMs) - this.anchor.atMs;
      beats += (caught / 60000) * (this.nudge.bpm - this.manualBpm);
    }
    return { bpm: this.manualBpm, source: this.source, receiving: true, running: true, beats, position: null, clockMissing: false, clock: this.follower.state(t).receiving };
  }
}
