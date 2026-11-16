/**
 * The aiming zones on a single head's XY pad (T27, lots 4-5; docs/specs/venue-fixtures-stage.md, « Sur le pad d'une
 * lyre »): which zone lies under a pad point, found on the **stage** (the beam followed to each zone's aiming plane, then
 * the zone's polygon), never on the drawn outlines; and the pad's frame when it zooms on the zones. Pure, for the tests.
 *
 * `pointingOf` copies `pointing` / `directionOf` of src/plugins/light/venue/aim.ts (the interface shares no code with the
 * server): a parity test keeps them equal.
 */
import type { AimSetup } from "../../src/plugins/light/venue/aim.js";
import type { PadPoint, ProjectedZone } from "../../src/plugins/light/venue/zone-project.js";
import { pointInPolygon } from "./zone-shape.js";

export type { PadPoint, ProjectedZone };
/** A head's aiming data as `stage.zone.project` gives it (its stops aside: the drawing already left them out). */
export type PadHead = Omit<AimSetup, "limits">;

const rad = (d: number): number => (d * Math.PI) / 180;

/** Where a head points from its logical pan/tilt (0..1, inversions undone): a unit vector, stage frame. */
export function pointingOf(f: PadHead, pan: number, tilt: number): { x: number; y: number; z: number } {
  const h = rad((pan - 0.5) * f.panMax + f.panOffset);
  const t = rad((tilt - 0.5) * f.tiltMax + f.tiltOffset);
  let x = Math.sin(t) * Math.sin(h);
  const y = -Math.sin(t) * Math.cos(h);
  let z = Math.cos(t);
  if (f.hung) [x, z] = [-x, -z];
  const c = Math.cos(rad(f.yaw));
  const s = Math.sin(rad(f.yaw));
  return { x: x * c - y * s, y: x * s + y * c, z };
}

/**
 * The zone under a pad point: the beam from the head followed to each zone's aiming plane, the last zone of the list
 * first (drawn on top, as on the plan); undefined when the beam meets none of them. A zone with an aiming point counts
 * only on the branch its outline is drawn on (the other solutions, pan ± 180° with the tilt mirrored or pan ± 360°, meet
 * the same zone where nothing is drawn): within 180° of pan of its aiming point and on the same side of the head's axis,
 * or, for a zone around the axis (`axisInside`), within 90° of pan of it.
 */
export function zoneUnder<Z extends Pick<ProjectedZone, "polygon" | "plane" | "aim" | "axisInside">>(head: PadHead, zones: readonly Z[], pan: number, tilt: number): Z | undefined {
  const d = pointingOf(head, pan, tilt);
  for (let i = zones.length - 1; i >= 0; i--) {
    const zone = zones[i]!;
    if (zone.aim && !onBranch(head, zone.aim, zone.axisInside === true, pan, tilt)) continue;
    const k = (zone.plane - head.position.z) / d.z;
    if (!(k > 0) || !Number.isFinite(k)) continue;
    if (pointInPolygon(head.position.x + d.x * k, head.position.y + d.y * k, zone.polygon)) return zone;
  }
  return undefined;
}

/** Whether a pad point is on the branch of the solution `aim` is on (see zoneUnder). */
function onBranch(head: PadHead, aim: PadPoint, axisInside: boolean, pan: number, tilt: number): boolean {
  const panGap = Math.abs(pan - aim[0]) * head.panMax;
  if (axisInside) return panGap <= 90;
  const side = (t: number): number => Math.sign((t - 0.5) * head.tiltMax + head.tiltOffset);
  return panGap < 180 && side(tilt) === side(aim[1]);
}

/** The legend texts zoneStateTexts needs (the interface's `zoneAim` texts). */
export interface ZoneStateTexts {
  projectedOut: string;
  projectedOutlineOut: string;
  projectedPartial: string;
  projectedAimOut: string;
  projectedAxis: string;
}

/**
 * What a projected zone's legend line says besides its name: its reach (nothing drawn while its aiming point is in
 * reach: only its outline is out of reach, the chip still works), its aiming point beyond the stops, the axis.
 */
export const zoneStateTexts = (t: ZoneStateTexts, z: Pick<ProjectedZone, "reach" | "aim" | "axisInside">): string[] => [
  ...(z.reach === "none" ? [z.aim ? t.projectedOutlineOut : t.projectedOut] : z.reach === "partial" ? [t.projectedPartial] : []),
  ...(!z.aim && z.reach !== "none" ? [t.projectedAimOut] : []),
  ...(z.axisInside ? [t.projectedAxis] : []),
];

/** A part of the pad, logical 0..1: pan from x0 to x1, tilt from y0 to y1. The whole pad: 0..1 both ways. */
export interface PadView {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
export const WHOLE_PAD: PadView = { x0: 0, x1: 1, y0: 0, y1: 1 };

/**
 * The frame that holds every zone drawn (its runs and its aiming point), with a margin of a fifth of its size around, kept
 * square (the pad is) and within the pad, never smaller than `min` of the travel. Undefined when nothing is drawn.
 */
export function zonesView(zones: readonly { paths: ProjectedZone["paths"]; aim?: ProjectedZone["aim"] }[], min = 0.1): PadView | undefined {
  const pts = zones.flatMap((z) => [...z.paths.flat(), ...(z.aim ? [z.aim] : [])]);
  if (!pts.length) return undefined;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [cx, cy] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const size = Math.min(1, Math.max(min, (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.4)));
  const start = (c: number) => Math.max(0, Math.min(1 - size, c - size / 2));
  const [x0, y0] = [start(cx), start(cy)];
  return { x0, x1: x0 + size, y0, y1: y0 + size };
}

/** A logical point → where it sits on the pad (0..1 across and up) in `view`. */
export const toView = (v: PadView, pan: number, tilt: number): [number, number] => [(pan - v.x0) / (v.x1 - v.x0), (tilt - v.y0) / (v.y1 - v.y0)];
/** A point of the pad (0..1 across and up) in `view` → the logical point. */
export const fromView = (v: PadView, x: number, y: number): [number, number] => [v.x0 + x * (v.x1 - v.x0), v.y0 + y * (v.y1 - v.y0)];
