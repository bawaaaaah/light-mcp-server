/**
 * Aiming moving heads (docs/specs/venue-fixtures-stage.md, « Lyres »): pan/tilt that point a
 * fixture at a point of the stage, from its position, mount and orientation. Pure geometry.
 *
 * Stage frame (stage.ts): metres, X stage left → right seen from the audience, Y front → upstage,
 * Z up. Fixture frame: pan 0 / tilt 0 = along the base axis (up when standing, down when hung);
 * `yaw` = heading of the fixture's front (where pan 0 + positive tilt points), in degrees from the
 * audience (−Y), clockwise seen from above. Calibration offsets correct the rest.
 */
import type { Position } from "../engine/move.js";

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

/** Normalised pan/tilt (0..1, 0.5 = centre), or an error when the point is out of reach. */
export function aimAt(f: AimSetup, target: { x: number; y: number; z: number }): (Position & { panDeg: number; tiltDeg: number }) | { error: string } {
  let x = target.x - f.position.x;
  let y = target.y - f.position.y;
  let z = target.z - f.position.z;
  const len = Math.hypot(x, y, z);
  if (len < 1e-6) return { error: "la cible est sur la fixture" };
  // Into the fixture frame: undo the yaw (front → −Y), then flip a hung fixture around its front axis.
  const c = Math.cos(rad(f.yaw));
  const s = Math.sin(rad(f.yaw));
  [x, y] = [x * c + y * s, -x * s + y * c];
  if (f.hung) [x, z] = [-x, -z];
  const tilt = deg(Math.acos(Math.max(-1, Math.min(1, z / len))));
  const heading = deg(Math.atan2(x, -y));
  // Two equivalent solutions (pan, tilt) and (pan ± 180, −tilt), and pan ± 360: keep the one in
  // range closest to the centre.
  const candidates: [number, number][] = [];
  for (const k of [-360, 0, 360]) candidates.push([heading + k, tilt], [heading + 180 + k, -tilt]);
  const fit = candidates
    .map(([p, t]) => [p - f.panOffset, t - f.tiltOffset] as [number, number])
    .filter(([p, t]) => Math.abs(p) <= f.panMax / 2 + 1e-9 && Math.abs(t) <= f.tiltMax / 2 + 1e-9)
    // closest to the centre; on a tie, a positive tilt (the natural side for calibration)
    .sort((a, b) => {
      const d = Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1]));
      return Math.abs(d) > 1e-6 ? d : Number(a[1] < 0) - Number(b[1] < 0);
    })[0];
  if (!fit) return { error: `hors de portée (pan ${Math.round(heading)}°, tilt ${Math.round(tilt)}°)` };
  const [panDeg, tiltDeg] = fit;
  return { pan: panDeg / f.panMax + 0.5, tilt: tiltDeg / f.tiltMax + 0.5, panDeg, tiltDeg };
}
