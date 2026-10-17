/**
 * DMX engine: show renderer (looks, groups, venue) + programmer (parked channels) + blackout, rendered into the output universes
 * on every frame of the Ticker (regular 44 Hz ticks + immediate frames on state changes).
 * The rules mask (docs/specs/rules-limits.md) comes next, as the last stage before output.
 */
import { Ticker, type TickerOptions } from "./ticker.js";
import { UniverseStore } from "../output/universes.js";

export interface EngineFrameListener {
  (buffers: readonly Uint8Array[], nowMs: number): void;
}

export class DmxEngine {
  readonly output: UniverseStore;
  /** universe (1-based) → channel (1-based) → value */
  private readonly programmer = new Map<number, Map<number, number>>();
  private blackout = false;
  private blackoutKeep: (() => Map<number, number[]>) | undefined;
  private readonly ticker: Ticker;
  private readonly listeners = new Set<EngineFrameListener>();
  /** Show renderer (looks, groups, venue conversion), called before parks and blackout. */
  private renderer: ((buffers: Uint8Array[]) => void) | undefined;
  /** What still holds after the parks (the locked rules): a forced channel overrides the show, not that. */
  private guard: ((buffers: Uint8Array[]) => void) | undefined;
  frames = 0;

  constructor(universes: number, tickerOptions: TickerOptions = {}) {
    this.output = new UniverseStore(universes);
    this.ticker = new Ticker((now) => this.frame(now), tickerOptions);
  }

  start(): void {
    this.ticker.start();
  }

  stop(): void {
    this.ticker.stop();
  }

  onFrame(fn: EngineFrameListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Renders a frame as soon as possible (call after any state change). */
  requestFrame(): void {
    this.ticker.requestFrame();
  }

  setRenderer(fn: (buffers: Uint8Array[]) => void): void {
    this.renderer = fn;
  }

  setGuard(fn: (buffers: Uint8Array[]) => void): void {
    this.guard = fn;
  }

  park(universe: number, channel: number, value: number): void {
    this.output.check(universe, channel);
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError(`valeur ${value} hors de 0..255`);
    let u = this.programmer.get(universe);
    if (!u) this.programmer.set(universe, (u = new Map()));
    u.set(channel, value);
  }

  release(universe?: number, channels?: number[]): number {
    if (universe === undefined) {
      const n = [...this.programmer.values()].reduce((a, m) => a + m.size, 0);
      this.programmer.clear();
      return n;
    }
    this.output.check(universe);
    const u = this.programmer.get(universe);
    if (!u) return 0;
    if (!channels) {
      const n = u.size;
      this.programmer.delete(universe);
      return n;
    }
    let n = 0;
    for (const c of channels) if (u.delete(c)) n += 1;
    return n;
  }

  /** Channels forced from the DMX console, every universe together. */
  parkedCount(): number {
    return [...this.programmer.values()].reduce((n, u) => n + u.size, 0);
  }

  parked(universe: number): Record<number, number> {
    return Object.fromEntries(this.programmer.get(universe) ?? []);
  }

  setBlackout(on: boolean): void {
    this.blackout = on;
  }

  isBlackout(): boolean {
    return this.blackout;
  }

  /** Slots (universe → 0-based indices) that Blackout leaves untouched: moving heads' pan/tilt. */
  setBlackoutKeep(fn: () => Map<number, number[]>): void {
    this.blackoutKeep = fn;
  }

  /** Computes the output buffers. Exposed for tests and previews. */
  render(): readonly Uint8Array[] {
    for (const buf of this.output.buffers) buf.fill(0);
    try {
      this.renderer?.(this.output.buffers);
    } catch (err) {
      // A broken look must never stop the output: keep sending the rest.
      console.warn("render:", (err as Error).message);
    }
    for (let u = 1; u <= this.output.count; u++) {
      const buf = this.output.buffers[u - 1]!;
      for (const [ch, v] of this.programmer.get(u) ?? []) buf[ch - 1] = v;
    }
    try {
      this.guard?.(this.output.buffers);
    } catch (err) {
      console.warn("guard:", (err as Error).message);
    }
    if (this.blackout) {
      // Light goes out, heads stay where they are (a blackout must not make them swing).
      const keep = this.blackoutKeep?.() ?? new Map<number, number[]>();
      for (let u = 1; u <= this.output.count; u++) {
        const buf = this.output.buffers[u - 1]!;
        const slots = keep.get(u);
        if (!slots?.length) {
          buf.fill(0);
          continue;
        }
        const kept = slots.map((i) => [i, buf[i]!] as const);
        buf.fill(0);
        for (const [i, v] of kept) buf[i] = v;
      }
    }
    return this.output.buffers;
  }

  private frame(now: number): void {
    const buffers = this.render();
    this.frames += 1;
    for (const l of this.listeners) l(buffers, now);
  }
}
