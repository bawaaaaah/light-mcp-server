/**
 * What each moving head of a target (T24) is doing, read from the motion layer's report (position.list and
 * light:motion, docs/specs/engine-effects-timing.md, « Couche Mouvement »): the target pad's status line. Pure: the
 * heads' reports in, one state per head out, then grouped for the sentence.
 */
import type { AxisReport, HeadMotionEntry } from "../../src/plugins/light/show/motion-report.js";

export type TargetHeadState =
  /** The target holds the head and places it. */
  | "follows"
  /** The target holds it but cannot place it (out of reach, a no-aim zone, no stage position): it stays where it is. */
  | "held"
  /** Taken back by hand (the XY pad, the manual layer). */
  | "manual"
  /** « Rendre la main » released the target on this head: it goes back to what claims it below until engaged again. */
  | "released"
  /** Released, and nothing claims it below: it went back to its rest. */
  | "resting"
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
  /** Why a held head holds, in the screen's words. */
  reason?: string;
  /** What masks a masked head: the soft lock, another target's name. */
  by?: string;
}

type Head = Pick<HeadMotionEntry, "id" | "motion"> & { name?: string };

/** The words the states need from the screen (its language): a hold's reason, the soft lock. */
export interface StatusWords {
  /** Why an axis held for the target holds; default: the server's message. */
  reason?: (axis: AxisReport) => string;
  softLock?: string;
}

/**
 * The state of each head of target `id`, in the order given. Recomputed here rather than read from target.list: the
 * motion topic (light:motion) is pushed as it changes, target.list would have to be polled.
 */
export function targetHeads(heads: readonly Head[], id: string, engaged: boolean, words: StatusWords = {}): TargetHead[] {
  const owner = `target:${id}`;
  return heads.map((h) => {
    const base = { id: h.id, name: h.name ?? h.id };
    const m = h.motion;
    if (m?.lock === "hard") return { ...base, state: "frozen" };
    if (!engaged) return { ...base, state: "idle" };
    if (!m) return { ...base, state: "waiting" };
    // either axis the target holds but cannot place (a tilt alone out of reach) holds the head, as the server says
    const mine = [m.pan, m.tilt].filter((a) => a.owner === owner);
    const held = mine.find((a) => a.error !== undefined);
    if (held) return { ...base, state: "held", reason: words.reason ? words.reason(held) : held.error! };
    if (mine.length) return { ...base, state: "follows" };
    if (m.pan.layer === "manual" || m.tilt.layer === "manual") return { ...base, state: "manual" };
    if (m.released.some((r) => r.owner === owner)) return { ...base, state: m.pan.layer === "rest" && m.tilt.layer === "rest" ? "resting" : "released" };
    const by = m.pan.layer === "lock" || m.tilt.layer === "lock" ? (words.softLock ?? "soft lock") : (m.pan.name ?? m.tilt.name ?? m.pan.owner ?? m.tilt.owner ?? undefined);
    return { ...base, state: "masked", ...(by === undefined ? {} : { by }) };
  });
}

/** One part of the status line: a state, the heads in it, for a held head its reason, for a masked one what masks it. */
export interface TargetPart {
  state: TargetHeadState;
  reason?: string;
  by?: string;
  names: string[];
}

/**
 * The order the line says them in: « Non engagée » first (the target's own state), then what follows, then what does
 * not, and why.
 */
const ORDER: readonly TargetHeadState[] = ["idle", "follows", "held", "manual", "released", "resting", "masked", "frozen", "waiting"];

/**
 * The heads grouped by state (by reason for the held ones, by what masks them for the masked ones), in the line's
 * order; empty groups left out. Not engaged, « idle » counts every head, frozen ones included: « Non engagée · 3 lyres ·
 * 1 figée par le verrou ».
 */
export function targetParts(heads: readonly TargetHead[]): TargetPart[] {
  const parts: TargetPart[] = [];
  const idle = heads.some((h) => h.state === "idle");
  for (const state of ORDER) {
    const members = state === "idle" && idle ? heads : heads.filter((x) => x.state === state);
    for (const h of members) {
      const key: { reason?: string; by?: string } = state === "idle" ? {} : { ...(h.reason === undefined ? {} : { reason: h.reason }), ...(h.by === undefined ? {} : { by: h.by }) };
      const part = parts.find((p) => p.state === state && p.reason === key.reason && p.by === key.by);
      if (part) part.names.push(h.name);
      else parts.push({ state, ...key, names: [h.name] });
    }
  }
  return parts;
}

/** Metres to the centimetre, with the interface's decimal mark (« 1,5 »). */
export function metresText(v: number, decimalMark: string): string {
  return String(Math.round(v * 100) / 100).replace(".", decimalMark);
}
