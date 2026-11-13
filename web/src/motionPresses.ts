/**
 * How many « Rendre la main » presses still change something on a pad (docs/specs/engine-effects-timing.md, « Couche
 * Mouvement »). Pure: it replays the server's rule (engine/motion.ts, `releaseMotion` with scope "top") on the layer
 * stacks of the report, so the pad never counts a lock, a claim a lock protects, or a head another press leaves alone.
 */
import type { AxisLayer } from "../../src/plugins/light/engine/motion.js";

/** What the count needs of an axis: its stack, strongest first, rest last, and the claim key of each entry ("" for lock, hold and rest). */
type PressAxis = { layer: AxisLayer; layers?: AxisLayer[]; claims?: string[] };
/** What the count needs of a head: the stack of each axis (`AxisReport.layers` and `AxisReport.claims`). */
export type PressHead = { motion: { pan: PressAxis; tilt: PressAxis } | null };

/** Strength of a top that a press may release; a lock is never released and is set aside. */
const RANK: Record<Exclude<AxisLayer, "lock">, number> = { manual: 1, target: 3, look: 4, hold: 5, rest: 6 };

type Entry = { layer: AxisLayer; key: string };

const stackOf = (axis: PressAxis): Entry[] => {
  const layers = axis.layers ?? [axis.layer, "rest"];
  // Without keys (an older report) each entry is its own claim: the count is then per axis.
  return layers.map((layer, i) => ({ layer, key: axis.claims?.[i] ?? "" }));
};

/**
 * On each press, among the axes whose top is not a lock, the strongest layer present goes on every axis where it is the
 * top; a soft lock under a manual claim counts that manual claim only (its stack is ["manual", "lock", …]), a hard lock
 * nothing. As on the server, a released claim leaves both axes of its head at once: a look on top of pan and under
 * another look on tilt goes from both stacks with one press. Counts presses until every axis is at rest or under a lock.
 */
export function pressesLeft(heads: readonly PressHead[]): number {
  const stacks: [Entry[], Entry[]][] = [];
  for (const head of heads) if (head.motion) stacks.push([stackOf(head.motion.pan), stackOf(head.motion.tilt)]);
  const topRank = (stack: readonly Entry[]): number | undefined => {
    const top = stack[0]?.layer ?? "rest";
    return top === "lock" ? undefined : RANK[top];
  };
  let presses = 0;
  for (;;) {
    let strongest = RANK.rest;
    for (const head of stacks) for (const stack of head) strongest = Math.min(strongest, topRank(stack) ?? RANK.rest);
    if (strongest === RANK.rest) return presses;
    for (const head of stacks) {
      const released = new Set<string>();
      for (const stack of head) {
        if (topRank(stack) !== strongest) continue;
        const top = stack.shift()!;
        if (top.key) released.add(top.key);
      }
      if (released.size) for (const [i, stack] of head.entries()) head[i] = stack.filter((entry) => !released.has(entry.key));
    }
    presses += 1;
  }
}
