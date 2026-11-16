/**
 * Aiming zones seen by one moving head (T27, lot 5; docs/specs/venue-fixtures-stage.md, « Zones », « Sur le pad d'une
 * lyre »): a zone's outline projected into the head's pan/tilt, for its XY pad. Pure geometry over `aimAt` / `rawAngles`.
 *
 * The outline is taken at the zone's aiming height (`zoneAimPoint`: its floor + its aiming height), the plane the heads
 * are aimed in, so the aiming point lies inside the projected outline. Each edge is sampled. The **anchor** is what
 * `position.aim {zone}` gives (the aiming point aimed from the centre of the travel, `aimAt`); every sample is aimed on
 * the anchor's own branch of solutions, followed continuously round the outline (same side of the base axis, pan carried
 * on without wrapping): a sample only the other equivalent solution reaches (pan ± 180° with the tilt mirrored, or
 * pan ± 360°) is **out of reach** for this drawing, never drawn elsewhere on the pad. A part out of reach or beyond the
 * useful stops (T8) is **left out, never bent**: the outline is cut where the reach ends (found by bisection), and two
 * neighbours further apart than JUMP_PAN_DEG / JUMP_TILT_DEG (degrees) are never joined.
 *
 * A zone the head's axis pierces (a hung head right above it, a standing head right under it) winds all the way round
 * the axis: its pan turns 360°. It is drawn as a **band** around the anchor's pan: each point at the pan within ± 90° of
 * the anchor's (its tilt mirrored past the axis), so the outline splits in two arcs, joined by the two constant-pan
 * segments that cross the axis (`axisInside`).
 */
import { aimAt, angleCandidates, rawAngles, withinLimits, type AimSetup } from "./aim.js";
import { pointInPolygon, zoneAimPoint, type Zone } from "./stage.js";

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
  /** `full`: the whole outline drawn as one loop; `partial`: only runs of it (a part out of reach); `none`: nothing. */
  reach: "full" | "partial" | "none";
  /** The head's axis pierces the zone: the loop is the band round it (two arcs joined across the axis). */
  axisInside?: true;
  /** The zone's outline on the stage and the height of its aiming plane (metres): the pad finds the zone under a point. */
  polygon: [number, number][];
  plane: number;
}

export interface ProjectOptions {
  /** Sampling step along the outline (metres); widened so that no zone gives more than `maxSamples`. */
  step?: number;
  maxSamples?: number;
}

