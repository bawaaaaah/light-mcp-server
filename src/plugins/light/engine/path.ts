/**
 * The path of a look's move (T28; docs/specs/engine-effects-timing.md, « Move FX », « Parcours »): a base of the motion
 * layer (`move.at.path`) that takes the heads from stop to stop — an aiming zone, a 3D point, a named position or a
 * target — in an order (loop, ping-pong, random, weighted), one stop per `move.every`, gliding the first `travel` part
 * of each step with a cosine ease and resting on the stop for the rest.
 *
 * Pure and geometry-blind, like `movePosition`: the caller resolves each stop into a pan/tilt for each head (`aimAt` per
 * stop, the solution closest to the centre, no state) and the travel is interpolated in pan/tilt, always within the
 * travel and continuous. Deterministic: the same look replays the same stops (seeded draw, `stepSequence`).
 */
import { z } from "zod";
import { say } from "../../../core/lang.js";
import { stepSequence } from "./player.js";
import { shuffled } from "./techniques.js";
import type { Position } from "./move.js";

/** One stop of a path: exactly one of `zone`, `point`, `position`, `target`. */
export const PathStopSchema = z
  .object({
    /** An aiming zone (T27): its aiming point, at its aiming height (or `height`). */
    zone: z.string().optional(),
    /** A point of the stage, metres. */
    point: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
    /** A named position (T32), read at render: its pan/tilt for each head it covers, or its point. */
    position: z.string().optional(),
    /** A target (T24): its point now (the only stop that moves by itself). */
    target: z.string().optional(),
    /** Metres above the zone's floor, instead of the zone's aiming height: a zone stop only. */
    height: z.number().min(0).max(30).optional(),
    /** Weighted order: this stop's weight (default 1, 0 = never drawn). */
    weight: z.number().min(0).max(100).optional(),
  })
  .refine((s) => [s.zone, s.point, s.position, s.target].filter((v) => v !== undefined).length === 1, {
    error: () => say("un arrêt de parcours a exactement une destination : zone, point, position ou cible", "a path stop has exactly one destination: zone, point, position or target"),
  })
  .refine((s) => s.height === undefined || s.zone !== undefined, { error: () => say("la hauteur d'un arrêt ne vaut que pour une zone", "a stop's height applies to a zone only") });
export type PathStop = z.infer<typeof PathStopSchema>;

export const PATH_MAX_STOPS = 32;

export const PathSchema = z
  .object({
    stops: z.array(PathStopSchema).min(1).max(PATH_MAX_STOPS),
    order: z.enum(["loop", "pingpong", "random", "weighted"]).default("loop"),
    /** Part of each step spent travelling (0..1, default 0.5); the rest, resting on the stop. 0 = a cut, 1 = always moving. */
    travel: z.number().min(0).max(1).default(0.5),
    /**
     * ensemble = every head on the same stop; decales = each head one stop behind the one before it (row order, with the
     * move's `reverse` and `shuffle`); chacune = in random or weighted order, each head draws its own sequence (in loop and
     * ping-pong it plays as ensemble: there is only one sequence).
     */
    heads: z.enum(["ensemble", "decales", "chacune"]).default("ensemble"),
  })
  // weighted, every weight 0 would leave the heads on one stop for ever: refused
  .refine((p) => p.order !== "weighted" || p.stops.some((s) => (s.weight ?? 1) > 0), {
    error: () => say("ordre pondéré : au moins un arrêt doit avoir un poids supérieur à 0", "weighted order: at least one stop must weigh more than 0"),
  });
export type Path = z.infer<typeof PathSchema>;

/**
 * Two seeds mixed (murmur3 finaliser, as the Move FX `aleatoire` mixes a cycle and a head): neighbouring inputs give
 * unrelated seeds, never a read of the same generator.
 */
export function mixSeed(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 1, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return h ^ (h >>> 16);
}

/** The salt that separates a path's draw from the look's colour steps (both seeded by the look). */
const PATH_SALT = 0x2a7b;

/** Whether each head draws its own sequence: `chacune` in a drawn order. */
export const ownSequence = (path: Pick<Path, "order" | "heads">): boolean => path.heads === "chacune" && (path.order === "random" || path.order === "weighted");

