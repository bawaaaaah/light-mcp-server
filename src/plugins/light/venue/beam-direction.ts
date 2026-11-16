/**
 * Where a moving head's beam points (docs/specs/venue-fixtures-stage.md, « Lyres »): the inverse of aiming (aim.ts), from
 * an angle pair or a logical pan/tilt to a unit vector in the stage frame. Pure (no `say`, no I/O): the server (aim.ts,
 * the venue, the paths) and the web app (web/src/pad-zones.ts: touching a zone on a head's pad) import this one module,
 * so a touch on the pad sends the head where the server says it points.
 */
import type { Position } from "../engine/move.js";

/** A head's frame for the beam: its mount and heading, its travel and its calibration offsets (degrees). */
export interface HeadFrame {
  hung: boolean;
  yaw: number;
  panMax: number;
  tiltMax: number;
  panOffset: number;
  tiltOffset: number;
}

const rad = (d: number) => (d * Math.PI) / 180;

/** The beam's unit vector, stage frame, for an angle pair in the fixture frame: the inverse of rawAngles. */
export function directionOf(f: Pick<HeadFrame, "hung" | "yaw">, a: { heading: number; tilt: number }): { x: number; y: number; z: number } {
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
export function pointing(f: HeadFrame, p: Position): { x: number; y: number; z: number } {
  return directionOf(f, { heading: (p.pan - 0.5) * f.panMax + f.panOffset, tilt: (p.tilt - 0.5) * f.tiltMax + f.tiltOffset });
}
