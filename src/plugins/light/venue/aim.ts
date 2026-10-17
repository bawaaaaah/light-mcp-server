/**
 * Aiming moving heads (docs/specs/venue-fixtures-stage.md, « Lyres »): pan/tilt that point a
 * fixture at a point of the stage, from its position, mount and orientation. Pure geometry.
 *
 * Stage frame (stage.ts): metres, X stage left → right seen from the audience, Y front → upstage,
 * Z up. Fixture frame: pan 0 / tilt 0 = along the base axis (up when standing, down when hung);
 * `yaw` = heading of the fixture's front (where pan 0 + positive tilt points), in degrees from the
 * audience (−Y): 90 = cour (+X), −90 = jardin (orientation.ts). Calibration offsets correct the rest.
 */
import type { Position } from "../engine/move.js";
import { say } from "../../../core/lang.js";

export interface AimSetup {
  position: { x: number; y: number; z: number };
  hung: boolean;
  yaw: number;
  panMax: number;
  tiltMax: number;
  panOffset: number;
  tiltOffset: number;
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Direction of a target in the fixture frame: heading (pan) and tilt from the base axis, in degrees. */
export function rawAngles(f: Pick<AimSetup, "position" | "hung" | "yaw">, target: { x: number; y: number; z: number }): { heading: number; tilt: number } | null {
  let x = target.x - f.position.x;
  let y = target.y - f.position.y;
  let z = target.z - f.position.z;
  const len = Math.hypot(x, y, z);
  if (len < 1e-6) return null;
  // Into the fixture frame: undo the yaw (front → −Y), then flip a hung fixture around its front axis.
  const c = Math.cos(rad(f.yaw));
  const s = Math.sin(rad(f.yaw));
  [x, y] = [x * c + y * s, -x * s + y * c];
  if (f.hung) [x, z] = [-x, -z];
  return { tilt: deg(Math.acos(Math.max(-1, Math.min(1, z / len)))), heading: deg(Math.atan2(x, -y)) };
}

/** Equivalent (pan, tilt) pairs for a direction: (pan, tilt), (pan ± 180, −tilt), and pan ± 360. */
export function angleCandidates(a: { heading: number; tilt: number }): [number, number][] {
  const out: [number, number][] = [];
  for (const k of [-360, 0, 360]) out.push([a.heading + k, a.tilt], [a.heading + 180 + k, -a.tilt]);
  return out;
}

/** Normalised pan/tilt (0..1, 0.5 = centre), or an error when the point is out of reach. */
export function aimAt(f: AimSetup, target: { x: number; y: number; z: number }): (Position & { panDeg: number; tiltDeg: number }) | { error: string } {
  const raw = rawAngles(f, target);
  if (!raw) return { error: say("la cible est sur la fixture", "the target is on the fixture") };
  // keep the solution in range closest to the centre
  const fit = angleCandidates(raw)
    .map(([p, t]) => [p - f.panOffset, t - f.tiltOffset] as [number, number])
    .filter(([p, t]) => Math.abs(p) <= f.panMax / 2 + 1e-9 && Math.abs(t) <= f.tiltMax / 2 + 1e-9)
    // closest to the centre; on a tie, a positive tilt (the natural side for calibration)
    .sort((a, b) => {
      const d = Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1]));
      return Math.abs(d) > 1e-6 ? d : Number(a[1] < 0) - Number(b[1] < 0);
    })[0];
  if (!fit) return { error: say(`hors de portée (pan ${Math.round(raw.heading)}°, tilt ${Math.round(raw.tilt)}°)`, `out of reach (pan ${Math.round(raw.heading)}°, tilt ${Math.round(raw.tilt)}°)`) };
  const [panDeg, tiltDeg] = fit;
  return { pan: panDeg / f.panMax + 0.5, tilt: tiltDeg / f.tiltMax + 0.5, panDeg, tiltDeg };
}

