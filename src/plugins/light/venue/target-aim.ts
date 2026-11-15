/**
 * Targets (T24; docs/specs/venue-fixtures-stage.md, « Lyres », « Cible »): a 3D point of the stage that moving heads
 * follow. Pure geometry: where each head points to follow the point, from where it is (`aimNear`: never the long way
 * round), why it cannot (out of reach, a forbidden zone, no stage position), and the volume a target moves in.
 *
 * Frame of stage.ts: metres, X stage left → right seen from the audience, Y front → upstage, Z up from the room floor.
 */
import type { Position } from "../engine/move.js";
import { say } from "../../../core/lang.js";
import { aimNear, type AimSetup } from "./aim.js";
import { pointInPolygon, type Zone } from "./stage.js";

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** The box a target moves in: its point is bounded to it on every write. */
export interface Bounds {
  min: Point3;
  max: Point3;
}

/** Why a head cannot follow the point: it stays where it is (the motion layer's hold, T25 R14). */
export type HoldReason = "out-of-reach" | "no-aim" | "no-position";

/**
 * Why a head holds, as data (T24, lot 4): the motion layer reports it outside any request, so its message is French;
 * a screen in English, or `target.list` answering in English, says it again from this (`holdMessage`).
 */
export interface TargetHold {
  reason: HoldReason;
  /** no-aim: the zone's name. */
  zone?: string;
  /** out-of-reach: the angles asked (degrees), absent when the point is on the head itself (`onFixture`). */
  reach?: { pan: number; tilt: number };
  onFixture?: true;
  /** out-of-reach: the point is within the travel but beyond the head's useful stops (T8, `orientation.limits`). */
  limited?: true;
}

export type HeadAim = { pan: number; tilt: number } | ({ held: true; message: string } & TargetHold);

/** A hold said in the language of the request being answered. */
export function holdMessage(h: TargetHold): string {
  switch (h.reason) {
    case "no-aim":
      return say(`vers une zone interdite (« ${h.zone ?? ""} »)`, `towards a no-aim zone (“${h.zone ?? ""}”)`);
    case "no-position":
      return say("position sur la scène inconnue", "stage position unknown");
    case "out-of-reach":
      if (h.onFixture || !h.reach) return say("la cible est sur la fixture", "the target is on the fixture");
      if (h.limited) return say(`au-delà des butées (pan ${h.reach.pan}°, tilt ${h.reach.tilt}°)`, `beyond the stops (pan ${h.reach.pan}°, tilt ${h.reach.tilt}°)`);
      return say(`hors de portée (pan ${h.reach.pan}°, tilt ${h.reach.tilt}°)`, `out of reach (pan ${h.reach.pan}°, tilt ${h.reach.tilt}°)`);
  }
}

const held = (hold: TargetHold): HeadAim => ({ held: true, ...hold, message: holdMessage(hold) });

/** How high above a no-aim zone's floor a point is still in it: a standing person's head and more (stage.ts `beamCrosses`). */
const NO_AIM_HEIGHT = 2.5;

/** The closed no-aim zone the point lies in (its polygon, from just under its floor up to 2.5 m above), if any. */
export function forbiddenZoneAt(point: Point3, noAim: readonly Zone[]): Zone | undefined {
  return noAim.find((zone) => point.z >= zone.floorHeight - 0.05 && point.z <= zone.floorHeight + NO_AIM_HEIGHT && pointInPolygon(point.x, point.y, zone.polygon));
}

/**
 * Where one head points to follow `point`: the solution closest to `prev` (where it is now), or why it holds. `noAim`:
 * the no-aim zones closed now (the caller leaves out those a playing look opens). A point inside one holds every head:
 * the guard would darken a head whose beam crosses the zone anyway, this keeps it from going there.
 */
export function aimHead(setup: AimSetup | undefined, point: Point3, prev: Partial<Position> | undefined, noAim: readonly Zone[] = []): HeadAim {
  const zone = forbiddenZoneAt(point, noAim);
  if (zone) return held({ reason: "no-aim", zone: zone.name });
  if (!setup) return held({ reason: "no-position" });
  const res = aimNear(setup, point, prev);
  if ("error" in res) return held({ reason: "out-of-reach", ...(res.reach ? { reach: res.reach } : {}), ...(res.onFixture ? { onFixture: true as const } : {}), ...(res.limited ? { limited: true as const } : {}) });
  return { pan: res.pan, tilt: res.tilt };
}

