/**
 * What a look's path will do on the stage, said ahead (T28; docs/specs/engine-effects-timing.md, « Parcours »): at save
 * (look.put), in the look editor (look.preview) and in « Vérifier le show ». Pure: the caller resolves each stop for each
 * head (the render's own resolution, `pathStopAt`) and gives the speed limits that apply and the closed no-aim zones.
 *
 * - **Unreachable stops**: a head that cannot go to a stop holds where it is for the steps that lead there or leave it.
 * - **Speed** (`maxDegPerSecond`), per head and per axis: the degrees of each trip (|Δ| × travel of that axis) against
 *   the slowest rule that applies to that head, over the trip's time (`every × travel`, at the current tempo for a
 *   cadence in beats); said only where a rule applies — the head will arrive late, the rule bounds its output anyway.
 * - **No-aim zones**: a trip whose beam crosses a closed no-aim zone (16 points along the pan/tilt interpolation, the
 *   guard's own test) darkens the head while it crosses (the guard never steers, decision of 2026-10-17).
 */
import { say } from "../../../core/lang.js";
import { pathPosition, travelPairs, type Path, type StopPosition } from "../engine/path.js";
import type { Position } from "../engine/move.js";
import { pointing, type AimSetup } from "./aim.js";
import { beamCrosses, type Zone } from "./stage.js";

/** One moving head as the checks see it. */
export interface PathHead {
  id: string;
  name: string;
  /** Degrees of travel of each axis. */
  panMax: number;
  tiltMax: number;
  /** Where it is and how it points (absent: no stage position, the no-aim check is skipped for it). */
  setup?: AimSetup | undefined;
  /** Each stop of the path for this head, in order (`resolveStops`). */
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
  /** How a stop is named in a message (« zone « Avant-scène » », « point (1, 2, 0) »…), by index. */
  stopName: (index: number) => string;
  /** The tempo a cadence in beats was timed at, said in the speed warning (absent: a cadence in seconds). */
  bpm?: number;
}

export type PathWarningKind = "unreachable" | "nowhere" | "speed" | "noAim";
export interface PathWarning {
  kind: PathWarningKind;
  message: string;
  /** The stops it is about (indexes). */
  stops: number[];
  /** The heads it is about. */
  heads: string[];
  zone?: string;
}

/** Points sampled along a trip for the no-aim test, ends included. */
export const NO_AIM_SAMPLES = 16;

const placed = (p: StopPosition): p is Position => !("error" in p);
const round = (v: number) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);

/** Every warning for a path, in a stable order: stops, then speed, then no-aim zones. */
export function checkPath(input: PathCheckInput): PathWarning[] {
  const { path, heads, noAim, stopName } = input;
  const out: PathWarning[] = [];
  const names = (ids: readonly string[]) => ids.map((id) => heads.find((h) => h.id === id)?.name ?? id).join(", ");
  // stops nobody, or not every head, can reach
  path.stops.forEach((_, i) => {
    const failing = heads.filter((h) => h.stops[i] && !placed(h.stops[i]!));
    if (!failing.length) return;
    const why = [...new Set(failing.map((h) => (h.stops[i] as { error: string }).error))].join(" ; ");
    if (failing.length === heads.length)
      out.push({
        kind: "nowhere",
        stops: [i],
        heads: failing.map((h) => h.id),
        message: say(`l'arrêt ${i + 1} (${stopName(i)}) n'est atteint par aucune lyre (${why}) : elles restent en place pendant les pas qui y mènent ou en partent`, `stop ${i + 1} (${stopName(i)}) is reached by no head (${why}): they hold during the steps that lead there or leave it`),
      });
    else
      out.push({
        kind: "unreachable",
        stops: [i],
        heads: failing.map((h) => h.id),
        message: say(`l'arrêt ${i + 1} (${stopName(i)}) est hors d'atteinte de ${names(failing.map((h) => h.id))} (${why}) : elles restent en place pendant les pas qui y mènent ou en partent`, `stop ${i + 1} (${stopName(i)}) is out of reach of ${names(failing.map((h) => h.id))} (${why}): they hold during the steps that lead there or leave it`),
      });
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
      const axisFr = axis === "pan" ? "en pan" : "en tilt";
      const tempo = input.bpm === undefined ? "" : say(` à ${round(input.bpm)} BPM`, ` at ${round(input.bpm)} BPM`);
      const asks = Number.isFinite(needed) ? say(`demande ${round(needed)}°/s ${axisFr}${tempo}`, `needs ${round(needed)}°/s in ${axis}${tempo}`) : say(`est instantané (trajet 0) : ${round(worst.deg)}° ${axisFr}`, `is instant (no travel time): ${round(worst.deg)}° in ${axis}`);
      out.push({
        kind: "speed",
        stops: [...worst.pair],
        heads: [h.id],
        message: say(`${h.name} : le trajet ${trip} ${asks}, la règle en permet ${round(limit)} : la lyre arrivera en retard`, `${h.name}: the trip ${trip} ${asks}, the rule allows ${round(limit)}: the head will arrive late`),
      });
    }
  }
  // no-aim zones crossed: one warning per head and zone, its first trip named
  if (noAim.length)
    for (const h of heads) {
      if (!h.setup) continue;
      const crossed = new Map<string, { pair: [number, number]; count: number }>();
      const trips: [number, number][] = pairs.length ? pairs : path.stops.length ? [[0, 0]] : [];
      for (const pair of trips) {
        const [a, b] = [h.stops[pair[0]], h.stops[pair[1]]];
        if (!a || !b || !placed(a) || !placed(b)) continue;
        const zone = noAim.find((z) => {
          for (let k = 0; k < NO_AIM_SAMPLES; k++) if (beamCrosses(h.setup!.position, pointing(h.setup!, pathPosition(a, b, k / (NO_AIM_SAMPLES - 1))), z)) return true;
          return false;
        });
        if (!zone) continue;
        const seen = crossed.get(zone.id);
        if (seen) seen.count++;
        else crossed.set(zone.id, { pair, count: 1 });
      }
      for (const [zoneId, { pair, count }] of crossed) {
        const zone = noAim.find((z) => z.id === zoneId)!;
        const trip = pair[0] === pair[1] ? stopName(pair[0]) : `${stopName(pair[0])} → ${stopName(pair[1])}`;
        const more = count > 1 ? say(` (et ${count - 1} autre${count > 2 ? "s" : ""} trajet${count > 2 ? "s" : ""})`, ` (and ${count - 1} other trip${count > 2 ? "s" : ""})`) : "";
        out.push({
          kind: "noAim",
          stops: [...new Set(pair)],
          heads: [h.id],
          zone: zoneId,
          message: say(
            `le trajet ${trip}${more} éteindra ${h.name} le temps de la traversée de « ${zone.name} » (zone interdite aux lyres)`,
            `the trip ${trip}${more} will darken ${h.name} while it crosses “${zone.name}” (no-aim zone)`,
          ),
        });
      }
    }
  return out;
}
