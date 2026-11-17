/** A dashboard page reads its lists (looks, groups, faders…) again and again: only the latest read of a list is applied. Pure. */

/** The lists a dashboard reads; each can be read again while an older read is still on its way. */
export type ReadList = "looks" | "groups" | "faders" | "snapshots" | "folders";

/** How a failed read is told and tried again; the clock is injectable. */
export interface ReadRetry {
  /** The read failed twice: said (the page's error bar). */
  onError: (e: Error) => void;
  /** The wait before the second try (ms). */
  delayMs?: number;
  later?: (fn: () => void, ms: number) => void;
}
export const RETRY_MS = 1000;

/**
 * Applies a read's answer only if no newer read of the same list started meanwhile: a late answer must not rewrite
 * the page with an older state (a fader thumb left at 20 % while the fader sits at 80 %). A failed read is tried once
 * more after a short wait, then said; a read overtaken by a newer one is dropped, failed or not (the newer one applies,
 * retries or says its own failure, so the list never stays unread because of it).
 */
export function latestRead<T>(counters: Record<ReadList, number>, list: ReadList, read: () => Promise<T>, apply: (v: T) => void, retry: ReadRetry): void {
  const stamp = ++counters[list];
  const { onError, delayMs = RETRY_MS, later = (fn, ms) => void setTimeout(fn, ms) } = retry;
  const current = () => stamp === counters[list];
  const attempt = (left: number) =>
    void read().then(
      (v) => current() && apply(v),
      (e: unknown) => {
        if (!current()) return;
        if (left > 0) later(() => current() && attempt(left - 1), delayMs);
        else onError(e instanceof Error ? e : new Error(String(e)));
      },
    );
  attempt(1);
}
