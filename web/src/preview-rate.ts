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
  /** The most flashes in `w` steps in a row of the cycle (w = 0..period); an older server does not send it. */
  windows?: number[];
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
 * The most flashes the look can put in one second, the worst second of its cycle (WCAG 2.3.1): the server's
 * `windows` over the steps that start in one second, whole cycles counted by `perLoop`. Without `windows` (an
 * older server) the average over the cycle, `perLoop` per `period` steps of `seconds` each. 0 when the server sent
 * no flashes, no step, or a step that never happens.
 */
export function flashRate(preview: { steps: unknown[]; flashes?: Flashes }, timing: RateTiming, bpm: number): number {
  const flashes = preview.flashes;
  if (flashes === undefined) return 0;
  if (preview.steps.length < 1) return 0;
  const seconds = stepSeconds(timing, bpm);
  if (!(seconds > 0)) return 0;
  const period = flashes.period ?? preview.steps.length;
  if (flashes.windows === undefined || flashes.windows.length !== period + 1) {
    const average = flashes.perLoop / (period * seconds);
    // a random or weighted order can put the flashes back to back: one every two steps
    return (timing.order === "random" || timing.order === "weighted") && flashes.perLoop > 0 ? Math.max(average, 1 / (2 * seconds)) : average;
  }
  const w = Math.max(1, Math.ceil(1 / seconds - 1e-9)); // the steps whose changes can fall in one second
  return Math.floor(w / period) * flashes.perLoop + (flashes.windows[w % period] ?? 0);
}

/** Whether a look must freeze its preview before launch: strictly above the safety ceiling. */
export function shouldFreeze(rate: number, max: number): boolean {
  return rate > max;
}