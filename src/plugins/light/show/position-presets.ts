/**
 * Named positions (T32; docs/specs/venue-fixtures-stage.md, « Positions nommées »): the pure part. What gives a head's
 * stored pan/tilt its meaning (`basisOf`), which heads of a position are stale (`positionStale`), and the basis a write
 * keeps (`fillBasis`). No venue, no clock: the callers pass the fixtures as they are now.
 */
import { createHash } from "node:crypto";
import { stableStringify } from "../data/store.js";
import { isHung } from "../venue/orientation.js";
import type { PatchedFixture } from "../venue/venue.js";
import type { PositionPreset } from "./model.js";

/** What of a fixture gives a logical pan/tilt its direction on the stage: its geometry, its travel, its definition, its stops. */
export interface BasisSource {
  patch: Pick<PatchedFixture, "manufacturer" | "model" | "position" | "mount" | "orientation">;
  /** Degrees of travel (the definition's, or its overrides'); absent when the definition cannot be read. */
  panMax?: number;
  tiltMax?: number;
}

const hash = (v: unknown) => createHash("sha1").update(stableStringify(v)).digest("hex").slice(0, 12);
const yawOf = (o: BasisSource["patch"]["orientation"]) => (((o?.yaw ?? 0) % 360) + 360) % 360;

/**
 * A short fingerprint of what makes a stored pan/tilt point where it pointed, in three parts `geometry.aiming.stops`
 * (decision of the user, 2026-11-15: a correction of the calibration or of the travel only stales the heads aimed at a
 * point; a pan/tilt set at the pad keeps its bytes):
 * - **geometry**, what changes where the same bytes send the beam: the stage position, whether the head hangs (what the
 *   aiming reads of the mount and the pitch, `isHung`: a truss and a hook are the same), its inversions and swap, the
 *   definition;
 * - **aiming**, what only changes the angles a pan/tilt is read as (never the bytes): its heading (modulo 360), its
 *   calibration offsets, the pan/tilt travel;
 * - **stops**, its useful stops (T8): only a stored pan/tilt beyond new stops is stale (it would be clipped).
 * Nothing else: a renamed fixture, a new colour, another address or universe, its roll (a bar's, not a head's), its
 * 8-bit or 16-bit mode (T6, decision P2: the travel is already in it) leave a position fresh. Defaults are filled in so
 * that an orientation written out with its default values is the same basis as none.
 */
export function basisOf(f: BasisSource): string {
  const o = f.patch.orientation;
  const geometry = {
    model: [f.patch.manufacturer, f.patch.model],
    position: f.patch.position ?? null,
    hung: isHung(f.patch),
    invertPan: o?.invertPan ?? false,
    invertTilt: o?.invertTilt ?? false,
    swapPanTilt: o?.swapPanTilt ?? false,
  };
  const aiming = { yaw: yawOf(o), panOffset: o?.panOffset ?? 0, tiltOffset: o?.tiltOffset ?? 0, panMax: f.panMax ?? null, tiltMax: f.tiltMax ?? null };
  const stops = { pan: o?.limits?.pan ?? null, tilt: o?.limits?.tilt ?? null };
  return `${hash(geometry)}.${hash(aiming)}.${hash(stops)}`;
}

/**
 * The single fingerprint bases were saved with before they had parts (`geometry` and `aiming` in one, no stops): a
 * stored basis without parts is compared with it, as it was.
 */
export function legacyBasisOf(f: BasisSource): string {
  const o = f.patch.orientation;
  return hash({
    model: [f.patch.manufacturer, f.patch.model],
    position: f.patch.position ?? null,
    hung: isHung(f.patch),
    yaw: yawOf(o),
    invertPan: o?.invertPan ?? false,
    invertTilt: o?.invertTilt ?? false,
    swapPanTilt: o?.swapPanTilt ?? false,
    panOffset: o?.panOffset ?? 0,
    tiltOffset: o?.tiltOffset ?? 0,
    panMax: f.panMax ?? null,
    tiltMax: f.tiltMax ?? null,
  });
}

/** A covered head as it is now, what `positionStale` judges it on: undefined when it is no longer patched. */
export interface HeadNow {
  /** `basisOf` now. */
  basis: string;
  /** `legacyBasisOf` now, for a basis saved before the parts. */
  legacy: string;
  /** Whether a stored pan/tilt reaches beyond its useful stops now (venue/stops-check.ts `beyondStops`). */
  beyondStops: (p: { pan: number; tilt: number }) => boolean;
}

/** The heads a position covers: those of its pan/tilt; a point covers none by itself (every placed head aims at it). */
export const coveredHeads = (p: Pick<PositionPreset, "values">): string[] => Object.keys(p.values);

/** The covered heads whose pan/tilt come from the position's `aim` (recomputable from it): none without an aim. */
export const aimedHeads = (p: Pick<PositionPreset, "values" | "aim" | "aimed">): string[] => (p.aim ? (p.aimed ?? coveredHeads(p)).filter((h) => Object.hasOwn(p.values, h)) : []);

/**
 * The covered heads whose stored pan/tilt may no longer place them as meant (decision Q4, refined on 2026-11-15):
 * - moved, rehung, inverted, swapped, given another definition (the `geometry` part changed): every head;
 * - turned or recalibrated, its travel corrected (the `aiming` part): only the heads aimed at a point (`aimedHeads`),
 *   whose pan/tilt no longer point there; a pan/tilt set at the pad keeps its bytes and stays fresh;
 * - given new useful stops (the `stops` part), or a correction of the `aiming` part, that leaves its stored pan/tilt
 *   beyond its stops: it would be clipped at the output (a pad position already beyond a stop is stale at the first
 *   correction of the calibration, the travel or the stops).
 * A basis saved before the parts is compared whole (`legacyBasisOf`), and is stale beyond the stops as well (they are
 * not in it). `now` gives a head as it is now, undefined when
 * it is no longer patched (said apart, not stale). A head saved without a basis cannot be judged: never stale. A 3D
 * point is never stale (it has no basis). Computed on demand (list, « Vérifier le show »), never per frame.
 */
export function positionStale(p: Pick<PositionPreset, "values" | "basis" | "aim" | "aimed">, now: (fixture: string) => HeadNow | undefined): string[] {
  const aimed = new Set(aimedHeads(p));
  // a point has no values: nothing covered, never stale
  return coveredHeads(p).filter((head) => {
    const saved = p.basis[head];
    const cur = now(head);
    if (saved === undefined || cur === undefined || saved === cur.basis) return false;
    const parts = saved.split(".");
    if (parts.length !== 3) return saved !== cur.legacy || cur.beyondStops(p.values[head]!);
    const [geometry, aiming, stops] = cur.basis.split(".");
    if (parts[0] !== geometry) return true;
    if (parts[1] !== aiming && aimed.has(head)) return true;
    return (parts[1] !== aiming || parts[2] !== stops) && cur.beyondStops(p.values[head]!);
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
