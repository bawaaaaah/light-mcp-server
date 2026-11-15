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

/** Samples per cycle of a shape, and cycles of « aléatoire » (a new point drawn each cycle). */
const SAMPLES = 64;
const RANDOM_CYCLES = 8;

/** Whether the stops would move a position (given axes only): it reaches beyond them. */
export function beyondStops(f: Stops, p: Partial<Position>): boolean {
  const full = { pan: p.pan ?? 0.5, tilt: p.tilt ?? 0.5 };
  const b = boundPosition(f, full);
  return (p.pan !== undefined && Math.abs(b.pan - full.pan) > 1e-6) || (p.tilt !== undefined && Math.abs(b.tilt - full.tilt) > 1e-6);
}

/**
 * The heads (by index in `heads`, the order the move gives them their phase) a Move FX takes beyond their stops at
 * some point of its cycle; a head without stops (undefined, or none set) is never listed.
 */
export function moveBeyondStops(move: Move, heads: readonly (Stops | undefined)[]): number[] {
  const cycles = move.shape === "aleatoire" ? RANDOM_CYCLES : 1;
  const out: number[] = [];
  heads.forEach((f, i) => {
    if (!f?.limits?.pan && !f?.limits?.tilt) return;
    for (let k = 0; k <= cycles * SAMPLES; k++)
      if (beyondStops(f, movePosition(move, k / SAMPLES, i, heads.length))) {
        out.push(i);
        return;
      }
  });
  return out;
}

/** The axes whose stop is narrower than `NARROW_STOP_DEG`. */
export function narrowStops(limits: AimLimits | undefined): ("pan" | "tilt")[] {
  return (["pan", "tilt"] as const).filter((axis) => {
    const r = limits?.[axis];
    return r !== undefined && r[1] - r[0] < NARROW_STOP_DEG;
  });
}
