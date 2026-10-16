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

/** The brightest cell's flashes per second over the step loop; 0 when the look fades or holds still. */
export function flashesPerSecond(steps: Step[], stepSeconds: number, attack: number): number {
  if (attack >= FADING_ATTACK || steps.length < 2 || !(stepSeconds > 0)) return 0;
  const n = steps.length;
  const cells = Math.max(...steps.map((s) => s.length));
  let worst = 0;
  for (let c = 0; c < cells; c++) {
    // a cell a step leaves untouched (null) keeps the level it had
    const raw = steps.map((s) => {
      const v = s[c];
      return v ? Math.max(0, ...Object.values(v).map((x) => x ?? 0)) : undefined;
    });
    const first = raw.find((x) => x !== undefined);
    if (first === undefined) continue;
    let last = [...raw].reverse().find((x) => x !== undefined)!;
    const level = raw.map((x) => (x === undefined ? last : (last = x)));
    let flashes = 0;
    for (let i = 0; i < n; i++) if (level[(i - 1 + n) % n]! <= DARK && level[i]! >= LIT) flashes++;
    worst = Math.max(worst, flashes / (n * stepSeconds));
  }
  return worst;
}