/** The beam's unit vector, stage frame, for an angle pair in the fixture frame: the inverse of rawAngles. */
export function directionOf(f: Pick<AimSetup, "hung" | "yaw">, a: { heading: number; tilt: number }): { x: number; y: number; z: number } {
  const [h, t] = [rad(a.heading), rad(a.tilt)];
  let x = Math.sin(t) * Math.sin(h);
  const y = -Math.sin(t) * Math.cos(h);
  let z = Math.cos(t);
  if (f.hung) [x, z] = [-x, -z];
  const c = Math.cos(rad(f.yaw));
  const s = Math.sin(rad(f.yaw));
  return { x: x * c - y * s, y: x * s + y * c, z };
}

/** Where a moving head points from its logical pan/tilt (0..1, inversions undone): the inverse of aimAt. */
export function pointing(f: AimSetup, p: Position): { x: number; y: number; z: number } {
  return directionOf(f, { heading: (p.pan - 0.5) * f.panMax + f.panOffset, tilt: (p.tilt - 0.5) * f.tiltMax + f.tiltOffset });
}

/** A calibration sample: the head aimed by hand at a known point, in output (DMX) values 0..1. */
export interface CalibrationSample {
  target: { x: number; y: number; z: number };
  pan: number;
  tilt: number;
}

export interface Calibration {
  yaw: number;
  tiltOffset: number;
  invertPan: boolean;
  invertTilt: boolean;
  /** RMS angular error over the samples, degrees */
  errorDeg: number;
  /** per-sample error, degrees */
  errors: number[];
}

/**
 * Guided calibration (docs/specs/venue-fixtures-stage.md, « Lyres »): from 2–3 points aimed at by
 * hand, finds the yaw, tilt offset and pan/tilt inversions that best explain them. For a level
 * fixture, a pan offset is the same thing as a yaw, so the pan offset is folded into the yaw.
 * Brute force over yaw (1°, then 0.05° around the best) and the four inversions. Pure.
 */
export function calibrate(f: Pick<AimSetup, "position" | "hung" | "panMax" | "tiltMax">, samples: CalibrationSample[]): Calibration | { error: string } {
  if (samples.length < 2) return { error: say("au moins deux repères visés sont nécessaires (trois conseillés)", "at least two aimed marks are needed (three advised)") };
  const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
  const evaluate = (yaw: number, invertPan: boolean, invertTilt: boolean): Calibration | null => {
    const residuals: [number, number][] = [];
    for (const s of samples) {
      const raw = rawAngles({ position: f.position, hung: f.hung, yaw }, s.target);
      if (!raw) return null;
      const rec: [number, number] = [((invertPan ? 1 - s.pan : s.pan) - 0.5) * f.panMax, ((invertTilt ? 1 - s.tilt : s.tilt) - 0.5) * f.tiltMax];
      // the equivalent solution the operator actually used: the closest to what was recorded
      const best = angleCandidates(raw)
        .map(([p, t]) => [wrap(p - rec[0]), t - rec[1]] as [number, number])
        .sort((a, b) => Math.hypot(...a) - Math.hypot(...b))[0]!;
      residuals.push(best);
    }
    const tiltOffset = residuals.reduce((a, r) => a + r[1], 0) / residuals.length;
    const errors = residuals.map(([p, t]) => Math.hypot(p, t - tiltOffset));
    const errorDeg = Math.sqrt(errors.reduce((a, e) => a + e * e, 0) / errors.length);
    return { yaw: wrap(yaw), tiltOffset, invertPan, invertTilt, errorDeg, errors };
  };
  let best: Calibration | null = null;
  for (const invertPan of [false, true])
    for (const invertTilt of [false, true])
      for (let yaw = -180; yaw < 180; yaw += 1) {
        const c = evaluate(yaw, invertPan, invertTilt);
        if (c && (!best || c.errorDeg < best.errorDeg)) best = c;
      }
  if (!best) return { error: say("un repère est sur la fixture elle-même", "a mark is on the fixture itself") };
  for (let yaw = best.yaw - 1; yaw <= best.yaw + 1; yaw += 0.05) {
    const c = evaluate(yaw, best.invertPan, best.invertTilt);
    if (c && c.errorDeg < best.errorDeg) best = c;
  }
  const round = (v: number, d = 10) => Math.round(v * d) / d;
  return { ...best, yaw: round(best.yaw), tiltOffset: round(best.tiltOffset), errorDeg: round(best.errorDeg, 100), errors: best.errors.map((e) => round(e, 100)) };
}
