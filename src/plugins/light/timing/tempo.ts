/**
 * Tempo source for the whole engine: manual BPM, tap tempo, or MIDI clock (with SPP position).
 * Raises `clockMissing` when MIDI clock is the selected source but no clock arrives — the real
 * trap where nothing follows the tempo and nothing says so (docs/specs/midi.md).
 */
import type { MidiMessage } from "../midi/parse.js";
import { MidiClockFollower } from "./midi-clock.js";

export type TempoSource = "manual" | "tap" | "midi";

export interface TempoState {
  bpm: number;
  source: TempoSource;
  /** MIDI clock: ticks arriving; manual/tap: always true. */
  receiving: boolean;
  running: boolean;
  /** Beat position (quarter notes) — MIDI clock/SPP when available, otherwise free-running. */
  beats: number;
  clockMissing: boolean;
}

const TAP_WINDOW = 4;
const TAP_RESET_MS = 2000;

export class TempoClock {
  private source: TempoSource = "manual";
  private manualBpm = 120;
  private taps: number[] = [];
  private readonly follower = new MidiClockFollower();
  /** free-running phase anchor for manual/tap */
  private anchor = { atMs: 0, beats: 0 };

  constructor(private readonly now: () => number = () => performance.now()) {
    this.anchor.atMs = now();
  }

  setSource(source: TempoSource): void {
    this.reanchor();
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

  handleMidi(msg: MidiMessage): void {
    this.follower.handle(msg, this.now());
  }

  private reanchor(): void {
    const s = this.state();
    this.anchor = { atMs: this.now(), beats: s.beats };
  }

  state(): TempoState {
    const t = this.now();
    if (this.source === "midi") {
      const s = this.follower.state(t);
      return { bpm: s.bpm ?? this.manualBpm, source: "midi", receiving: s.receiving, running: s.running, beats: s.beats, clockMissing: !s.receiving };
    }
    const beats = this.anchor.beats + ((t - this.anchor.atMs) / 60000) * this.manualBpm;
    return { bpm: this.manualBpm, source: this.source, receiving: true, running: true, beats, clockMissing: false };
  }
}
