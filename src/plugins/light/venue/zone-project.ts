/**
 * Aiming zones seen by one moving head (T27, lot 5; docs/specs/venue-fixtures-stage.md, « Zones », « Sur les pads »):
 * a zone's outline projected into the head's pan/tilt, for its XY pad. Pure geometry over `aimNear` / `aimAt`.
 *
 * The outline is taken at the zone's aiming height (`zoneAimPoint`: its floor + its aiming height), the plane the heads
 * are aimed in, so the aiming point lies inside the projected outline. Each edge is sampled; each sample is aimed with
 * the solution closest to the one `position.aim {zone}` gives (the aiming point aimed from the centre of the travel,
 * `aimAt`): the outline is drawn around where the head really goes for that zone, on one side of its travel. A part out
 * of reach or beyond the useful stops (T8) is **left out, never bent**: the outline is cut where the reach ends (found by
 * bisection), and a jump between two samples (the head would swing to the other equivalent solution) cuts it too.
 */
import type { Position } from "../engine/move.js";
import { aimAt, aimNear, type AimSetup } from "./aim.js";
import { zoneAimPoint, type Zone } from "./stage.js";

/** A point of the pad: logical pan and tilt, 0..1 (inversions undone, as the pad and `position.set`). */
export type PadPoint = [number, number];

export interface ProjectedZone {
  id: string;
  name: string;
  color?: string;
  /**
   * The outline's runs within reach, each a polyline of pad points. `closed`: the whole outline is in reach without a
   * cut, one loop (its last point joins its first); otherwise each run is open.
   */
  paths: PadPoint[][];
  closed: boolean;
  /** Where `position.aim {zone}` sends the head; absent when its aiming point is out of reach. */
  aim?: PadPoint;
  /** All of the outline in reach, part of it, or none. */
  reach: "full" | "partial" | "none";
}

export interface ProjectOptions {
  /** Sampling step along the outline (metres); widened so that no zone gives more than `maxSamples`. */
  step?: number;
  maxSamples?: number;
}

/** Two samples further apart than this (a quarter of the travel on an axis) are not joined: the head would swing. */
const JUMP = 0.25;
/** Bisection steps to find where the reach ends on an edge (a 2 m edge: under a millimetre). */
const BISECT = 12;
const DEFAULT_STEP = 0.1;
const DEFAULT_MAX_SAMPLES = 240;
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

type Sample = { x: number; y: number; at: Position | undefined };

/** The outline sampled along its edges, `step` metres apart at most, every corner kept. */
function sampleOutline(polygon: readonly (readonly [number, number])[], step: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  polygon.forEach(([x0, y0], i) => {
    const [x1, y1] = polygon[(i + 1) % polygon.length]!;
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = 0; k < n; k++) out.push({ x: x0 + ((x1 - x0) * k) / n, y: y0 + ((y1 - y0) * k) / n });
  });
  return out;
}

const perimeter = (polygon: readonly (readonly [number, number])[]): number =>
  polygon.reduce((sum, [x0, y0], i) => {
    const [x1, y1] = polygon[(i + 1) % polygon.length]!;
    return sum + Math.hypot(x1 - x0, y1 - y0);
  }, 0);

/** One zone's outline in one head's pan/tilt. `setup`: the head's aiming data (venue.ts `aimSetupOf`). */
export function projectZone(setup: AimSetup, zone: Pick<Zone, "id" | "name" | "polygon" | "floorHeight" | "aim">, opts: ProjectOptions = {}): ProjectedZone {
  const target = zoneAimPoint(zone);
  const z = target.z;
  const aimed = aimAt(setup, target);
  // what position.aim gives for the zone: each sample is aimed the closest to it (same side of the travel)
  const anchor: Position | undefined = "error" in aimed ? undefined : { pan: aimed.pan, tilt: aimed.tilt };
  const aimPoint = (x: number, y: number): Position | undefined => {
    const r = anchor ? aimNear(setup, { x, y, z }, anchor) : aimAt(setup, { x, y, z });
    return "error" in r ? undefined : { pan: r.pan, tilt: r.tilt };
  };
  const step = Math.max(opts.step ?? DEFAULT_STEP, perimeter(zone.polygon) / (opts.maxSamples ?? DEFAULT_MAX_SAMPLES));
  const samples: Sample[] = sampleOutline(zone.polygon, step).map((p) => ({ ...p, at: aimPoint(p.x, p.y) }));
  const pad = (p: Position): PadPoint => [round4(p.pan), round4(p.tilt)];
  const head = {
    id: zone.id,
    name: zone.name,
    ...(zone.aim?.color ? { color: zone.aim.color } : {}),
    ...(anchor ? { aim: pad(anchor) } : {}),
  };
  const jump = (a: Position, b: Position): boolean => Math.abs(a.pan - b.pan) > JUMP || Math.abs(a.tilt - b.tilt) > JUMP;
  /** Where the reach ends on the edge from a sample in reach to one out of it: the last point still in reach. */
  const edgeOfReach = (inside: Sample, outside: Sample): Position => {
    let [lo, hi] = [0, 1];
    let best = inside.at!;
    for (let i = 0; i < BISECT; i++) {
      const t = (lo + hi) / 2;
      const at = aimPoint(inside.x + (outside.x - inside.x) * t, inside.y + (outside.y - inside.y) * t);
      // a point in reach but swung to the other side is no part of this run
      if (at && !jump(best, at)) [lo, best] = [t, at];
      else hi = t;
    }
    return best;
  };

  const n = samples.length;
  const reachable = samples.filter((s) => s.at).length;
  if (reachable === 0) return { ...head, paths: [], closed: false, reach: "none" };
  const breakBefore = (i: number): boolean => {
    const s = samples[i]!;
    const prev = samples[(i - 1 + n) % n]!;
    return !s.at || !prev.at || jump(prev.at, s.at);
  };
  const start = samples.findIndex((_, i) => breakBefore(i));
  if (start < 0) return { ...head, paths: [samples.map((s) => pad(s.at!))], closed: true, reach: "full" };

  // one pass from a cut, round the outline: a run starts after a cut and ends before the next one
  const paths: PadPoint[][] = [];
  let run: PadPoint[] | null = null;
  for (let k = 0; k < n; k++) {
    const s = samples[(start + k) % n]!;
    const prev = samples[(start + k - 1 + n) % n]!;
    if (s.at) {
      if (run && prev.at && !jump(prev.at, s.at)) {
        run.push(pad(s.at));
        continue;
      }
      if (run) paths.push(run);
      run = prev.at ? [] : [pad(edgeOfReach(s, prev))];
      run.push(pad(s.at));
    } else if (run) {
      run.push(pad(edgeOfReach(prev, s)));
      paths.push(run);
      run = null;
    }
  }
  if (run) {
    // the last run meets the first sample again: a cut there (out of reach, or a jump)
    const first = samples[start]!;
    const last = samples[(start - 1 + n) % n]!;
    if (!first.at) run.push(pad(edgeOfReach(last, first)));
    paths.push(run);
  }
  return { ...head, paths: paths.filter((p) => p.length >= 2), closed: false, reach: reachable === n ? "full" : "partial" };
}
