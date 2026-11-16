/**
 * What a look's path (or its zone, a one-stop path) will do on the stage, said ahead (T28;
 * docs/specs/engine-effects-timing.md, « Parcours »): at save (look.put), in the look editor (look.preview) and in
 * « Vérifier le show ». Pure: the caller resolves each stop for each head (the render's own resolution, `pathStopAt`) and
 * gives the speed limits that apply and the closed no-aim zones.
 *
 * - **Unreachable stops**: a head that cannot go to a stop holds where it is for the steps that lead there or leave it;
 *   the cause is said head by head.
 * - **Speed** (`maxDegPerSecond`), per head and per axis: the degrees of each trip (|Δ| × travel of that axis) against
 *   the slowest rule that applies to that head, over the trip's time (`every × travel`, at the current tempo for a
 *   cadence in beats); said only where a rule applies — the head will arrive late, the rule bounds its output anyway.
 * - **No-aim zones**: a stop whose beam lands in a closed no-aim zone keeps the head dark while it rests there; a trip
 *   whose beam crosses one (sampled every degree or so along the pan/tilt interpolation, the guard's own test) darkens
 *   it while it crosses. Every zone is said, the guard never steers (decision of 2026-10-17).
 */
import { lang, say } from "../../../core/lang.js";
import { pathPosition, travelPairs, type Path, type StopPosition } from "../engine/path.js";
import type { Position } from "../engine/move.js";
import { pointing, type AimSetup } from "./aim.js";
import { pointInPolygon, type Zone } from "./stage.js";

/** One moving head as the checks see it. */
export interface PathHead {
  id: string;
  name: string;
  /** Degrees of travel of each axis. */
  panMax: number;
  tiltMax: number;
  /** Where it is and how it points (absent: no stage position, the no-aim check is skipped for it). */
  setup?: AimSetup | undefined;
  /** Each stop of the path for this head, in order (`pathStopAt`). */
  stops: readonly StopPosition[];
  /** The slowest `maxDegPerSecond` that applies to each axis (`speedLimits`); an axis absent: no rule. */
  speed?: { pan?: number | undefined; tilt?: number | undefined };
}

export interface PathCheckInput {
  path: Pick<Path, "order" | "stops">;
  heads: readonly PathHead[];
  /** Seconds a trip lasts: `every × travel` (0: a cut). */
  travelSeconds: number;
  /** The closed no-aim zones (those the look does not open). */
  noAim: readonly Zone[];
  /** How a stop is named in a message (« zone « Avant-scène » », « point (1 ; 2 ; 0) »…), by index. */
  stopName: (index: number) => string;
  /** The report is a look aimed at a zone (`move.at.zone`, a path of one stop): said « la zone « X » », never « l'arrêt 1 ». */
  zoneLook?: boolean;
  /** The tempo a cadence in beats was timed at, said in the speed warning (absent: a cadence in seconds). */
  bpm?: number;
}

export type PathWarningKind = "unreachable" | "nowhere" | "speed" | "noAim" | "noAimStop";
export interface PathWarning {
  kind: PathWarningKind;
  message: string;
  /** The stops it is about (indexes). */
  stops: number[];
  /** The heads it is about. */
  heads: string[];
  zone?: string;
}

/** Points sampled along a trip for the no-aim test: one per this many degrees of the longer axis, between the bounds. */
export const NO_AIM_STEP_DEG = 1.5;
export const NO_AIM_MIN_SAMPLES = 16;
export const NO_AIM_MAX_SAMPLES = 400;

const placed = (p: StopPosition): p is Position => !("error" in p);
/** A number as the request's language writes it: a decimal comma in French, one decimal below 100. */
export const num = (v: number): string => {
  const r = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return lang() === "en" ? String(r) : String(r).replace(".", ",");
};

/** How many points a trip from `a` to `b` is sampled at for the no-aim test (ends excluded by the caller). */
export function tripSamples(h: Pick<PathHead, "panMax" | "tiltMax">, a: Position, b: Position): number {
  const deg = Math.max(Math.abs(b.pan - a.pan) * h.panMax, Math.abs(b.tilt - a.tilt) * h.tiltMax);
  return Math.min(NO_AIM_MAX_SAMPLES, Math.max(NO_AIM_MIN_SAMPLES, Math.ceil(deg / NO_AIM_STEP_DEG)));
}

/** The height above its floor up to which a beam counts in a no-aim zone (`beamCrosses`' default, the guard's). */
const NO_AIM_HEIGHT = 2.5;

