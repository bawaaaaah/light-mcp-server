/**
 * How fast a look flashes (docs/specs/rules-limits.md, « Clignotement »): photosensitive safety, after
 * WCAG 2.3.1 — no more than three flashes in any one second. Pure: no DOM, no React, the timing and
 * the look's steps are enough.
 */

/** How a look's flashes are counted over the step loop: the number per loop, and the safety ceiling. */
export interface Flashes {
  perLoop: number;
  /** Steps of the cycle the count is over (more than the look's steps for ping-pong); an older server does not send it. */
  period?: number;
  max: number;
}

/** The replay timing of a look: a cadence in beats or seconds, its attack, and the step order. */
export interface RateTiming {
  every: { beats?: number; seconds?: number };
  attack: number;
  order: string;
}

/** The length of one step, in seconds: a cadence in seconds or, else, in beats at the tempo. */
export function stepSeconds(timing: RateTiming, bpm: number): number {
  return timing.every.seconds ?? ((timing.every.beats ?? 1) * 60) / Math.max(1, bpm);
}

/**
 * The look's flash rate in flashes per second over the step cycle: `perLoop` flashes every
 * `period` steps (the look's steps, or there and back for ping-pong) of `seconds` each — 0 when the server sent no flashes (an older one), no step,
 * or a step that never happens. A random or weighted order can put the flashes back to back, so it
 * raises the rate to one flash every two steps (a dark step, then a lit one) when the looped count
 * underestimates it.
 */
export function flashRate(preview: { steps: unknown[]; flashes?: Flashes }, timing: RateTiming, bpm: number): number {
  const flashes = preview.flashes;
  if (flashes === undefined) return 0;
  if (preview.steps.length < 1) return 0;
  const seconds = stepSeconds(timing, bpm);
  if (!(seconds > 0)) return 0;
  const rate = flashes.perLoop / ((flashes.period ?? preview.steps.length) * seconds);
  if ((timing.order === "random" || timing.order === "weighted") && flashes.perLoop > 0) {
    return Math.max(rate, 1 / (2 * seconds));
  }
  return rate;
}

/** Whether a look must freeze its preview before launch: strictly above the safety ceiling. */
export function shouldFreeze(rate: number, max: number): boolean {
  return rate > max;
}