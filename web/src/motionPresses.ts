/**
 * How many « Rendre la main » presses still change something on a pad (docs/specs/engine-effects-timing.md, « Couche
 * Mouvement »). Pure: it replays the server's rule (engine/motion.ts, `releaseMotion` with scope "top") on the layer
 * stacks of the report, so the pad never counts a lock, a claim a lock protects, or a head another press leaves alone.
 */
import type { AxisLayer } from "../../src/plugins/light/engine/motion.js";

/** What the count needs of a head: the stack of each axis, strongest first, rest last (`AxisReport.layers`). */
export type PressHead = { motion: { pan: { layer: AxisLayer; layers?: AxisLayer[] }; tilt: { layer: AxisLayer; layers?: AxisLayer[] } } | null };

/** Strength of a top that a press may release; a lock is never released and is set aside. */
const RANK: Record<Exclude<AxisLayer, "lock">, number> = { manual: 1, target: 3, look: 4, hold: 5, rest: 6 };

/**
 * On each press, among the axes whose top is not a lock, the strongest layer present goes on every axis where it is the
 * top; a soft lock under a manual claim counts that manual claim only (its stack is ["manual", "lock", …]), a hard lock
 * nothing. Counts presses until every axis is at rest or under a lock.
 *
 * Known limit: the report gives layers, not claims. A look that is the top of one axis but sits under another look on
 * the other axis of the same head is released there too by the server; the count may then say one press too many.
 */
export function pressesLeft(heads: readonly PressHead[]): number {
  const stacks: AxisLayer[][] = [];
  for (const head of heads) {
    if (!head.motion) continue;
    for (const axis of [head.motion.pan, head.motion.tilt]) stacks.push([...(axis.layers ?? [axis.layer, "rest"])]);
  }
  const topRank = (stack: readonly AxisLayer[]): number | undefined => {
    const top = stack[0] ?? "rest";
    return top === "lock" ? undefined : RANK[top];
  };
  let presses = 0;
  for (;;) {
    let strongest = RANK.rest;
    for (const stack of stacks) strongest = Math.min(strongest, topRank(stack) ?? RANK.rest);
    if (strongest === RANK.rest) return presses;
    for (const stack of stacks) if (topRank(stack) === strongest) stack.shift();
    presses += 1;
  }
}
