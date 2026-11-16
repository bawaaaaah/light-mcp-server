/**
 * Virtual stage (docs/specs/venue-fixtures-stage.md): zones with a floor height, type, tags and a
 * protected flag; fixtures carry a position, a mount, a role and the zone they aim at. Used by the
 * AI to understand the room (`stage.query`, light://stage) and by rules on protected zones.
 *
 * Frame: metres; X from stage left (−) to stage right (+) seen from the audience, Y from the stage
 * front (0) upstage (+), Z height from the room floor.
 */
import { z } from "zod";
import type { PatchedFixture } from "./venue.js";
import { facingText } from "./orientation.js";
import { say } from "../../../core/lang.js";

const XY = z.tuple([z.number(), z.number()]);

/**
 * A zone the moving heads can be sent to (T27, « zone de visée »): the point they aim at and its height. Any zone can be
 * one (a riser, the audience): it is a part of the zone, not a type.
 */
export const ZoneAimSchema = z.object({
  /** Metres above the zone's floor (1.5: a standing person's face). */
  height: z.number().min(0).max(20).default(1.5),
  /** The point aimed at, X/Y; absent: the centre of the zone's surface (its centroid). */
  point: XY.optional(),
  /** Its colour on the plan and the pads (#rrggbb). */
  color: z.string().optional(),
});
export type ZoneAim = z.infer<typeof ZoneAimSchema>;

/**
 * How the zone was drawn (T27), to edit it again in its own terms: a rectangle by its sides, an ellipse by its axes, a
 * polygon by its corners. The polygon stays the truth for the engine (an ellipse is stored as a polygon of
 * ELLIPSE_POINTS corners); an outline that no longer describes the polygon (moved corners, a third-party put) is
 * ignored when read (`zoneOutline`). Named « outline »: « shape » is a move's shape (T25).
 */
export const ZoneOutlineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rect") }),
  z.object({ kind: z.literal("ellipse"), cx: z.number(), cy: z.number(), rx: z.number().positive(), ry: z.number().positive(), rotation: z.number().optional() }),
  z.object({ kind: z.literal("polygon") }),
]);
export type ZoneOutline = z.infer<typeof ZoneOutlineSchema>;

export const ZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["stage", "riser", "floor", "audience", "wall", "pillar", "truss", "ceiling", "backdrop", "other"]).default("stage"),
  /** Polygon in the X/Y plane. */
  polygon: z.array(XY).min(3),
  floorHeight: z.number().default(0),
  tags: z.array(z.string()).default([]),
  /** Protected: rules targeting it (e.g. intensity cap toward the audience, never the lectern). */
  protected: z.boolean().default(false),
  /**
   * No moving head may point into it (the lectern, the musicians' eyes): a head whose beam crosses
   * it, up to 2.5 m above its floor, is dimmed while it does (docs/specs/rules-limits.md).
   */
  noAim: z.boolean().default(false),
  /** Looks allowed to point heads into a no-aim zone (a deliberate spot on the lectern): while one plays, the zone is open. */
  allowLooks: z.array(z.string()).default([]),
  /** A destination for the moving heads (T27); absent, the zone is still aimed at, at its centre, 1.5 m above its floor. */
  aim: ZoneAimSchema.optional(),
  /** How it was drawn (T27). */
  outline: ZoneOutlineSchema.optional(),
  notes: z.string().optional(),
});
export type Zone = z.infer<typeof ZoneSchema>;

export function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

type Vec = { x: number; y: number; z: number };

/** Where a beam from `o` along `d` meets the floor of the zone under it (the stage floor at first guess), else 2 m out. */
export function landing(o: Vec, d: Vec, zones: Zone[]): Vec & { floor: boolean } {
  if (d.z < -0.05) {
    let t = -o.z / d.z;
    const zone = zones.find((candidate) => pointInPolygon(o.x + t * d.x, o.y + t * d.y, candidate.polygon));
    if (zone?.floorHeight) t = (zone.floorHeight - o.z) / d.z;
    if (t > 0 && t < 20) return { x: o.x + t * d.x, y: o.y + t * d.y, z: o.z + t * d.z, floor: true };
  }
  return { x: o.x + 2 * d.x, y: o.y + 2 * d.y, z: o.z + 2 * d.z, floor: false };
}

/** Whether a beam crosses a zone up to `height` above its floor (head height and more), within 20 m. */
export function beamCrosses(o: Vec, d: Vec, zone: Zone, height = 2.5): boolean {
  for (let t = 0.1; t <= 20; t += 0.1) {
    const [x, y, zAt] = [o.x + t * d.x, o.y + t * d.y, o.z + t * d.z];
    if (zAt < zone.floorHeight - 0.05) return false; // below its floor: the beam has hit the ground
    if (zAt <= zone.floorHeight + height && pointInPolygon(x, y, zone.polygon)) return true;
  }
  return false;
}

