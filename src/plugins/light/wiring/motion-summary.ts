/** What « Figer les lyres » (T26) holds, as the state, the MIDI feedback and light://live say it. */
import type { LockLevel } from "../engine/motion.js";
import { argText } from "../midi/mapping.js";
import { stricter, type MotionLockState } from "../show/motion-lock.js";
import type { ShowRuntime } from "../show/runtime.js";
import type { Venue } from "../venue/venue.js";

/**
 * Whether a « Figer les lyres » mapping's target is frozen (T26), from the lock itself whoever froze it (the
 * interface, a snapshot, the Panic): every head, a group or fixtures — all their installed moving heads (one head
 * frozen hard on its own leaves the mapping off: its next press freezes the others, decision V1). Its LED says it,
 * and its next press (latch, toggle) does the opposite of what the lock is now.
 */
export function frozenFor(runtime: ShowRuntime, args: Record<string, unknown>): boolean {
  const heads = runtime.movingHeads();
  const group = argText(args.group);
  const listed = Array.isArray(args.fixtures) ? args.fixtures.map(argText) : undefined;
  const inScope = listed ?? (group ? [...runtime.fixturesOf(group)] : undefined);
  const scoped = inScope ? inScope.filter((id) => heads.includes(id)) : heads;
  return scoped.length > 0 && scoped.every((head) => runtime.motionLock(head) !== "off");
}

/**
 * How many moving heads are installed, how many of them a lock holds and how many it holds hard (their effective
 * level, T26): the top bar says the global level and « · 1 en dur » for heads frozen harder on their own.
 */
export function movingHeadsSummary(runtime: ShowRuntime | undefined): { total: number; frozen: number; hard: number } {
  if (!runtime) return { total: 0, frozen: 0, hard: 0 };
  const levels = runtime.movingHeads().map((head) => runtime.motionLock(head));
  return { total: levels.length, frozen: levels.filter((l) => l !== "off").length, hard: levels.filter((l) => l === "hard").length };
}

export type MotionLockSummary = MotionLockState & { effective: LockLevel };

/** The lock levels, and the strictest effective level over the installed moving heads (off without a head). */
export function motionLockSummary(runtime: ShowRuntime | undefined): MotionLockSummary {
  if (!runtime) return { level: "off", heads: {}, effective: "off" };
  const lock = runtime.motionLockState();
  const effective = runtime.movingHeads().reduce<LockLevel>((acc, head) => stricter(acc, runtime.motionLock(head)), "off");
  return { ...lock, effective };
}

/** « Figer les lyres » in light://live: a forgotten lock reads as « my heads no longer move » (T26). */
export function liveLockLine(runtime: ShowRuntime, venue: Venue): string {
  const { level, heads, effective } = motionLockSummary(runtime);
  if (effective === "off") return "";
  const named = (lv: "soft" | "hard") =>
    Object.entries(heads)
      .filter(([, l]) => l === lv)
      .map(([id]) => venue.fixtures.get(id)?.name ?? id);
  const parts = [level !== "off" ? `toutes ${level === "hard" ? "en dur (pad compris)" : "en souple (le pad reste libre)"}` : "", named("hard").length ? `en dur : ${named("hard").join(", ")}` : "", named("soft").length ? `en souple : ${named("soft").join(", ")}` : ""].filter(Boolean);
  return `Lyres FIGÉES (${parts.join(" ; ")}) : les looks ne les déplacent plus ; motion.unfreeze les rend.`;
}
