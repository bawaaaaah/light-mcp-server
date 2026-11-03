/**
 * How fast a look flashes (docs/specs/rules-limits.md, « Clignotement »): photosensitive safety,
 * after WCAG 2.3.1 — no more than three flashes in any one second. A flash is a cell going from
 * dark to lit; a fading attack (« respire ») ramps the light instead and is not counted. Pure: the
 * show check passes the look's steps and the length of a step. The count is the worst one-second window,
 * not an average over the cycle: five flashes in half a second then a long dark spell is still five.
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

/** How a look flashes over its cycle: `windows[w]` is the most flashes in `w` steps in a row of it (w = 0..period). */
export interface FlashProfile {
  /** Flashes of the worst cell over one cycle. */
  perLoop: number;
  /** Steps of the cycle: the played order, or 2 for a random or weighted order (see `flashProfile`). */
  period: number;
  windows: number[];
}

/**
 * The flashes of the worst cell, in the order the steps are played, as the most flashes in any `w` steps in a row.
 * `untouchedIsDark`: a cell a step leaves untouched (null) counts as dark, as a preview draws it (hatched,
 * dark), instead of keeping the level it had, as the stage does. A fading attack ramps between steps, except
 * into a cell a preview draws as untouched, which it cuts: that change still counts when `untouchedIsDark`.
 * A random or weighted order has no cycle to follow: a look with a dark and a lit step on a cell can put a flash
 * every two steps, which is the cycle then (period 2, one flash).
 */
export function flashProfile(steps: Step[], attack: number, order = "loop", untouchedIsDark = false): FlashProfile {
  const seq = playOrder(steps.length, order);
  const n = seq.length;
  const none = (period: number): FlashProfile => ({ perLoop: 0, period, windows: new Array<number>(period + 1).fill(0) });
  const fading = attack >= FADING_ATTACK;
  if (steps.length < 2 || (fading && !untouchedIsDark)) return none(n);
  const cells = Math.max(...steps.map((s) => s.length));
  const shuffled = order === "random" || order === "weighted";
  const windows = new Array<number>(n + 1).fill(0);
  let shuffledFlash = false;
  for (let c = 0; c < cells; c++) {
    // a cell a step leaves untouched (null) keeps the level it had (or is dark, see above); carried along the list of
    // steps, not the played order, which can overestimate in ping-pong but never underestimate: the safe side
    const raw = steps.map((s) => {
      const v = s[c];
      return v ? Math.max(0, ...Object.values(v).map((x) => x ?? 0)) : untouchedIsDark ? 0 : undefined;
    });
    if (raw.every((x) => x === undefined)) continue;
    let last = [...raw].reverse().find((x) => x !== undefined)!;
    const level = raw.map((x) => (x === undefined ? last : (last = x)));
    // a change the attack does not soften: any when it is sharp, else the ones out of an untouched cell
    const sharp = (from: number) => !fading || !steps[from]![c];
    if (shuffled) {
      if (level.some((x, i) => x <= DARK && sharp(i)) && level.some((x) => x >= LIT)) shuffledFlash = true;
      continue;
    }
    const flash = seq.map((to, i) => {
      const from = seq[(i - 1 + n) % n]!;
      return level[from]! <= DARK && level[to]! >= LIT && sharp(from) ? 1 : 0;
    });
    for (let w = 1; w <= n; w++) {
      for (let start = 0; start < n; start++) {
        let sum = 0;
        for (let k = 0; k < w; k++) sum += flash[(start + k) % n]!;
        windows[w] = Math.max(windows[w]!, sum);
      }
    }
  }
  if (shuffled) return shuffledFlash ? { perLoop: 1, period: 2, windows: [0, 1, 1] } : none(2);
  return { perLoop: windows[n]!, period: n, windows };
}

/** The most flashes in `w` steps in a row, for any `w`: whole cycles, then the most in what is left. */
export function flashesWithin(profile: FlashProfile, w: number): number {
  if (profile.period < 1) return 0;
  return Math.floor(w / profile.period) * profile.perLoop + (profile.windows[w % profile.period] ?? 0);
}

/** How many steps in a row can start inside one second: their changes are the flashes that second can hold. */
export function stepsPerSecond(stepSeconds: number): number {
  return Math.max(1, Math.ceil(1 / stepSeconds - 1e-9));
}

/** The worst cell's number of dark-to-lit changes over one cycle (see `flashProfile`). */
export function flashesPerLoop(steps: Step[], attack: number, order = "loop", untouchedIsDark = false): number {
  return flashProfile(steps, attack, order, untouchedIsDark).perLoop;
}

/**
 * The most flashes the look can put in one second, the worst second of its cycle (WCAG 2.3.1: no more than
 * three); 0 when the look fades or holds still.
 */
export function flashesPerSecond(steps: Step[], stepSeconds: number, attack: number, order = "loop"): number {
  if (steps.length < 1 || !(stepSeconds > 0)) return 0; // no step: nothing to divide by
  return flashesWithin(flashProfile(steps, attack, order), stepsPerSecond(stepSeconds));
}
