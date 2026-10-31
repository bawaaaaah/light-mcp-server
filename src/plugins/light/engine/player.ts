/**
 * Plays a technique's steps over time (docs/specs/engine-effects-timing.md):
 * - cadence in beats (follows the tempo, no phase jump when the BPM changes) or in seconds;
 * - attack = fade / step duration (0 % « claque », 100 % « respire »);
 * - order: loop, pingpong, random, weighted random (deterministic per look);
 * - optional entry fade from the previous state (« pas 0 d'entrée »).
 */
import { z } from "zod";
import { rng, type CellState, type Step } from "./techniques.js";
import type { Color } from "../venue/venue.js";

/** A duration in beats (follows the tempo) or in seconds (fixed). */
export const EverySchema = z.union([z.object({ beats: z.number().positive() }), z.object({ seconds: z.number().positive() })]);
export type Every = z.infer<typeof EverySchema>;

export const TimingSchema = z.object({
  /** Step length: beats (musical) or seconds (fixed). */
  every: EverySchema.prefault({ beats: 1 }),
  attack: z.number().min(0).max(1).default(0),
  order: z.enum(["loop", "pingpong", "random", "weighted"]).default("loop"),
  /** Weighted order: weight per step (missing = 1). */
  weights: z.array(z.number().min(0)).optional(),
  /** Entry fade (seconds) from what was on stage before. */
  entryFade: z.number().min(0).max(30).default(0),
});
export type Timing = z.infer<typeof TimingSchema>;

export function mixColor(a: Color, b: Color, t: number): Color {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Color>;
  const out: Color = {};
  for (const k of keys) out[k] = (a[k] ?? 0) * (1 - t) + (b[k] ?? 0) * t;
  return out;
}

function mixStep(a: Step, b: Step, t: number): Step {
  return b.map((cb, k) => {
    const ca = a[k];
    if (!cb) return ca ?? null;
    if (!ca) return cb;
    return mixColor(ca, cb, t);
  });
}

/** Smoothstep easing for fades. */
const ease = (t: number) => t * t * (3 - 2 * t);

export class LookPlayer {
  private startBeats = 0;
  private startMs = 0;
  private readonly random: (i: number) => number;

  constructor(
    readonly steps: Step[],
    readonly timing: Timing,
    seed: number,
    private readonly entry: Step | null = null,
  ) {
    const cache = new Map<number, number>();
    const next = rng(seed);
    const n = steps.length;
    const weights = timing.weights?.length === n ? timing.weights : undefined;
    const total = weights?.reduce((a, b) => a + b, 0) ?? n;
    this.random = (i) => {
      while (!cache.has(i)) {
        const k = cache.size;
        let pick: number;
        if (weights && timing.order === "weighted") {
          let x = next() * total;
          pick = 0;
          while (pick < n - 1 && x >= weights[pick]!) x -= weights[pick++]!;
        } else {
          pick = Math.floor(next() * n);
          // avoid repeating the same step twice in a row (except in weighted mode, where repeats are the point)
          if (n > 1 && k > 0 && pick === cache.get(k - 1)) pick = (pick + 1) % n;
        }
        cache.set(k, pick);
      }
      return cache.get(i)!;
    };
  }

  start(nowMs: number, beats: number): void {
    this.startMs = nowMs;
    this.startBeats = beats;
  }

  /** Step number played at sequence index i. */
  stepAt(i: number): number {
    const n = this.steps.length;
    if (n === 1) return 0;
    switch (this.timing.order) {
      case "loop":
        return i % n;
      case "pingpong": {
        const period = 2 * n - 2;
        const p = i % period;
        return p < n ? p : period - p;
      }
      default:
        return this.random(i);
    }
  }

  /** Progress in units of `every` since start (fractional): steps for the timing, cycles for a move. */
  position(nowMs: number, beats: number, every: Every = this.timing.every): number {
    return "beats" in every ? (beats - this.startBeats) / every.beats : (nowMs - this.startMs) / 1000 / every.seconds;
  }

  /**
   * Step of a raw-channel sequence of `count` steps at this time: the same step as the colours when
   * the counts match (same order), else a plain loop on the look's clock.
   */
  rawStep(nowMs: number, beats: number, count: number): number {
    const i = Math.floor(Math.max(0, this.position(nowMs, beats)));
    return count === this.steps.length ? this.stepAt(i) : i % count;
  }

  render(nowMs: number, beats: number): Step {
    const elapsedS = (nowMs - this.startMs) / 1000;
    const pos = Math.max(0, this.position(nowMs, beats));
    const i = Math.floor(pos);
    const frac = pos - i;
    const cur = this.steps[this.stepAt(i)]!;
    let state: Step;
    if (this.steps.length === 1 || this.timing.attack === 0) state = cur;
    else if (i === 0) state = cur;
    else {
      const prev = this.steps[this.stepAt(i - 1)]!;
      state = frac >= this.timing.attack ? cur : mixStep(prev, cur, ease(frac / this.timing.attack));
    }
    if (this.entry && this.timing.entryFade > 0 && elapsedS < this.timing.entryFade) return mixStep(this.entry, state, ease(elapsedS / this.timing.entryFade));
    return state;
  }
}

export type { CellState };