export interface FollowInput {
  point: Point3;
  heads: readonly string[];
  /** Each head's aiming data (venue.ts `aimSetupOf`); absent: its stage position is unknown. */
  setups: ReadonlyMap<string, AimSetup | undefined>;
  /** The no-aim zones closed now. */
  noAim?: readonly Zone[];
  /** Where each head is (the position really sent): the solution kept is the closest to it. */
  sent?: ReadonlyMap<string, Position>;
}

/** Per head, the pan/tilt that follows the point, or why it holds where it is. */
export function followTarget({ point, heads, setups, noAim = [], sent }: FollowInput): Map<string, HeadAim> {
  return new Map(heads.map((head) => [head, aimHead(setups.get(head), point, sent?.get(head), noAim)]));
}

/** Margin around the zones (and the placed fixtures) on X and Y, and above the highest fixture on Z. */
const MARGIN = 0.5;
/** The lowest ceiling of a target's default volume: a standing person's face fits under it, whatever is hung. */
const MIN_TOP = 2;
/** The stage assumed without a zone: 10 m wide, 8 m deep from its front edge, 4 m high (the placed fixtures widen it). */
const EMPTY_STAGE: Bounds = { min: { x: -5, y: 0, z: 0 }, max: { x: 5, y: 8, z: 4 } };

/**
 * The default volume of a target: on X/Y the box of the zones' polygons, 0.5 m around (without a zone, a 10 × 8 m
 * stage widened to the placed fixtures and 0.5 m around them: a row of fixtures alone would leave no depth); on Z from
 * the room floor to 0.5 m above the highest fixture (at least 2 m; 4 m without a zone). « In the volume » is not
 * « within reach of every head »: each head has its own travel, a head that cannot aim the point holds.
 */
export function stageBounds(zones: readonly Pick<Zone, "polygon">[], fixtures: readonly { position?: Point3 | undefined }[]): Bounds {
  const placed = fixtures.flatMap((f) => (f.position ? [f.position] : []));
  const top = (floor: number) => Math.max(floor, ...placed.map((p) => p.z + MARGIN));
  if (!zones.length) {
    const { min, max } = EMPTY_STAGE;
    return {
      min: { x: Math.min(min.x, ...placed.map((p) => p.x - MARGIN)), y: Math.min(min.y, ...placed.map((p) => p.y - MARGIN)), z: 0 },
      max: { x: Math.max(max.x, ...placed.map((p) => p.x + MARGIN)), y: Math.max(max.y, ...placed.map((p) => p.y + MARGIN)), z: top(max.z) },
    };
  }
  const pts = zones.flatMap((z) => z.polygon);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { min: { x: Math.min(...xs) - MARGIN, y: Math.min(...ys) - MARGIN, z: 0 }, max: { x: Math.max(...xs) + MARGIN, y: Math.max(...ys) + MARGIN, z: top(MIN_TOP) } };
}

/** An axis of the stage frame. */
export type StageAxis = "x" | "y" | "z";
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The point held inside the bounds: never refused, a MIDI fader at its end stays valid. */
export function clampPoint(p: Point3, b: Bounds): Point3 {
  return { x: clamp(p.x, b.min.x, b.max.x), y: clamp(p.y, b.min.y, b.max.y), z: clamp(p.z, b.min.z, b.max.z) };
}

/** A coordinate given 0..1 across the bounds (a MIDI fader, OSC), in metres. */
export function fromNormal(axis: StageAxis, n: number, b: Bounds): number {
  return b.min[axis] + clamp(n, 0, 1) * (b.max[axis] - b.min[axis]);
}

/** A coordinate in metres as 0..1 across the bounds (0 on a flat axis). */
export function toNormal(axis: StageAxis, v: number, b: Bounds): number {
  const span = b.max[axis] - b.min[axis];
  return span > 0 ? clamp((v - b.min[axis]) / span, 0, 1) : 0;
}
