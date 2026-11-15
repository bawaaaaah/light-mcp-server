/**
 * What each moving head of a target (T24) is doing, read from the motion layer's report (position.list and
 * light:motion, docs/specs/engine-effects-timing.md, « Couche Mouvement »): the target pad's status line. Pure: the
 * heads' reports in, one state per head out, then grouped for the sentence.
 */
import type { HeadMotionEntry } from "../../src/plugins/light/show/motion-report.js";

export type TargetHeadState =
  /** The target holds the head and places it. */
  | "follows"
  /** The target holds it but cannot place it (out of reach, a no-aim zone, no stage position): it stays where it is. */
  | "held"
  /** Taken back by hand (the XY pad, the manual layer). */
  | "manual"
  /** « Rendre la main » released the target on this head: it goes back to what claims it below until engaged again. */
  | "released"
  /** Frozen hard (T26): it ignores the target until unfrozen (decision T-b: the target still moves). */
  | "frozen"
  /** Something else stronger holds it: a soft lock, another target engaged later. */
  | "masked"
  /** The target is not engaged. */
  | "idle"
  /** No frame reported yet. */
  | "waiting";

export interface TargetHead {
  id: string;
  name: string;
  state: TargetHeadState;
  /** Why a held head holds (the server's words). */
  reason?: string;
}

type Head = Pick<HeadMotionEntry, "id" | "motion"> & { name?: string };

/** The state of each head of target `id`, in the order given. */
export function targetHeads(heads: readonly Head[], id: string, engaged: boolean): TargetHead[] {
  const owner = `target:${id}`;
  return heads.map((h) => {
    const base = { id: h.id, name: h.name ?? h.id };
    const m = h.motion;
    if (m?.lock === "hard") return { ...base, state: "frozen" };
    if (!engaged) return { ...base, state: "idle" };
    if (!m) return { ...base, state: "waiting" };
    const mine = [m.pan, m.tilt].find((a) => a.owner === owner);
    if (mine) return mine.error ? { ...base, state: "held", reason: mine.error } : { ...base, state: "follows" };
    if (m.pan.layer === "manual" || m.tilt.layer === "manual") return { ...base, state: "manual" };
    if (m.released.some((r) => r.owner === owner)) return { ...base, state: "released" };
    return { ...base, state: "masked" };
  });
}

/** One part of the status line: a state, the heads in it, and for a held head its reason (one part per reason). */
export interface TargetPart {
  state: TargetHeadState;
  reason?: string;
  names: string[];
}

/** The order the line says them in: what follows first, then what does not, and why. */
const ORDER: readonly TargetHeadState[] = ["follows", "held", "manual", "released", "masked", "frozen", "waiting", "idle"];

/** The heads grouped by state (and by reason for the held ones), in the line's order; empty groups left out. */
export function targetParts(heads: readonly TargetHead[]): TargetPart[] {
  const parts: TargetPart[] = [];
  for (const state of ORDER) {
    for (const h of heads.filter((x) => x.state === state)) {
      const part = parts.find((p) => p.state === state && p.reason === h.reason);
      if (part) part.names.push(h.name);
      else parts.push({ state, ...(h.reason === undefined ? {} : { reason: h.reason }), names: [h.name] });
    }
  }
  return parts;
}

/** Metres to the centimetre, with the interface's decimal mark (« 1,5 »). */
export function metresText(v: number, decimalMark: string): string {
  return String(Math.round(v * 100) / 100).replace(".", decimalMark);
}