/** Two neighbours further apart than this (degrees) are not joined: the head would swing between them. */
const JUMP_PAN_DEG = 90;
const JUMP_TILT_DEG = 60;
/** Bisection steps to find where the reach ends on an edge (a 2 m edge: under a millimetre). */
const BISECT = 12;
const DEFAULT_STEP = 0.1;
const DEFAULT_MAX_SAMPLES = 240;
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/** Logical degrees: pan and tilt from the centre of the travel, calibration offsets taken off (`aimNear`'s frame). */
type Deg = [number, number];
type Sample = { x: number; y: number; at: Deg | undefined };

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
  const head = {
    id: zone.id,
    name: zone.name,
    ...(zone.aim?.color ? { color: zone.aim.color } : {}),
    ...("error" in aimed ? {} : { aim: [round4(aimed.pan), round4(aimed.tilt)] as PadPoint }),
    polygon: zone.polygon.map(([x, y]) => [x, y] as [number, number]),
    plane: z,
  };

  /** The equivalent solutions for a stage point at the aiming height, logical degrees; `side`: the side of the base axis (+1, −1). */
  const solutions = (x: number, y: number): { at: Deg; side: number }[] | undefined => {
    const raw = rawAngles(setup, { x, y, z });
    if (!raw) return undefined;
    return angleCandidates(raw).map(([p, t], i) => ({ at: [p - setup.panOffset, t - setup.tiltOffset] as Deg, side: i % 2 === 0 ? 1 : -1 }));
  };
  const sideOf = (at: Deg): number => (at[1] + setup.tiltOffset < 0 ? -1 : 1);
  /** The solution on `side` whose pan is the nearest to `from`'s: the branch followed continuously. */
  const follow = (x: number, y: number, near: Deg, onSide: number): Deg | undefined => {
    const all = solutions(x, y)?.filter((s) => s.side === onSide);
    if (!all?.length) return undefined;
    return all.reduce((best, s) => (Math.abs(s.at[0] - near[0]) < Math.abs(best.at[0] - near[0]) ? s : best)).at;
  };
  const inReach = ([p, t]: Deg): boolean =>
    Math.abs(p) <= setup.panMax / 2 + 1e-9 && Math.abs(t) <= setup.tiltMax / 2 + 1e-9 && withinLimits(setup.limits, p, t);
  const jump = (a: Deg, b: Deg): boolean => Math.abs(a[0] - b[0]) > JUMP_PAN_DEG || Math.abs(a[1] - b[1]) > JUMP_TILT_DEG;
  const pad = ([p, t]: Deg): PadPoint => [round4(p / setup.panMax + 0.5), round4(t / setup.tiltMax + 0.5)];

  // the anchor: position.aim's solution; out of reach, the one nearest the centre of the travel all the same (the branch
  // the drawing follows), stops and travel aside
  const anchor: Deg | undefined =
    "error" in aimed
      ? solutions(target.x, target.y)?.reduce((best, s) => (Math.abs(s.at[0]) + Math.abs(s.at[1]) < Math.abs(best.at[0]) + Math.abs(best.at[1]) ? s : best)).at
      : [aimed.panDeg, aimed.tiltDeg];
  const step = Math.max(opts.step ?? DEFAULT_STEP, perimeter(zone.polygon) / (opts.maxSamples ?? DEFAULT_MAX_SAMPLES));
  const points = sampleOutline(zone.polygon, step);
  const n = points.length;
  // the head's base axis meets the aiming plane (on the beam's side) inside the zone: the outline winds round it
  const axisMeets = setup.hung ? z < setup.position.z : z > setup.position.z;
  const axisInside = axisMeets && pointInPolygon(setup.position.x, setup.position.y, zone.polygon);

  if (axisInside) return band(head, points, anchor ?? [0, 0]);

  // the branch: from the anchor to the outline sample nearest the aiming point (same side, pan carried on), then round
  const nearest = points.reduce((best, p, i) => (Math.hypot(p.x - target.x, p.y - target.y) < Math.hypot(points[best]!.x - target.x, points[best]!.y - target.y) ? i : best), 0);
  const branch = new Array<Deg | undefined>(n);
  let from: Deg | undefined = anchor;
  let side = anchor ? sideOf(anchor) : 1;
  for (let k = 0; k < n; k++) {
    const i = (nearest + k) % n;
    const at = from ? follow(points[i]!.x, points[i]!.y, from, side) : solutions(points[i]!.x, points[i]!.y)?.[0]?.at;
    branch[i] = at;
    if (at) [from, side] = [at, sideOf(at)];
  }
  // back to the start: the branch must meet itself again (it does unless the outline went round an axis)
  const closesOn = from && branch[nearest] ? follow(points[nearest]!.x, points[nearest]!.y, from, side) : undefined;
  const seam = !closesOn || !branch[nearest] || Math.abs(closesOn[0] - branch[nearest]![0]) > 1e-6;
  const samples: Sample[] = points.map((p, i) => ({ ...p, at: branch[i] && inReach(branch[i]!) ? branch[i] : undefined }));

  /** Where the reach ends on the edge from a sample in reach to one out of it: the last point still in reach, on its branch. */
  const edgeOfReach = (inside: Sample, outside: Sample): Deg => {
    const base = inside.at!;
    let [lo, hi] = [0, 1];
    let best = base;
    for (let i = 0; i < BISECT; i++) {
      const t = (lo + hi) / 2;
      const at = follow(inside.x + (outside.x - inside.x) * t, inside.y + (outside.y - inside.y) * t, base, sideOf(base));
      if (at && inReach(at) && !jump(base, at)) [lo, best] = [t, at];
      else hi = t;
    }
    return best;
  };
  // a cut before sample i: it or the one before is out of reach, they are a swing apart, or the branch's seam is there
  const cutBefore = (i: number): boolean => {
    const s = samples[i]!;
    const prev = samples[(i - 1 + n) % n]!;
    return !s.at || !prev.at || jump(prev.at, s.at) || (seam && i === nearest);
  };
  const start = samples.findIndex((_, i) => cutBefore(i));
  if (start < 0) return { ...head, paths: [samples.map((s) => pad(s.at!))], closed: true, reach: "full" };

  // one pass from a cut, round the outline: a run starts after a cut and ends before the next one
  const paths: PadPoint[][] = [];
  let run: PadPoint[] | null = null;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const s = samples[i]!;
    const prev = samples[(i - 1 + n) % n]!;
    if (s.at) {
      if (run && !cutBefore(i)) {
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
    // the last run meets the first sample again: a cut there (out of reach, a swing or the seam)
    const first = samples[start]!;
    const last = samples[(start - 1 + n) % n]!;
    if (!first.at) run.push(pad(edgeOfReach(last, first)));
    paths.push(run);
  }
  const kept = paths.filter((p) => p.length >= 2);
  return { ...head, paths: kept, closed: false, reach: kept.length ? "partial" : "none" };

  /**
   * A zone round the head's axis: each sample at the pan within ± 90° of the anchor's (`m` half-turns from its own
   * heading; an odd `m` mirrors the tilt past the axis). The outline then splits where it crosses the anchor's pan ± 90°:
   * with two such crossings and everything in reach, the two arcs joined by the two constant-pan segments across the axis
   * make one closed loop; else the runs in reach, open.
   */
  function band(base: typeof head, outline: { x: number; y: number }[], centre: Deg): ProjectedZone {
    const windowed = (x: number, y: number): { at: Deg; m: number } | undefined => {
      const raw = rawAngles(setup, { x, y, z });
      if (!raw) return undefined;
      const heading = raw.heading - setup.panOffset;
      const m = Math.round((centre[0] - heading) / 180);
      const tilt = (m % 2 === 0 ? raw.tilt : -raw.tilt) - setup.tiltOffset;
      return { at: [heading + 180 * m, tilt], m };
    };
    const parity = (m: number): number => ((m % 2) + 2) % 2;
    const cells = outline.map((p) => ({ ...p, w: windowed(p.x, p.y) }));
    const count = cells.length;
    /** Where the outline crosses from one half-turn to the next on the edge i → i + 1: both sides of the crossing. */
    const crossing = (i: number): [Deg, Deg] | undefined => {
      const a = cells[i]!;
      const b = cells[(i + 1) % count]!;
      if (!a.w || !b.w) return undefined;
      // lo keeps a's parity, hi the other one
      let [lo, hi] = [0, 1];
      for (let k = 0; k < 2 * BISECT; k++) {
        const t = (lo + hi) / 2;
        const w = windowed(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
        if (w && parity(w.m) === parity(a.w.m)) lo = t;
        else hi = t;
      }
      const end = windowed(a.x + (b.x - a.x) * lo, a.y + (b.y - a.y) * lo);
      const begin = windowed(a.x + (b.x - a.x) * hi, a.y + (b.y - a.y) * hi);
      return end && begin ? [end.at, begin.at] : undefined;
    };
    // a crossing: the parity of the half-turns changes (the heading's own wrap at ± 180° changes m by two, the pan not)
    const turns = cells.flatMap((c, i) => {
      const next = cells[(i + 1) % count]!;
      return c.w && next.w && parity(next.w.m) !== parity(c.w.m) ? [i] : [];
    });
    const whole = cells.every((c) => c.w && inReach(c.w.at));
    if (whole && turns.length === 2) {
      // two arcs, each from one crossing to the next; the loop is the first, then the second backwards
      const arcs = turns.map((t0, k) => {
        const t1 = turns[(k + 1) % 2]!;
        const enter = crossing(t0);
        const leave = crossing(t1);
        const arc: Deg[] = enter ? [enter[1]] : [];
        for (let i = (t0 + 1) % count; ; i = (i + 1) % count) {
          arc.push(cells[i]!.w!.at);
          if (i === t1) break;
        }
        if (leave) arc.push(leave[0]);
        return arc;
      });
      const loop = [...arcs[0]!, ...arcs[1]!.reverse()];
      const smooth = arcs.every((arc) => arc.every((p, i) => i === 0 || !jump(arc[i - 1]!, p)));
      if (smooth && loop.every(inReach)) return { ...base, paths: [loop.map(pad)], closed: true, reach: "full", axisInside: true };
    }
    // the runs in reach, cut at every crossing and wherever the reach ends (no bisection: the band is rare and its cut
    // already one sample from the truth)
    const runs: PadPoint[][] = [];
    let open: PadPoint[] = [];
    const startAt = Math.max(0, cells.findIndex((c, i) => !c.w || !inReach(c.w.at) || turns.includes((i - 1 + count) % count)));
    for (let k = 0; k < count; k++) {
      const i = (startAt + k) % count;
      const c = cells[i]!;
      const prev = cells[(i - 1 + count) % count]!;
      const ok = c.w && inReach(c.w.at);
      const joined = ok && open.length > 0 && prev.w && inReach(prev.w.at) && parity(prev.w.m) === parity(c.w!.m) && !jump(prev.w.at, c.w!.at);
      if (!joined && open.length) {
        runs.push(open);
        open = [];
      }
      if (ok) open.push(pad(c.w!.at));
    }
    if (open.length) runs.push(open);
    const drawn = runs.filter((r) => r.length >= 2);
    return { ...base, paths: drawn, closed: false, reach: drawn.length ? "partial" : "none", axisInside: true };
  }
}
