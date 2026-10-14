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

export interface Position {
  pan: number;
  tilt: number;
}

export const MoveSchema = z.object({
  /** fixe = static position (position preset); tapis = Wolfmix « magic carpet » (tilt wave, spread 1 by default). */
  shape: z.enum(["fixe", "cercle", "huit", "pan", "tilt", "tapis"]).default("fixe"),
  center: z.object({ pan: z.number().min(0).max(1).default(0.5), tilt: z.number().min(0).max(1).default(0.5) }).default({}),
  /** Amplitude around the centre, in fractions of the travel. */
  size: z.object({ pan: z.number().min(0).max(0.5).default(0.1), tilt: z.number().min(0).max(0.5).default(0.1) }).default({}),
  every: EverySchema.default({ beats: 4 }),
  /** Phase spread across the fixtures, in cycles (default 0, or 1 for « tapis »). */
  spread: z.number().min(0).max(4).optional(),
  /** Mirror the phase from the centre of the row (symmetric moves). */
  wings: z.boolean().default(false),
  reverse: z.boolean().default(false),
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
  let k = count > 1 ? index / (count - 1) : 0; // 0..1 along the row
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
  }
  return { pan: clamp01(pan + fan), tilt: clamp01(tilt) };
}
