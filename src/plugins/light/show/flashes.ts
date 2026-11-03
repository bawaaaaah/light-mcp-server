/**
 * How fast a look flashes (docs/specs/rules-limits.md, « Clignotement »): photosensitive safety,
 * after WCAG 2.3.1 — no more than three flashes in any one second. A flash is a cell going from
 * dark to lit; a fading attack (« respire ») ramps the light instead and is not counted. Pure: the
 * show check passes the look's steps and the length of a step.
 */
import type { Step } from "../engine/techniques.js";

export const MAX_FLASHES_PER_SECOND = 3;
/** Below this a cell reads as dark, above LIT as lit (colour components are 0..1). */
const DARK = 0.1;
const LIT = 0.5;
/** An attack at least this soft fades between steps: no flash. */
const FADING_ATTACK = 0.2;

/** The steps in the order they are played over one cycle: the list itself, or there and back for « pingpong » (its two ends are not played twice). */
export function playOrder(count: number, order = "loop"): number[] {
  const up = Array.from({ length: count }, (_, i) => i);
  return order === "pingpong" && count > 2 ? [...up, ...up.slice(1, -1).reverse()] : up;
}

/**
 * The worst cell's number of dark-to-lit changes over one cycle of the steps, in the order they are played.
 * `untouchedIsDark`: a cell a step leaves untouched (null) counts as dark, as a preview draws it (hatched,
 * dark), instead of keeping the level it had, as the stage does. A random or weighted order has no cycle to
 * follow: a cell that has both a dark and a lit step counts at least one, so that the prudent bound in
 * `flashesPerSecond` (and the client's) applies to it.
 */
export function flashesPerLoop(steps: Step[], attack: number, order = "loop", untouchedIsDark = false): number {
  if (attack >= FADING_ATTACK || steps.length < 2) return 0;
  const seq = playOrder(steps.length, order);
  const n = seq.length;
  const cells = Math.max(...steps.map((s) => s.length));
  const shuffled = order === "random" || order === "weighted";
  let worst = 0;
  for (let c = 0; c < cells; c++) {
    // a cell a step leaves untouched (null) keeps the level it had (or is dark, see above); carried along the list of
    // steps, not the played order, which can overestimate in ping-pong but never underestimate: the safe side
    const raw = steps.map((s) => {
      const v = s[c];
      return v ? Math.max(0, ...Object.values(v).map((x) => x ?? 0)) : untouchedIsDark ? 0 : undefined;
    });
    const first = raw.find((x) => x !== undefined);
    if (first === undefined) continue;
    let last = [...raw].reverse().find((x) => x !== undefined)!;
    const level = raw.map((x) => (x === undefined ? last : (last = x)));
    let flashes = 0;
    for (let i = 0; i < n; i++) if (level[seq[(i - 1 + n) % n]!]! <= DARK && level[seq[i]!]! >= LIT) flashes++;
    if (shuffled && level.some((x) => x <= DARK) && level.some((x) => x >= LIT)) flashes = Math.max(flashes, 1);
    worst = Math.max(worst, flashes);
  }
  return worst;
}

/**
 * The brightest cell's flashes per second over the cycle of steps; 0 when the look fades or holds still.
 * A random or weighted order can put the flashes back to back (a dark step, then a lit one), so a look that
 * flashes at all is raised to one flash every two steps when the looped count underestimates it.
 */
export function flashesPerSecond(steps: Step[], stepSeconds: number, attack: number, order = "loop"): number {
  if (steps.length < 1 || !(stepSeconds > 0)) return 0; // no step: nothing to divide by
  const perLoop = flashesPerLoop(steps, attack, order);
  const rate = perLoop / (playOrder(steps.length, order).length * stepSeconds);
  return (order === "random" || order === "weighted") && perLoop > 0 ? Math.max(rate, 1 / (2 * stepSeconds)) : rate;
}
