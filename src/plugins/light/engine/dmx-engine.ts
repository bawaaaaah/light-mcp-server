/**
 * DMX engine, phase 1: programmer (parked channels) + blackout, rendered into the output universes
 * on every frame of the Ticker (regular 44 Hz ticks + immediate frames on state changes).
 * Later phases add, in this order (docs/specs/engine-effects-timing.md): playbacks and merge,
 * groups/masters, flash, rules mask, attribute → DMX conversion.
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
  private readonly ticker: Ticker;
  private readonly listeners = new Set<EngineFrameListener>();
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

  parked(universe: number): Record<number, number> {
    return Object.fromEntries(this.programmer.get(universe) ?? []);
  }

  setBlackout(on: boolean): void {
    this.blackout = on;
  }

  isBlackout(): boolean {
    return this.blackout;
  }

  /** Computes the output buffers. Exposed for tests and previews. */
  render(): readonly Uint8Array[] {
    for (let u = 1; u <= this.output.count; u++) {
      const buf = this.output.buffers[u - 1]!;
      buf.fill(0);
      if (this.blackout) continue;
      for (const [ch, v] of this.programmer.get(u) ?? []) buf[ch - 1] = v;
    }
    return this.output.buffers;
  }

  private frame(now: number): void {
    const buffers = this.render();
    this.frames += 1;
    for (const l of this.listeners) l(buffers, now);
  }
}