/**
 * The sequence of stop indexes a head plays (`stepSequence`): one for the whole look, or with `chacune` in a drawn order
 * one per head, its seed the look's mixed with the head's index. Memoised by the function returned: keep it.
 */
export function pathSequence(path: Pick<Path, "order" | "heads" | "stops">, lookSeed: number, index: number): (i: number) => number {
  const seed = mixSeed(lookSeed, ownSequence(path) ? PATH_SALT + 1 + index : PATH_SALT);
  return stepSequence({ order: path.order, n: path.stops.length, weights: path.stops.map((s) => s.weight ?? 1), seed });
}

/** The key a head's sequence is kept under (`pathSequence`): the same for every head unless each draws its own. */
export const sequenceKey = (path: Pick<Path, "order" | "heads">, index: number): number => (ownSequence(path) ? index : -1);

/** How many stops ahead a head plays: 0 but with `decales`, where each head in row order is one stop behind the one before. */
export function stopOffset(path: Pick<Path, "heads">, move: { reverse?: boolean | undefined; shuffle?: boolean | undefined }, index: number, count: number): number {
  if (path.heads !== "decales" || count <= 1) return 0;
  let rank = move.shuffle ? shuffled(count, count * 7919)[index]! : index;
  if (move.reverse) rank = count - 1 - rank;
  // never a negative sequence index: the last head of the row plays the look's own sequence, each before it one ahead
  return count - 1 - rank;
}

/** Where a head is on its path: between stop `from` and stop `to`, `ease` of the way (0 = on `from`, 1 = on `to`). */
export interface PathStep {
  from: number;
  to: number;
  ease: number;
}

/**
 * The step a head is on at `cycles` steps since the look started (`player.position(now, beats, move.every)`): step `n`
 * travels from the stop of sequence index n − 1 to that of n during its first `travel` part (cosine ease, the Move FX
 * `aleatoire`'s), then rests there. The first step rests on its stop: the motion layer's transition brings the heads
 * there. `offset`: `stopOffset`.
 */
export function pathStep(path: Pick<Path, "travel">, seq: (i: number) => number, cycles: number, offset = 0): PathStep {
  const phase = Number.isFinite(cycles) ? Math.max(0, cycles) : 0;
  const n = Math.floor(phase);
  const index = n + offset;
  const to = seq(index);
  const from = index > 0 ? seq(index - 1) : to;
  const u = path.travel > 0 ? Math.min(1, (phase - n) / path.travel) : 1;
  const ease = 0.5 - 0.5 * Math.cos(Math.PI * u);
  return { from, to, ease };
}

/** The position between two stops' positions, `ease` of the way: interpolated in pan/tilt, so always within the travel. */
export function pathPosition(a: Position, b: Position, ease: number): Position {
  const k = Math.max(0, Math.min(1, ease));
  return { pan: a.pan + (b.pan - a.pan) * k, tilt: a.tilt + (b.tilt - a.tilt) * k };
}

/** A stop resolved for one head: its pan/tilt, or why the head cannot go there. */
export type StopPosition = Position | { error: string };

/**
 * The pairs of stops a head may travel between, as indexes: loop k → k + 1 (and back to the first), ping-pong k ↔ k + 1,
 * random and weighted any two different stops. Each pair once (the distance is the same both ways).
 */
export function travelPairs(path: Pick<Path, "order" | "stops">): [number, number][] {
  const n = path.stops.length;
  if (n < 2) return [];
  const out: [number, number][] = [];
  if (path.order === "loop") for (let k = 0; k < n; k++) out.push(k < n - 1 ? [k, k + 1] : [0, n - 1]);
  else if (path.order === "pingpong") for (let k = 0; k < n - 1; k++) out.push([k, k + 1]);
  else for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
  if (path.order === "loop" && n === 2) out.pop(); // 0 → 1 and 1 → 0: one pair
  if (path.order === "weighted") return out.filter(([i, j]) => (path.stops[i]!.weight ?? 1) > 0 && (path.stops[j]!.weight ?? 1) > 0);
  return out;
}
