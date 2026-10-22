/**
 * How long the server keeps a message waiting (docs/specs/midi.md, « Diagnostic ») : a MIDI note,
 * a click or a frame is handled when Node is free, so a stall of the event loop delays it. Measured
 * by Node's own histogram over windows of `windowMs`; the worst window of the last hour is kept.
 * The histogram times its own timer's whole interval: its resolution is taken off (at rest, 0).
 */
import { monitorEventLoopDelay } from "node:perf_hooks";

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

export interface LoopDelayStats {
  /** Over the last window, in milliseconds. */
  p50: number;
  p99: number;
  max: number;
  /** The longest stall of the last hour, and when. */
  worst: { ms: number; at: number } | null;
}

const RESOLUTION_MS = 10;
/** A delay past the timer's interval, in ms. */
const ms = (ns: number) => Math.max(0, Math.round((ns / 1e6 - RESOLUTION_MS) * 100) / 100);

export class LoopDelay {
  private histogram: IntervalHistogram | undefined;
  private timer: NodeJS.Timeout | undefined;
  private last: Omit<LoopDelayStats, "worst"> = { p50: 0, p99: 0, max: 0 };
  private readonly windows: { max: number; at: number }[] = [];

  constructor(
    private readonly windowMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.histogram) return;
    this.histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    this.histogram.enable();
    this.timer = setInterval(() => this.close(), this.windowMs);
    this.timer.unref();
  }

  /** Ends a window: its figures become the last ones, its maximum joins the hour. */
  close(): void {
    const h = this.histogram;
    if (!h || h.count === 0) return;
    this.last = { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max) };
    this.record(this.last.max, this.now());
    h.reset();
  }

  /** A window's maximum (for tests: no histogram needed). */
  record(max: number, at: number): void {
    this.windows.push({ max, at });
    while (this.windows.length && this.windows[0]!.at < at - 3_600_000) this.windows.shift();
  }

  stats(): LoopDelayStats {
    const worst = this.windows.reduce<{ max: number; at: number } | null>((w, x) => (!w || x.max > w.max ? x : w), null);
    return { ...this.last, worst: worst ? { ms: worst.max, at: worst.at } : null };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.histogram?.disable();
    this.histogram = undefined;
  }
}
