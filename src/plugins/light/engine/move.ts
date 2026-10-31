/**
 * Move FX for moving heads (docs/specs/engine-effects-timing.md, « Move FX » à la Wolfmix): a shape
 * drawn in pan/tilt around a centre, one cycle per `every`, with the phase spread across the
 * fixtures (spread = cycles from the first to the last fixture, so 1 = a full rolling wave).
 *
 * Positions are logical and normalised: 0..1 of the fixture's pan/tilt travel, 0.5 = centre. The
 * venue applies inversion, swap and 16-bit encoding (venue.toDmx). Pure: no time source here.
 */
import { z } from "zod";
import { EverySchema } from "./player.js";
import { rng, shuffled } from "./techniques.js";

export interface Position {
  pan: number;
  tilt: number;
}

export const MoveSchema = z.object({
  /**
   * fixe = static position (position preset); tapis = Wolfmix « magic carpet » (tilt wave, spread 1 by
   * default); aleatoire = each head glides to a new point drawn in the box every cycle.
   */
  shape: z.enum(["fixe", "cercle", "huit", "pan", "tilt", "tapis", "aleatoire"]).default("fixe"),
  center: z.object({ pan: z.number().min(0).max(1).default(0.5), tilt: z.number().min(0).max(1).default(0.5) }).prefault({}),
  /** Amplitude around the centre, in fractions of the travel. */
  size: z.object({ pan: z.number().min(0).max(0.5).default(0.1), tilt: z.number().min(0).max(0.5).default(0.1) }).prefault({}),
  every: EverySchema.prefault({ beats: 4 }),
  /** Phase spread across the fixtures, in cycles (default 0, or 1 for « tapis »). */
  spread: z.number().min(0).max(4).optional(),
  /** Mirror the phase from the centre of the row (symmetric moves). */
  wings: z.boolean().default(false),
  reverse: z.boolean().default(false),
  /** The heads take their phase in a shuffled order rather than along the row (grandMA « shuffle »). */
  shuffle: z.boolean().optional(),
  /** Static pan fan across the row: first fixture −fan, last +fan (fractions of the travel). */
  fan: z.number().min(-0.5).max(0.5).default(0),
  /** Fixtures moved: this group's fixtures (default: the look's canvas fixtures that have pan/tilt). */
  group: z.string().optional(),
});
export type Move = z.infer<typeof MoveSchema>;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Position of fixture `index` (of `count`, in row order) at `cycles` cycles since the start.
 */
export function movePosition(m: Move, cycles: number, index: number, count: number): Position {
  const spread = m.spread ?? (m.shape === "tapis" ? 1 : 0);
  const rank = m.shuffle ? shuffled(count, count * 7919)[index]! : index;
  let k = count > 1 ? rank / (count - 1) : 0; // 0..1 along the row
  if (m.wings) k = 1 - Math.abs(2 * k - 1);
  const phase = cycles + (m.reverse ? 1 : -1) * spread * k;
  const u = 2 * Math.PI * phase;
  const fan = count > 1 ? m.fan * (2 * (index / (count - 1)) - 1) : 0;
  const { pan: cx, tilt: cy } = m.center;
  const { pan: sx, tilt: sy } = m.size;
  let pan = cx;
  let tilt = cy;
  switch (m.shape) {
    case "fixe":
      break;
    case "cercle":
      pan += sx * Math.sin(u);
      tilt += sy * Math.cos(u);
      break;
    case "huit":
      pan += sx * Math.sin(u);
      tilt += sy * Math.sin(2 * u);
      break;
    case "pan":
      pan += sx * Math.sin(u);
      break;
    case "tilt":
    case "tapis":
      tilt += sy * Math.sin(u);
      break;
    case "aleatoire": {
      // from the point of this cycle to the next one, easing in and out; a mirrored pair (wings) shares its points
      const head = m.wings ? Math.min(index, count - 1 - index) : index;
      const n = Math.floor(phase);
      const ease = 0.5 - 0.5 * Math.cos(Math.PI * (phase - n));
      const [a, b] = [pointOf(n, head), pointOf(n + 1, head)];
      pan += sx * (a.x + (b.x - a.x) * ease);
      tilt += sy * (a.y + (b.y - a.y) * ease);
      break;
    }
  }
  return { pan: clamp01(pan + fan), tilt: clamp01(tilt) };
}

/** The point drawn for `head` at cycle `n`, in −1..1 on both axes: the same every time. */
function pointOf(n: number, head: number): { x: number; y: number } {
  // neighbouring cycles and heads give neighbouring seeds: mixed first (murmur3 finaliser)
  let h = Math.imul(n | 0, 0x9e3779b1) ^ Math.imul(head + 1, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  const r = rng(h ^ (h >>> 16));
  return { x: 2 * r() - 1, y: 2 * r() - 1 };
}