/** A zone's box seen from above, widened by a margin (the guard steps along the beam every 10 cm). */
export interface ZoneBox {
  zone: Zone;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
export const boxOf = (zone: Zone): ZoneBox => {
  const xs = zone.polygon.map((q) => q[0]);
  const ys = zone.polygon.map((q) => q[1]);
  const m = 0.15;
  return { zone, x0: Math.min(...xs) - m, x1: Math.max(...xs) + m, y0: Math.min(...ys) - m, y1: Math.max(...ys) + m };
};

/**
 * Whether a beam crosses a zone up to `NO_AIM_HEIGHT` above its floor, as the guard's `beamCrosses` says (a step every
 * 10 cm up to 20 m, stopped where the beam has hit that floor), but stepping only where it can: the part of the beam
 * between the zone's floor and that height, over the zone's box seen from above (Liang-Barsky). Pure.
 */
export function beamInZone(o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }, b: ZoneBox): boolean {
  const floor = b.zone.floorHeight;
  // the guard's first step already below the floor: the beam has hit the ground there
  if (o.z + 0.1 * d.z < floor - 0.05) return false;
  let t0 = 0.1;
  let t1 = 20;
  const [lo, hi] = [floor - 0.05, floor + NO_AIM_HEIGHT];
  if (Math.abs(d.z) < 1e-12) {
    if (o.z < lo || o.z > hi) return false;
  } else {
    const [ta, tb] = [(lo - o.z) / d.z, (hi - o.z) / d.z];
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  }
  for (const [oo, dd, a0, a1] of [[o.x, d.x, b.x0, b.x1], [o.y, d.y, b.y0, b.y1]] as const) {
    if (Math.abs(dd) < 1e-12) {
      if (oo < a0 || oo > a1) return false;
      continue;
    }
    const [ta, tb] = [(a0 - oo) / dd, (a1 - oo) / dd];
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  }
  if (t0 > t1 + 0.1) return false;
  for (let k = Math.max(1, Math.floor(t0 * 10)); k <= Math.min(200, Math.ceil(t1 * 10)); k++) {
    const t = k / 10;
    const z = o.z + t * d.z;
    if (z < lo) return false;
    if (z <= hi && pointInPolygon(o.x + t * d.x, o.y + t * d.y, b.zone.polygon)) return true;
  }
  return false;
}

/** The no-aim zones a head's beam falls into at `p` (`boxes`: theirs, `boxOf`). */
const zonesAt = (h: PathHead, p: Position, boxes: readonly ZoneBox[]): Zone[] => {
  const d = pointing(h.setup!, p);
  return boxes.filter((b) => beamInZone(h.setup!.position, d, b)).map((b) => b.zone);
};

