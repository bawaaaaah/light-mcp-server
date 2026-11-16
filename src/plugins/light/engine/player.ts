/**
 * Plays a technique's steps over time (docs/specs/engine-effects-timing.md):
 * - cadence in beats (follows the tempo, no phase jump when the BPM changes) or in seconds;
 * - attack = fade / step duration (0 % « claque », 100 % « respire »);
 * - order: loop, pingpong, random, weighted random (deterministic per look);
 * - optional entry fade from black on the cells the look paints (« pas 0 d'entrée »); a look that replaces another of
 *   its exclusive group comes in over it instead (ShowRuntime, crossfade).
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
  /**
   * Entry fade (seconds): from black on the cells the look paints. A look that replaces another of its
   * exclusive group comes in over it instead, as a crossfade (docs/specs/engine-effects-timing.md).
   */
  entryFade: z.number().min(0).max(30).default(0),
  /**
   * Exit fade (seconds): on stop, keep playing while scaling colours to black. When another look of its
   * exclusive group replaces it, it leaves under the incoming one over this time, or over the incoming
   * look's entry fade when it has none.
   */
  exitFade: z.number().min(0).max(30).default(0),
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
export const ease = (t: number): number => t * t * (3 - 2 * t);

/** The order a sequence of `n` items is played in: `TimingSchema.order` (and its `weights`), drawn from `seed`. */
export interface SequenceSpec {
  order: Timing["order"];
  n: number;
  /** Weighted order: weight per item (used only when there is one per item; missing = plain random). */
  weights?: readonly number[] | undefined;
  seed: number;
}

/**
 * The item played at sequence index `i` (0, 1, 2…): loop, ping-pong, or drawn at random — deterministic for a seed,
 * never the same item twice in a row except in weighted order (where repeats are the point). The draws are memoised:
 * the function returned must be kept to replay the same sequence cheaply (a look's steps, a move's path stops, T28).
 * Pure: the same spec gives the same sequence every time.
 */
export function stepSequence({ order, n, weights: given, seed }: SequenceSpec): (i: number) => number {
  if (n <= 1) return () => 0;
  if (order === "loop") return (i) => ((Math.floor(i) % n) + n) % n;
  if (order === "pingpong") {
    const period = 2 * n - 2;
    return (i) => {
      const p = ((Math.floor(i) % period) + period) % period;
      return p < n ? p : period - p;
    };
  }
  const cache: number[] = [];
  const next = rng(seed);
  const weights = given?.length === n ? given : undefined;
  const total = weights?.reduce((a, b) => a + b, 0) ?? n;
  return (i) => {
    const at = Math.max(0, Math.floor(i));
    while (cache.length <= at) {
      const k = cache.length;
      let pick: number;
      if (weights && order === "weighted") {
        let x = next() * total;
        pick = 0;
        while (pick < n - 1 && x >= weights[pick]!) x -= weights[pick++]!;
      } else {
        pick = Math.floor(next() * n);
        // avoid repeating the same step twice in a row (except in weighted mode, where repeats are the point)
        if (k > 0 && pick === cache[k - 1]) pick = (pick + 1) % n;
      }
      cache.push(pick);
    }
    return cache[at]!;
  };
}

export class LookPlayer {
  private startBeats = 0;
  private startMs = 0;
  private readonly sequence: (i: number) => number;

  constructor(
    readonly steps: Step[],
    readonly timing: Timing,
    seed: number,
    private readonly entry: Step | null = null,
  ) {
    this.sequence = stepSequence({ order: timing.order, n: steps.length, weights: timing.weights, seed });
  }

  start(nowMs: number, beats: number): void {
    this.startMs = nowMs;
    this.startBeats = beats;
  }

  /** Step number played at sequence index i. */
  stepAt(i: number): number {
    return this.sequence(i);
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

  /**
   * The fade the look is still rising through (its own entry fade, smoothstep, the ramp the colours
   * are mixed with): the weight its raw channels ride with, so a look's scene rises and falls
   * symmetrically, like its colours. 1 once the entry is over, and without one.
   */
  entryWeight(nowMs: number): number {
    const elapsedS = (nowMs - this.startMs) / 1000;
    if (!this.entry || this.timing.entryFade <= 0 || elapsedS >= this.timing.entryFade) return 1;
    return ease(Math.min(1, Math.max(0, elapsedS / this.timing.entryFade)));
  }

  /** The look's colours at this time without its entry fade: what it shows once risen (a colour wheel pre-positions on it). */
  state(nowMs: number, beats: number): Step {
    const pos = Math.max(0, this.position(nowMs, beats));
    const i = Math.floor(pos);
    const frac = pos - i;
    const cur = this.steps[this.stepAt(i)]!;
    if (this.steps.length === 1 || this.timing.attack === 0 || i === 0) return cur;
    const prev = this.steps[this.stepAt(i - 1)]!;
    return frac >= this.timing.attack ? cur : mixStep(prev, cur, ease(frac / this.timing.attack));
  }

  render(nowMs: number, beats: number): Step {
    const elapsedS = (nowMs - this.startMs) / 1000;
    const state = this.state(nowMs, beats);
    if (this.entry && this.timing.entryFade > 0 && elapsedS < this.timing.entryFade) return mixStep(this.entry, state, ease(elapsedS / this.timing.entryFade));
    return state;
  }
}

export type { CellState };
