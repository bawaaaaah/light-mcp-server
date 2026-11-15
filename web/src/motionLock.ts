/**
 * « Figer les lyres » (T26, lot 4; docs/specs/rules-limits.md, « Verrou des lyres »): which commands a choice of the
 * button, the widget, the fixture menu or the group editor sends, and whether the role may. Pure: shared by every
 * control and tested without a browser. The server is the authority; this only spares a refusal (and its toast) and
 * tells why a choice is greyed.
 */

export type LockLevel = "off" | "soft" | "hard";

/** What the signed-in role may do with the lock: `freeze` (soft, commands:freeze), `position` (hard and loosening). */
export interface LockRights {
  freeze: boolean;
  position: boolean;
}

export type LockCall = { command: "motion.freeze"; args: { level: "soft" | "hard" } } | { command: "motion.unfreeze"; args: { to: "off" | "soft" } };

/**
 * A choice: the calls to send, in order (with `confirm` when they loosen a hard lock: someone may be up by a head, so a
 * second press is asked, the « armer » pattern of the look buttons), or why nothing is sent — `same` (already there),
 * or the right that is missing.
 */
export type LockPlan = { calls: LockCall[]; confirm: boolean } | { calls?: undefined; blocked: "same" | "freeze" | "position" };

const RANK: Record<LockLevel, number> = { off: 0, soft: 1, hard: 2 };

/** The stricter of two levels. */
export const stricter = (a: LockLevel, b: LockLevel): LockLevel => (RANK[a] >= RANK[b] ? a : b);
/** The looser of two levels. */
export const looser = (a: LockLevel, b: LockLevel): LockLevel => (RANK[a] <= RANK[b] ? a : b);

/**
 * What choosing `wanted` sends so that the whole target ends at that level, for a target whose loosest level is `base`
 * (the global level for the top bar; the head's own level for one head; the loosest own level of a group's heads) and
 * whose strictest is `top` (the effective level for the top bar, whose « Défiger » lifts everything: decision U2; the
 * strictest own level of a group's heads). `motion.unfreeze` only loosens and `motion.freeze` only hardens, as on the
 * server: going from « tout » on one head to « Figées » everywhere loosens to soft, then freezes soft.
 */
export function planLock(state: { base: LockLevel; top: LockLevel }, wanted: LockLevel, rights: LockRights): LockPlan {
  const calls: LockCall[] = [];
  let loosen = false;
  if (RANK[state.top] > RANK[wanted]) {
    if (rights.position) {
      loosen = true;
      calls.push({ command: "motion.unfreeze", args: { to: wanted === "soft" ? "soft" : "off" } });
    } else if (!(wanted === "soft" && RANK[state.base] < RANK.soft)) return { blocked: "position" };
    // decision V2: without commands:position, « Figées » freezes soft what is free and leaves the hard heads hard —
    // never blocked because something is frozen hard elsewhere
  }
  if (wanted !== "off" && RANK[state.base] < RANK[wanted]) {
    // freezing: soft is anyone with the Panic (commands:freeze), hard is the desk (commands:position) — decisions Q2 + Q6
    if (wanted === "hard" ? !rights.position : !rights.freeze) return { blocked: wanted === "hard" ? "position" : "freeze" };
    calls.push({ command: "motion.freeze", args: { level: wanted } });
  }
  return calls.length ? { calls, confirm: loosen && state.top === "hard" } : { blocked: "same" };
}

/**
 * One press of the button (decision Q1): free → frozen soft; frozen at any level → free. Decision V2: a role that may
 * not unfreeze (no commands:position) freezes soft what is still free when only some heads are frozen.
 */
export const tapTarget = (shown: LockLevel, someFree = false, mayLoosen = true): LockLevel => (shown === "off" || (someFree && !mayLoosen) ? "soft" : "off");

/**
 * One press of a control over every head (the top bar, a widget without group), decision W1: while some installed head
 * is free, it freezes soft (the global level: the free heads), never loosening a head already frozen and never asking
 * twice, for every role that may freeze; only once every head is frozen does it free everything (decision U2), asking
 * twice when anything is hard, for a role with commands:position.
 */
export function planGlobalPress(state: { base: LockLevel; top: LockLevel }, allFrozen: boolean, rights: LockRights): LockPlan {
  if (allFrozen) return planLock(state, "off", rights);
  if (!rights.freeze) return { blocked: "freeze" };
  return { calls: [{ command: "motion.freeze", args: { level: "soft" } }], confirm: false };
}

/** The levels of a group's heads: the loosest own level (what freezing hardens from) and the strictest (what loosening starts from). */
export function groupLevels(own: readonly LockLevel[]): { base: LockLevel; top: LockLevel } {
  if (!own.length) return { base: "off", top: "off" };
  return { base: own.reduce(looser), top: own.reduce(stricter) };
}