/** Every warning for a path, in a stable order: stops, then speed, then no-aim zones. */
export function checkPath(input: PathCheckInput): PathWarning[] {
  const { path, heads, noAim, stopName } = input;
  const out: PathWarning[] = [];
  /** How a stop is said at the start of a sentence: « l'arrêt 2 (zone « X ») », or « la zone « X » » for a zone look. */
  const stopSaid = (i: number): string => (input.zoneLook ? say(`la ${stopName(i)}`, `the ${stopName(i)}`) : say(`l'arrêt ${i + 1} (${stopName(i)})`, `stop ${i + 1} (${stopName(i)})`));
  // stops nobody, or not every head, can reach: the cause head by head
  path.stops.forEach((_, i) => {
    const failing = heads.filter((h) => h.stops[i] && !placed(h.stops[i]!));
    if (!failing.length) return;
    const why = failing.map((h) => `${h.name} : ${(h.stops[i] as { error: string }).error}`).join(" ; ");
    const whyEn = failing.map((h) => `${h.name}: ${(h.stops[i] as { error: string }).error}`).join("; ");
    const many = failing.length > 1;
    const holds = say(many ? "elles restent en place" : "elle reste en place", many ? "they hold" : "it holds");
    const where = stopSaid(i);
    // a zone look holds its heads for as long as it plays; a path, for the steps to and from that stop
    const when = input.zoneLook ? "" : say(" pendant les pas qui y mènent ou en partent", " during the steps that lead there or leave it");
    if (failing.length === heads.length)
      out.push({ kind: "nowhere", stops: [i], heads: failing.map((h) => h.id), message: say(`${where} n'est ${input.zoneLook ? "atteinte" : "atteint"} par aucune lyre — ${why} : ${holds}${when}`, `${where} is reached by no head — ${whyEn}: ${holds}${when}`) });
    else out.push({ kind: "unreachable", stops: [i], heads: failing.map((h) => h.id), message: say(`${where} est hors d'atteinte — ${why} : ${holds}${when}`, `${where} is out of reach — ${whyEn}: ${holds}${when}`) });
  });
  const pairs = travelPairs(path);
  // speed, per head and per axis: the worst trip against the slowest rule that applies
  for (const h of heads) {
    for (const axis of ["pan", "tilt"] as const) {
      const limit = h.speed?.[axis];
      if (limit === undefined || !(limit > 0)) continue;
      const travel = axis === "pan" ? h.panMax : h.tiltMax;
      let worst: { pair: [number, number]; deg: number } | undefined;
      for (const pair of pairs) {
        const [a, b] = [h.stops[pair[0]], h.stops[pair[1]]];
        if (!a || !b || !placed(a) || !placed(b)) continue;
        const deg = Math.abs(b[axis] - a[axis]) * travel;
        if (!worst || deg > worst.deg) worst = { pair, deg };
      }
      if (!worst || worst.deg < 1e-6) continue;
      const needed = input.travelSeconds > 0 ? worst.deg / input.travelSeconds : Number.POSITIVE_INFINITY;
      if (needed <= limit * (1 + 1e-9)) continue;
      const trip = `${stopName(worst.pair[0])} → ${stopName(worst.pair[1])}`;
      const tempo = input.bpm === undefined ? "" : say(` à ${num(input.bpm)} BPM`, ` at ${num(input.bpm)} BPM`);
      const asks = Number.isFinite(needed)
        ? say(`demande ${num(needed)} °/s en ${axis}${tempo}`, `needs ${num(needed)} °/s in ${axis}${tempo}`)
        : say(`est instantané (trajet de 0 s) : ${num(worst.deg)}° en ${axis} d'un coup`, `is instant (no travel time): ${num(worst.deg)}° in ${axis} at once`);
      out.push({
        kind: "speed",
        stops: [...worst.pair],
        heads: [h.id],
        message: say(`${h.name} : le trajet ${trip} ${asks}, la règle en permet ${num(limit)} °/s : la lyre arrivera en retard`, `${h.name}: the trip ${trip} ${asks}, the rule allows ${num(limit)} °/s: the head will arrive late`),
      });
    }
  }
  if (!noAim.length) return out;
  const boxes = noAim.map(boxOf);
  // no-aim zones: a stop landing in one (dark while it rests there), then the trips crossing one (dark while crossing)
  for (const h of heads) {
    if (!h.setup) continue;
    const onStop = new Map<number, Zone[]>();
    path.stops.forEach((_, i) => {
      const p = h.stops[i];
      if (!p || !placed(p)) return;
      const zones = zonesAt(h, p, boxes);
      if (zones.length) onStop.set(i, zones);
      for (const z of zones)
        out.push({
          kind: "noAimStop",
          stops: [i],
          heads: [h.id],
          zone: z.id,
          message: input.zoneLook
            ? say(`viser la ${stopName(i)} envoie ${h.name} dans « ${z.name} » : elle y restera éteinte (zone interdite aux lyres)`, `aiming at the ${stopName(i)} sends ${h.name} into “${z.name}”: it will stay dark there (no-aim zone)`)
            : say(`${stopSaid(i)} vise « ${z.name} » pour ${h.name} : elle y restera éteinte (zone interdite aux lyres)`, `${stopSaid(i)} aims ${h.name} into “${z.name}”: it will stay dark there (no-aim zone)`),
        });
    });
    const crossed = new Map<string, { pair: [number, number]; count: number }>();
    for (const pair of pairs) {
      const [a, b] = [h.stops[pair[0]], h.stops[pair[1]]];
      if (!a || !b || !placed(a) || !placed(b)) continue;
      // the ends are the stops' own (said above): only the points between them
      const n = tripSamples(h, a, b);
      const hit = new Set<Zone>();
      // a zone already found on this trip is not looked for again: the rest of the trip tests the others only
      let left = boxes;
      for (let k = 1; k < n && left.length; k++) {
        const found = zonesAt(h, pathPosition(a, b, k / n), left);
        if (!found.length) continue;
        for (const z of found) hit.add(z);
        left = left.filter((x) => !hit.has(x.zone));
      }
      for (const z of hit) {
        // a zone an end already lands in is no crossing of its own
        if (onStop.get(pair[0])?.includes(z) || onStop.get(pair[1])?.includes(z)) continue;
        const seen = crossed.get(z.id);
        if (seen) seen.count++;
        else crossed.set(z.id, { pair, count: 1 });
      }
    }
    for (const [zoneId, { pair, count }] of crossed) {
      const zone = noAim.find((z) => z.id === zoneId)!;
      const trip = `${stopName(pair[0])} → ${stopName(pair[1])}`;
      const more = count > 1 ? say(` (et ${count - 1} autre${count > 2 ? "s" : ""} trajet${count > 2 ? "s" : ""})`, ` (and ${count - 1} other trip${count > 2 ? "s" : ""})`) : "";
      out.push({
        kind: "noAim",
        stops: [...pair],
        heads: [h.id],
        zone: zoneId,
        message: say(`le trajet ${trip}${more} éteindra ${h.name} le temps de la traversée de « ${zone.name} » (zone interdite aux lyres)`, `the trip ${trip}${more} will darken ${h.name} while it crosses “${zone.name}” (no-aim zone)`),
      });
    }
  }
  return out;
}
