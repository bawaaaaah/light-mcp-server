/**
 * Where a fixture points at rest (docs/specs/venue-fixtures-stage.md, « Orientation »): `yaw`, the
 * heading of its front in the aim.ts convention — 0 = the audience, 90 = cour (house right, +X),
 * 180 = the upstage wall, −90 = jardin (house left, −X) — and `pitch`, from −90 (the floor) to 90
 * (the ceiling). Named facings for the stage plan, the CLI and AI. Pure.
 */
import type { PatchedFixture } from "./venue.js";

export const FACINGS = {
  audience: { yaw: 0, pitch: 0 },
  upstage: { yaw: 180, pitch: 0 },
  houseLeft: { yaw: -90, pitch: 0 },
  houseRight: { yaw: 90, pitch: 0 },
  ceiling: { pitch: 90 },
  floor: { pitch: -90 },
} as const satisfies Record<string, { yaw?: number; pitch: number }>;
export type Facing = keyof typeof FACINGS;
export const FACING_NAMES = Object.keys(FACINGS) as [Facing, ...Facing[]];

/** A heading in (−180, 180]. */
export const wrapYaw = (d: number) => {
  const w = ((((d + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : w;
};

/** The named facing an orientation matches, if any (ceiling and floor whatever the heading). */
export function facingOf(o?: { yaw?: number; pitch?: number }): Facing | undefined {
  if (!o) return undefined;
  const pitch = o.pitch ?? 0;
  const yaw = wrapYaw(o.yaw ?? 0);
  return FACING_NAMES.find((name) => {
    const f: { yaw?: number; pitch: number } = FACINGS[name];
    return Math.abs(f.pitch - pitch) < 1e-6 && (f.yaw === undefined || Math.abs(wrapYaw(f.yaw - yaw)) < 1e-6);
  });
}

/** How the stage description says where a fixture points (French, like the rest of it). */
const FACING_TEXT: Record<Facing, string> = { audience: "vers le public", upstage: "vers le mur de scène", houseLeft: "vers le mur jardin", houseRight: "vers le mur cour", ceiling: "vers le plafond", floor: "vers le sol" };
export function facingText(o: { yaw?: number; pitch?: number }): string {
  const facing = facingOf(o);
  return facing ? FACING_TEXT[facing] : `cap ${Math.round(o.yaw ?? 0)}°, inclinaison ${Math.round(o.pitch ?? 0)}°`;
}

/** The orientation once a facing is chosen: ceiling and floor keep the heading (a bar keeps its line). */
export function orientTo(o: { yaw?: number; pitch?: number } | undefined, facing: Facing): { yaw: number; pitch: number } {
  const f: { yaw?: number; pitch: number } = FACINGS[facing];
  return { yaw: f.yaw ?? wrapYaw(o?.yaw ?? 0), pitch: f.pitch };
}

/** Unit vector of the beam in the stage frame (X house right, Y upstage, Z up). */
export function beamDirection(o?: { yaw?: number; pitch?: number }): { x: number; y: number; z: number } {
  const yaw = ((o?.yaw ?? 0) * Math.PI) / 180;
  const pitch = ((o?.pitch ?? 0) * Math.PI) / 180;
  return { x: Math.sin(yaw) * Math.cos(pitch), y: -Math.cos(yaw) * Math.cos(pitch), z: Math.sin(pitch) };
}

/**
 * A moving head's base points down (hung): an orientation clearly towards the floor or the ceiling
 * says so; otherwise the mount does (hung, truss, ceiling).
 */
export function isHung(f: Pick<PatchedFixture, "mount" | "orientation">): boolean {
  const pitch = f.orientation?.pitch;
  if (pitch !== undefined && Math.abs(pitch) >= 45) return pitch < 0;
  return f.mount === "hung" || f.mount === "truss" || f.mount === "ceiling";
}
