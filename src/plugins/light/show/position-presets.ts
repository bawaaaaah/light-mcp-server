/**
 * Named positions (T32; docs/specs/venue-fixtures-stage.md, « Positions nommées »): the pure part. What gives a head's
 * stored pan/tilt its meaning (`basisOf`), which heads of a position are stale (`positionStale`), and the basis a write
 * keeps (`fillBasis`). No venue, no clock: the callers pass the fixtures as they are now.
 */
import { createHash } from "node:crypto";
import { stableStringify } from "../data/store.js";
import type { PatchedFixture } from "../venue/venue.js";
import type { PositionPreset } from "./model.js";

/** What of a fixture gives a logical pan/tilt its direction on the stage: its geometry, its travel, its definition. */
export interface BasisSource {
  patch: Pick<PatchedFixture, "manufacturer" | "model" | "mode" | "position" | "mount" | "orientation">;
  /** Degrees of travel (the definition's, or its overrides'); absent when the definition cannot be read. */
  panMax?: number;
  tiltMax?: number;
}

/**
 * A short fingerprint of what makes a stored pan/tilt point where it pointed: the stage position, the mount, the
 * orientation fields that turn the beam (heading, pitch, inversions, swap, calibration offsets), the pan/tilt travel and
 * the definition with its mode. Nothing else: a renamed fixture, a new colour, another address or universe, its roll
 * (a bar's, not a head's) leave a position fresh. Defaults are filled in so that an orientation written out with its
 * default values is the same basis as none.
 */
export function basisOf(f: BasisSource): string {
  const o = f.patch.orientation;
  const geometry = {
    model: [f.patch.manufacturer, f.patch.model, f.patch.mode],
    position: f.patch.position ?? null,
    mount: f.patch.mount ?? null,
    yaw: o?.yaw ?? 0,
    pitch: o?.pitch ?? null,
    invertPan: o?.invertPan ?? false,
    invertTilt: o?.invertTilt ?? false,
    swapPanTilt: o?.swapPanTilt ?? false,
    panOffset: o?.panOffset ?? 0,
    tiltOffset: o?.tiltOffset ?? 0,
    panMax: f.panMax ?? null,
    tiltMax: f.tiltMax ?? null,
  };
  return createHash("sha1").update(stableStringify(geometry)).digest("hex").slice(0, 12);
}

/** The heads a position covers: those of its pan/tilt; a point covers none by itself (every placed head aims at it). */
export const coveredHeads = (p: Pick<PositionPreset, "values">): string[] => Object.keys(p.values);

/**
 * The covered heads whose basis changed since the position was saved: moved, rehung, turned, recalibrated, given another
 * mode or definition. `basisNow` gives a fixture's basis now, undefined when it is no longer patched (said apart, not
 * stale). A head saved without a basis cannot be judged: never stale. A 3D point is never stale (it has no basis).
 * Computed on demand (list, « Vérifier le show »), never per frame.
 */
export function positionStale(p: Pick<PositionPreset, "values" | "basis" | "point">, basisNow: (fixture: string) => string | undefined): string[] {
  if (p.point) return [];
  return coveredHeads(p).filter((head) => {
    const saved = p.basis[head];
    const now = basisNow(head);
    return saved !== undefined && now !== undefined && saved !== now;
  });
}

/**
 * The basis a written position keeps, per covered head: the one given, else the stored one when the head's pan/tilt did
 * not change, else the head's basis now (a pan/tilt written by hand is meant for the fixture as it is). A head no longer
 * patched keeps what it had, or none. A point keeps no basis.
 */
export function fillBasis(next: Pick<PositionPreset, "values" | "basis" | "point">, stored: Pick<PositionPreset, "values" | "basis"> | undefined, basisNow: (fixture: string) => string | undefined): Record<string, string> {
  if (next.point) return {};
  const out: Record<string, string> = {};
  for (const [head, v] of Object.entries(next.values)) {
    const given = Object.hasOwn(next.basis, head) ? next.basis[head] : undefined;
    const was = stored && Object.hasOwn(stored.values, head) ? stored.values[head] : undefined;
    const same = was !== undefined && was.pan === v.pan && was.tilt === v.tilt;
    const kept = same && stored && Object.hasOwn(stored.basis, head) ? stored.basis[head] : undefined;
    const basis = given ?? kept ?? basisNow(head);
    if (basis !== undefined) out[head] = basis;
  }
  return out;
}
