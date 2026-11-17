/** A dashboard page reads its lists (looks, groups, faders…) again and again: only the latest read of a list is applied. Pure. */

/** The lists a dashboard reads; each can be read again while an older read is still on its way. */
export const READ_LISTS = ["looks", "groups", "faders", "snapshots", "folders"] as const;
export type ReadList = (typeof READ_LISTS)[number];

/** How a failed read is told and tried again; the clock is injectable. */
export interface ReadRetry {
  /** The read failed twice: said (the page's error bar). */
  onError: (e: Error) => void;
  /** The wait before the second try (ms). */
  delayMs?: number;
  later?: (fn: () => void, ms: number) => void;
}
export const RETRY_MS = 1000;

/** Every read under way is dropped (the page is leaving): nothing is applied, tried again or said after this. */
export function dropReads(counters: Record<ReadList, number>): void {
  for (const list of READ_LISTS) counters[list]++;
}

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

/** Where a list's reading stands: a read under way, and the failure said for it (closed by ✕ or not). */
export interface ReadState {
  reading: boolean;
  failure?: { message: string; dismissed: boolean };
}
export type ReadStates = Partial<Record<ReadList, ReadState>>;

/** A read of `list` starts: its failure, if any, stays said until it is read. */
export const started = (s: ReadStates, list: ReadList): ReadStates => (s[list]?.reading ? s : { ...s, [list]: { ...s[list], reading: true } });
/** `list` read: no read under way, no failure. The other lists keep theirs. */
export const cleared = (s: ReadStates, list: ReadList): ReadStates => (s[list] ? { ...s, [list]: undefined } : s);
/**
 * `list` could not be read. A failure closed by ✕ comes back only if it changes: the same failure again (each press
 * on a look reads the lists again while the server is away) stays closed.
 */
export function failed(s: ReadStates, list: ReadList, message: string): ReadStates {
  const before = s[list]?.failure;
  return { ...s, [list]: { reading: false, failure: { message, dismissed: before?.message === message && before.dismissed } } };
}
/** ✕: the failures said for `lists` are closed. */
export function dismissed(s: ReadStates, lists: readonly ReadList[]): ReadStates {
  const next = { ...s };
  for (const list of lists) {
    const state = s[list];
    if (state?.failure) next[list] = { ...state, failure: { ...state.failure, dismissed: true } };
  }
  return next;
}
/** The failures to say, one line per message, its lists in their order: a server away says it once for all of them. */
export function alertLines(s: ReadStates): { lists: ReadList[]; message: string }[] {
  const lines: { lists: ReadList[]; message: string }[] = [];
  for (const list of READ_LISTS) {
    const failure = s[list]?.failure;
    if (!failure || failure.dismissed) continue;
    const line = lines.find((l) => l.message === failure.message);
    if (line) line.lists.push(list);
    else lines.push({ lists: [list], message: failure.message });
  }
  return lines;
}
/** A message ending its sentence once: the server's own may already end with a point. */
export const sentence = (message: string): string => `${message.replace(/[\s.]+$/, "")}.`;
