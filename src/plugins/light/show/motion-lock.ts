/**
 * « Figer les lyres » (T26; docs/specs/engine-effects-timing.md, « Couche Mouvement », Verrou): what is locked and
 * where each locked head was frozen. Two levels: **soft** (looks and targets no longer move the heads, the pad still
 * does) and **hard** (nothing of the motion layer moves them, the pad included; the DMX console still does, decision
 * Q4 of 2026-11-11). One mechanism for every scope: each head's effective level is the stricter of the global lock and
 * its own; a group is expanded into its heads when it is locked, there is no « locked group » state.
 *
 * Pure: the schemas and the level of a head. The runtime (show/runtime.ts) plugs `lockOf` into the motion layer.
 */
import { z } from "zod";
import { RestPositionSchema, type Position } from "../engine/move.js";
import type { LockLevel } from "../engine/motion.js";

/** A head's own lock: absent from `heads` = free (the global lock still applies). */
export const HeadLockSchema = z.enum(["soft", "hard"]);
export type HeadLock = z.infer<typeof HeadLockSchema>;

/** What a snapshot records of the lock (decision Q3: recalled, it puts back exactly this lock). No `held`: positions are the live state's. */
export const MotionLockStateSchema = z.object({
  /** The global lock, over every moving head. */
  level: z.enum(["off", "soft", "hard"]).default("off"),
  /** Per fixture id: a head locked on its own (a group is expanded into its heads when it is locked). */
  heads: z.record(z.string(), HeadLockSchema).default({}),
});
export type MotionLockState = z.infer<typeof MotionLockStateSchema>;

/**
 * The show setting `motionLock` (show.json): the lock survives a restart and a crash, and `held` says where each
 * locked head was frozen (logical pan/tilt), so a restart under a lock sends it back there, not to the centre.
 * Absent: nothing is locked.
 */
export const MotionLockSchema = MotionLockStateSchema.extend({
  held: z.record(z.string(), RestPositionSchema).default({}),
});
export type MotionLock = z.infer<typeof MotionLockSchema>;

const STRENGTH: Record<LockLevel, number> = { off: 0, soft: 1, hard: 2 };

/** The stricter of two levels. */
export const stricter = <L extends LockLevel>(a: L, b: L): L => (STRENGTH[b] > STRENGTH[a] ? b : a);

/** The effective level of a head: the stricter of the global lock and its own. No lock (undefined): off. */
export function lockOf(lock: MotionLockState | undefined, head: string): LockLevel {
  if (!lock) return "off";
  const own = Object.hasOwn(lock.heads, head) ? lock.heads[head] : undefined;
  return own ? stricter(lock.level, own) : lock.level;
}

/** The part of the lock a snapshot records: the levels, never `held`. */
export const lockState = (lock: MotionLockState | undefined): MotionLockState => ({ level: lock?.level ?? "off", heads: { ...(lock?.heads ?? {}) } });

/** Whether two locks have the same levels, global and per head. */
export function sameLock(a: MotionLockState, b: MotionLockState): boolean {
  const ka = Object.keys(a.heads);
  return a.level === b.level && ka.length === Object.keys(b.heads).length && ka.every((h) => Object.hasOwn(b.heads, h) && b.heads[h] === a.heads[h]);
}

/**
 * `current` hardened by `incoming`, never loosened (decisions D1 and D2 of 2026-11-14: the Panic's safe snapshot and
 * the startup snapshot can only freeze or harden): the stricter global level, and per head the stricter of both; a
 * head locked now stays in `heads`.
 */
export function hardenLock(current: MotionLockState, incoming: MotionLockState): MotionLockState {
  const heads = new Map<string, HeadLock>(Object.entries(current.heads));
  for (const [head, level] of Object.entries(incoming.heads)) {
    const own = heads.get(head);
    heads.set(head, own ? stricter(own, level) : level);
  }
  return { level: stricter(current.level, incoming.level), heads: Object.fromEntries(heads) };
}

/** `held` as a map, from the setting. */
export const heldOf = (lock: MotionLock | undefined): Map<string, Position> =>
  new Map(Object.entries(lock?.held ?? {}).map(([id, p]) => [id, { pan: p.pan, tilt: p.tilt }]));