// ---- shapes (T27): pure, mirrored by web/src/zone-shape.ts (test/plugins/light/zone-shape-parity.test.ts)

type XYPoint = [number, number];
/** Corners of an ellipse stored as a polygon: fine enough at the scale of a stage. */
export const ELLIPSE_POINTS = 32;
/** The smallest surface a zone may have (m²): a thinner one would fool the beams' crossing test. */
export const MIN_ZONE_AREA = 0.01;
const cm = (v: number) => Math.round(v * 100) / 100;

/** Twice the signed area (shoelace): positive counter-clockwise. */
function doubleArea(poly: readonly XYPoint[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j]![0] * poly[i]![1] - poly[i]![0] * poly[j]![1];
  return a;
}

/** The surface of a polygon, m² (its corners in either order). */
export function polygonArea(poly: readonly XYPoint[]): number {
  return Math.abs(doubleArea(poly)) / 2;
}

/** The centre of a polygon's surface (shoelace centroid); the mean of its corners when it has no surface. */
export function centroid(poly: readonly XYPoint[]): { x: number; y: number } {
  const a = doubleArea(poly);
  if (Math.abs(a) < 1e-9) return { x: poly.reduce((s, p) => s + p[0], 0) / poly.length, y: poly.reduce((s, p) => s + p[1], 0) / poly.length };
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xj, yj] = poly[j]!;
    const [xi, yi] = poly[i]!;
    const k = xj * yi - xi * yj;
    cx += (xj + xi) * k;
    cy += (yj + yi) * k;
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** An ellipse as a polygon of `n` corners to the centimetre, from its centre, half-axes and turn (degrees, counter-clockwise). */
export function ellipsePolygon(cx: number, cy: number, rx: number, ry: number, rotation = 0, n = ELLIPSE_POINTS): XYPoint[] {
  const turn = (rotation * Math.PI) / 180;
  const [c, s] = [Math.cos(turn), Math.sin(turn)];
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    const [x, y] = [rx * Math.cos(a), ry * Math.sin(a)];
    return [cm(cx + x * c - y * s), cm(cy + x * s + y * c)] as XYPoint;
  });
}

/** Orientation of the turn a → b → c: 1 counter-clockwise, −1 clockwise, 0 aligned. */
function turnOf(a: XYPoint, b: XYPoint, c: XYPoint): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.abs(v) < 1e-12 ? 0 : Math.sign(v);
}
/** Whether p, aligned with a and b, lies on the segment between them. */
const onSegment = (a: XYPoint, b: XYPoint, p: XYPoint) =>
  Math.min(a[0], b[0]) - 1e-9 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-9;
/** Whether two segments cross or touch. */
function segmentsMeet(a: XYPoint, b: XYPoint, c: XYPoint, d: XYPoint): boolean {
  const [o1, o2, o3, o4] = [turnOf(a, b, c), turnOf(a, b, d), turnOf(c, d, a), turnOf(c, d, b)];
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  return (o1 === 0 && onSegment(a, b, c)) || (o2 === 0 && onSegment(a, b, d)) || (o3 === 0 && onSegment(c, d, a)) || (o4 === 0 && onSegment(c, d, b));
}

/**
 * Whether a polygon is simple: at least three corners, no corner twice in a row, no two edges crossing or touching
 * except two neighbours at their shared corner, and no edge folded back over the next one.
 */
export function isSimplePolygon(poly: readonly XYPoint[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const [a, b] = [poly[i]!, poly[(i + 1) % n]!];
    if (a[0] === b[0] && a[1] === b[1]) return false;
    // folded back: the next edge goes back along this one
    const c = poly[(i + 2) % n]!;
    if (turnOf(a, b, c) === 0 && (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > 0) return false;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // the last edge and the first share the first corner
      if (segmentsMeet(a, b, poly[j]!, poly[(j + 1) % n]!)) return false;
    }
  }
  return true;
}

/** Why a polygon cannot be a zone (said), or undefined: its edges cross, or it has (almost) no surface. */
export function zoneShapeError(poly: readonly XYPoint[]): string | undefined {
  if (!isSimplePolygon(poly)) return say("le contour de la zone se croise : ses bords ne doivent ni se couper ni revenir sur eux-mêmes", "the zone's outline crosses itself: its edges must neither cut each other nor fold back");
  if (polygonArea(poly) < MIN_ZONE_AREA) return say(`la zone est trop petite (au moins ${MIN_ZONE_AREA} m²)`, `the zone is too small (at least ${MIN_ZONE_AREA} m²)`);
  return undefined;
}

/** Whether a polygon is an upright rectangle (sides along X and Y), as the Lieu page draws one. */
export function isUprightRect(poly: readonly XYPoint[]): boolean {
  return poly.length === 4 && new Set(poly.map((p) => p[0])).size === 2 && new Set(poly.map((p) => p[1])).size === 2 && isSimplePolygon(poly);
}

