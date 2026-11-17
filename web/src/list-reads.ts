/** A dashboard page reads its lists (looks, groups, faders…) again and again: only the latest read of a list is applied. Pure. */

/** The lists a dashboard reads; each can be read again while an older read is still on its way. */
export type ReadList = "looks" | "groups" | "faders" | "snapshots" | "folders";

/**
 * Applies a read's answer only if no newer read of the same list started meanwhile: a late answer must not rewrite
 * the page with an older state (a fader thumb left at 20 % while the fader sits at 80 %). A failed read changes nothing.
 */
export function latestRead<T>(counters: Record<ReadList, number>, list: ReadList, request: Promise<T>, apply: (v: T) => void): void {
  const stamp = ++counters[list];
  void request.then((v) => stamp === counters[list] && apply(v)).catch(() => undefined);
}
