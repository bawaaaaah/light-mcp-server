/**
 * Follows an incoming MIDI clock (24 PPQN) plus Start/Continue/Stop and Song Position Pointer.
 * Pure state machine: callers feed messages with their timestamp (ms), so it is fully testable and
 * the same code runs on every MIDI source.
 *
 * Tempo is estimated over a sliding window of tick intervals (one beat by default), which smooths
 * the jitter of USB/IAC/RTP delivery without lagging a tempo change by more than one beat.
 */
import type { MidiMessage } from "../midi/parse.js";

export const PPQN = 24;
const CLOCKS_PER_SIXTEENTH = PPQN / 4;

export interface MidiClockOptions {
  /** Number of tick intervals averaged for the tempo estimate. */
  window?: number;
  /** A tick interval this many times the current average is treated as a gap, not tempo. */
  gapFactor?: number;
  /** No tick for this long (ms) means the clock is gone. */
  timeoutMs?: number;
}

export interface MidiClockState {
  running: boolean;
  /** Ticks are arriving (regardless of transport state). */
  receiving: boolean;
  bpm: number | null;
  /** Position in quarter-note beats since song start, from SPP + ticks. */
  beats: number;
}

export class MidiClockFollower {
  private readonly window: number;
  private readonly gapFactor: number;
  private readonly timeoutMs: number;
  private intervals: number[] = [];
  private lastTick: number | null = null;
  private running = false;
  private sixteenths = 0;
  private ticksSincePosition = 0;

  constructor(options: MidiClockOptions = {}) {
    this.window = options.window ?? PPQN;
    this.gapFactor = options.gapFactor ?? 4;
    this.timeoutMs = options.timeoutMs ?? 500;
  }

  handle(msg: MidiMessage, nowMs: number): void {
    switch (msg.type) {
      case "clock":
        this.tick(nowMs);
        return;
      case "start":
        this.running = true;
        this.sixteenths = 0;
        this.ticksSincePosition = 0;
        return;
      case "continue":
        this.running = true;
        return;
      case "stop":
        this.running = false;
        return;
      case "songposition":
        this.sixteenths = msg.sixteenths;
        this.ticksSincePosition = 0;
        return;
      default:
        return;
    }
  }

  private tick(nowMs: number): void {
    if (this.lastTick !== null) {
      const interval = nowMs - this.lastTick;
      const avg = this.averageInterval();
      const isGap = interval > this.timeoutMs || (avg !== null && interval > avg * this.gapFactor);
      if (isGap) {
        this.intervals = [];
      } else {
        this.intervals.push(interval);
        if (this.intervals.length > this.window) this.intervals.shift();
      }
    }
    this.lastTick = nowMs;
    if (this.running) {
      this.ticksSincePosition += 1;
      if (this.ticksSincePosition >= CLOCKS_PER_SIXTEENTH) {
        this.sixteenths += Math.floor(this.ticksSincePosition / CLOCKS_PER_SIXTEENTH);
        this.ticksSincePosition %= CLOCKS_PER_SIXTEENTH;
      }
    }
  }

  private averageInterval(): number | null {
    if (this.intervals.length === 0) return null;
    return this.intervals.reduce((a, b) => a + b, 0) / this.intervals.length;
  }

  state(nowMs: number): MidiClockState {
    const receiving = this.lastTick !== null && nowMs - this.lastTick <= this.timeoutMs;
    const avg = this.averageInterval();
    return {
      running: this.running && receiving,
      receiving,
      bpm: receiving && avg !== null && avg > 0 ? 60000 / (avg * PPQN) : null,
      beats: this.sixteenths / 4 + this.ticksSincePosition / PPQN,
    };
  }
}
