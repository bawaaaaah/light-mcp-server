/**
 * Drift-compensated frame scheduler for the DMX engine.
 *
 * - Regular frames at `rateHz` (default 44, the DMX refresh ceiling), scheduled against absolute
 *   target times so timer lateness never accumulates.
 * - `requestFrame()` renders an extra frame as soon as possible when a command changes the state:
 *   without it, a MIDI trigger could wait a full period (22.7 ms at 44 Hz) — beyond the
 *   MIDI → DMX < 10 ms budget (docs/roadmap.md, P2). Extra frames are spaced by `minGapMs`.
 *
 * Time and timers are injectable for tests.
 */

export interface TickerClock {
  now(): number; // ms, monotonic
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: TickerClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export type FrameReason = "tick" | "request";

export interface TickerOptions {
  rateHz?: number;
  minGapMs?: number;
  clock?: TickerClock;
}

export class Ticker {
  readonly periodMs: number;
  private readonly minGapMs: number;
  private readonly clock: TickerClock;
  private nextTickAt = 0;
  private lastFrameAt = -Infinity;
  private tickHandle: unknown = null;
  private requestHandle: unknown = null;
  private running = false;

  constructor(
    private readonly onFrame: (nowMs: number, reason: FrameReason) => void,
    options: TickerOptions = {},
  ) {
    this.periodMs = 1000 / (options.rateHz ?? 44);
    this.minGapMs = options.minGapMs ?? 4;
    this.clock = options.clock ?? realClock;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextTickAt = this.clock.now();
    this.scheduleTick();
  }

  stop(): void {
    this.running = false;
    if (this.tickHandle !== null) this.clock.clearTimeout(this.tickHandle);
    if (this.requestHandle !== null) this.clock.clearTimeout(this.requestHandle);
    this.tickHandle = this.requestHandle = null;
  }

  /** Asks for a frame as soon as possible (coalesced; respects minGapMs). */
  requestFrame(): void {
    if (!this.running || this.requestHandle !== null) return;
    const wait = Math.max(0, this.lastFrameAt + this.minGapMs - this.clock.now());
    this.requestHandle = this.clock.setTimeout(() => {
      this.requestHandle = null;
      if (this.running) this.frame("request");
    }, wait);
  }

  private scheduleTick(): void {
    const delay = Math.max(0, this.nextTickAt - this.clock.now());
    this.tickHandle = this.clock.setTimeout(() => {
      if (!this.running) return;
      const now = this.clock.now();
      // Skip a regular tick that would land right after a requested frame.
      if (now - this.lastFrameAt >= this.minGapMs) this.frame("tick");
      this.nextTickAt += this.periodMs;
      // If we fell far behind (e.g. process paused), resynchronise instead of bursting.
      if (now - this.nextTickAt > this.periodMs * 2) this.nextTickAt = now + this.periodMs;
      this.scheduleTick();
    }, delay);
  }

  private frame(reason: FrameReason): void {
    const now = this.clock.now();
    this.lastFrameAt = now;
    this.onFrame(now, reason);
  }
}