/** The zone's outline when it still describes its polygon; undefined otherwise (or when it has none). */
export function zoneOutline(zone: Pick<Zone, "polygon" | "outline">): ZoneOutline | undefined {
  const o = zone.outline;
  if (!o) return undefined;
  if (o.kind === "polygon") return o;
  if (o.kind === "rect") return isUprightRect(zone.polygon) ? o : undefined;
  if (zone.polygon.length !== ELLIPSE_POINTS) return undefined;
  const expected = ellipsePolygon(o.cx, o.cy, o.rx, o.ry, o.rotation ?? 0);
  return expected.every((p, i) => Math.hypot(p[0] - zone.polygon[i]![0], p[1] - zone.polygon[i]![1]) <= 0.011) ? o : undefined;
}

/**
 * The point a zone is aimed at (T27): its own aiming point, else the centre of its surface (a rectangle's centre),
 * `height` metres above its floor — given, else the zone's aiming height, else 1.5 (a standing person's face). Shared
 * by position.aim, calibration.record / correct (which pass their own height, 0 by default) and target.zone (T24).
 */
export function zoneAimPoint(zone: Pick<Zone, "polygon" | "floorHeight"> & { aim?: Pick<ZoneAim, "point" | "height"> | undefined }, height?: number): Vec {
  const c = zone.aim?.point ? { x: zone.aim.point[0], y: zone.aim.point[1] } : centroid(zone.polygon);
  return { x: c.x, y: c.y, z: zone.floorHeight + (height ?? zone.aim?.height ?? 1.5) };
}

export function zoneOf(f: PatchedFixture, zones: Zone[]): Zone | undefined {
  if (!f.position) return undefined;
  return zones.find((zone) => pointInPolygon(f.position!.x, f.position!.y, zone.polygon));
}

export interface StageQuery {
  role?: string;
  /** Fixtures located in this zone. */
  inZone?: string;
  /** Fixtures aiming at this zone. */
  aimingAt?: string;
  tags?: string[];
  /** Sort along an axis for spatial effects. */
  sortBy?: "x" | "y" | "z";
}

export function queryStage(fixtures: PatchedFixture[], zones: Zone[], q: StageQuery): { fixture: PatchedFixture; zone?: string; why: string }[] {
  const out: { fixture: PatchedFixture; zone?: string; why: string }[] = [];
  for (const f of fixtures) {
    const located = zoneOf(f, zones);
    const reasons: string[] = [];
    if (q.role) {
      if (f.role !== q.role) continue;
      reasons.push(say(`rôle ${f.role}`, `role ${f.role}`));
    }
    if (q.inZone) {
      if (located?.id !== q.inZone) continue;
      reasons.push(say(`dans ${located.name}`, `in ${located.name}`));
    }
    if (q.aimingAt) {
      if (f.target !== q.aimingAt) continue;
      reasons.push(say(`vise ${q.aimingAt}`, `aims at ${q.aimingAt}`));
    }
    if (q.tags) {
      if (!q.tags.every((t) => f.tags.includes(t))) continue;
      reasons.push(say(`tags ${q.tags.join(", ")}`, `tags ${q.tags.join(", ")}`));
    }
    out.push({ fixture: f, zone: located?.id, why: reasons.join(" · ") || "toutes" });
  }
  if (q.sortBy) {
    const k = q.sortBy;
    out.sort((a, b) => (a.fixture.position?.[k] ?? 0) - (b.fixture.position?.[k] ?? 0));
  }
  return out;
}

/** Plain-French description of the stage, for the AI (light://stage). */
export function describeStage(fixtures: PatchedFixture[], zones: Zone[]): string {
  const lines: string[] = [];
  for (const zone of zones) {
    const inside = fixtures.filter((f) => zoneOf(f, zones)?.id === zone.id);
    const aiming = fixtures.filter((f) => f.target === zone.id);
    lines.push(
      `Zone « ${zone.name} » (${zone.type}${zone.floorHeight ? `, plancher à ${zone.floorHeight} m` : ""}${zone.protected ? ", PROTÉGÉE" : ""}${zone.tags.length ? `, ${zone.tags.join(", ")}` : ""}) : ` +
        `${inside.length ? `contient ${inside.map((f) => f.name).join(", ")}` : "aucun projecteur dedans"}; ` +
        `${aiming.length ? `éclairée par ${aiming.map((f) => `${f.name}${f.role ? ` (${f.role})` : ""}`).join(", ")}` : "aucun projecteur ne la vise"}.`,
    );
  }
  const unplaced = fixtures.filter((f) => !f.position);
  if (unplaced.length) lines.push(`Sans position : ${unplaced.map((f) => f.name).join(", ")}.`);
  const oriented = fixtures.filter((f) => f.orientation);
  if (oriented.length) lines.push(`Orientation : ${oriented.map((f) => `${f.name} ${facingText(f.orientation!)}`).join(", ")}.`);
  return lines.join("\n");
}
