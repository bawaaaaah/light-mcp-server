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

export const ZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["stage", "riser", "floor", "audience", "wall", "pillar", "truss", "ceiling", "backdrop", "other"]).default("stage"),
  /** Polygon in the X/Y plane. */
  polygon: z.array(z.tuple([z.number(), z.number()])).min(3),
  floorHeight: z.number().default(0),
  tags: z.array(z.string()).default([]),
  /** Protected: rules targeting it (e.g. intensity cap toward the audience, never the lectern). */
  protected: z.boolean().default(false),
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

export function zoneOf(f: PatchedFixture, zones: Zone[]): Zone | undefined {
  if (!f.position) return undefined;
  return zones.find((z) => pointInPolygon(f.position!.x, f.position!.y, z.polygon));
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
      reasons.push(`rôle ${f.role}`);
    }
    if (q.inZone) {
      if (located?.id !== q.inZone) continue;
      reasons.push(`dans ${located.name}`);
    }
    if (q.aimingAt) {
      if (f.target !== q.aimingAt) continue;
      reasons.push(`vise ${q.aimingAt}`);
    }
    if (q.tags) {
      if (!q.tags.every((t) => f.tags.includes(t))) continue;
      reasons.push(`tags ${q.tags.join(", ")}`);
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
  for (const z of zones) {
    const inside = fixtures.filter((f) => zoneOf(f, zones)?.id === z.id);
    const aiming = fixtures.filter((f) => f.target === z.id);
    lines.push(
      `Zone « ${z.name} » (${z.type}${z.floorHeight ? `, plancher à ${z.floorHeight} m` : ""}${z.protected ? ", PROTÉGÉE" : ""}${z.tags.length ? `, ${z.tags.join(", ")}` : ""}) : ` +
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
