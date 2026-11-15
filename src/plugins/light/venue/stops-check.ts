/**
 * « Vérifier le show » for the useful stops of the moving heads (T8, decision Q4 of the user: a look or a Move FX that
 * reaches a stop is clipped at the output without a word, the show check says so). Pure: what a look asks is sampled
 * here, the output's bounding stays in `Venue.writePosition` (aim.ts `boundPosition`).
 */
import { boundPosition, type AimLimits, type AimSetup } from "./aim.js";
import { movePosition, type Move, type Position } from "../engine/move.js";

type Stops = Pick<AimSetup, "panMax" | "tiltMax" | "limits">;

/** A stop narrower than this (degrees) leaves the head almost still: worth a warning, a typing slip is likely. */
export const NARROW_STOP_DEG = 10;

/** Samples per cycle of a drawn shape (circle, figure eight, waves). */
const SAMPLES = 64;

/** Whether the stops would move a position (given axes only): it reaches beyond them. */
export function beyondStops(f: Stops, p: Partial<Position>): boolean {
  const full = { pan: p.pan ?? 0.5, tilt: p.tilt ?? 0.5 };
  const b = boundPosition(f, full);
  return (p.pan !== undefined && Math.abs(b.pan - full.pan) > 1e-6) || (p.tilt !== undefined && Math.abs(b.tilt - full.tilt) > 1e-6);
}

/**
 * The box a head's move stays in, whatever the shape, phase or spread: the centre ± the size, shifted by the head's
 * fan, within the travel (`movePosition` clamps to 0..1). « aléatoire » draws its points anywhere in it.
 */
function moveBox(move: Move, index: number, count: number): { min: Position; max: Position } {
  const fan = count > 1 ? move.fan * (2 * (index / (count - 1)) - 1) : 0;
  const c01 = (v: number) => Math.max(0, Math.min(1, v));
  const pan = move.center.pan + fan;
  const tilt = move.center.tilt;
  return { min: { pan: c01(pan - move.size.pan), tilt: c01(tilt - move.size.tilt) }, max: { pan: c01(pan + move.size.pan), tilt: c01(tilt + move.size.tilt) } };
}

/**
 * The heads (by index in `heads`, the order the move gives them their phase) a Move FX takes beyond their stops at
 * some point of its cycle; a head without stops (undefined, or none set) is never listed. The box of the move decides
 * analytically when it is inside the stops (every shape stays in it) and for « aléatoire » (its points may fall anywhere
 * in it, any cycle); a drawn shape is otherwise sampled along one cycle, the phase of the head included.
 */
export function moveBeyondStops(move: Move, heads: readonly (Stops | undefined)[]): number[] {
  const out: number[] = [];
  heads.forEach((f, i) => {
    if (!f?.limits?.pan && !f?.limits?.tilt) return;
    const box = moveBox(move, i, heads.length);
    // the stops bound each axis apart: the box is inside when its two corners are
    if (!beyondStops(f, box.min) && !beyondStops(f, box.max)) return;
    if (move.shape === "aleatoire") {
      out.push(i);
      return;
    }
    for (let k = 0; k <= SAMPLES; k++)
      if (beyondStops(f, movePosition(move, k / SAMPLES, i, heads.length))) {
        out.push(i);
        return;
      }
  });
  return out;
}

/** The axes whose stop reaches beyond the travel (± half of it, logical degrees), with that half. */
export function stopsOutsideTravel(limits: AimLimits | undefined, travel: Pick<AimSetup, "panMax" | "tiltMax">): { axis: "pan" | "tilt"; half: number }[] {
  return (["pan", "tilt"] as const).flatMap((axis) => {
    const r = limits?.[axis];
    const half = (axis === "pan" ? travel.panMax : travel.tiltMax) / 2;
    return r && (r[0] < -half - 1e-9 || r[1] > half + 1e-9) ? [{ axis, half }] : [];
  });
}

/** The axes whose stop is narrower than `NARROW_STOP_DEG`. */
export function narrowStops(limits: AimLimits | undefined): ("pan" | "tilt")[] {
  return (["pan", "tilt"] as const).filter((axis) => {
    const r = limits?.[axis];
    return r !== undefined && r[1] - r[0] < NARROW_STOP_DEG;
  });
}
