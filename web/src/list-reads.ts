/** A dashboard page reads its lists (looks, groups, faders…) again and again: only the latest read of a list is applied. Pure. */

/** The lists a dashboard reads; each can be read again while an older read is still on its way. */
const READ_LISTS = ["looks", "groups", "faders", "snapshots", "folders"] as const;
export type ReadList = (typeof READ_LISTS)[number];

/** Waits `ms`, then runs `fn`; gives back what cancels it. Injectable: the tests run the clock by hand. */
export type Later = (fn: () => void, ms: number) => () => void;
const laterByTimer: Later = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/** How a failed read is told and tried again; the clock is injectable. */
export interface ReadRetry {
  /** Where the failures go (`failuresTogether`): a read drops its list's failure still waiting, and fails twice there. */
  failures: Pick<FailuresTogether, "fail" | "drop">;
  /** The wait before the second try (ms). */
  delayMs?: number;
  later?: Later;
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
 * retries or says its own failure, so the list never stays unread because of it). A read starting drops the failure
 * of its list still waiting to be said: this read decides.
 */
export function latestRead<T>(counters: Record<ReadList, number>, list: ReadList, read: () => Promise<T>, apply: (v: T) => void, retry: ReadRetry): void {
  const stamp = ++counters[list];
  const { failures, delayMs = RETRY_MS, later = laterByTimer } = retry;
  failures.drop(list);
  const current = () => stamp === counters[list];
  const attempt = (left: number) =>
    void read().then(
      (v) => current() && apply(v),
      (e: unknown) => {
        if (!current()) return;
        if (left > 0) later(() => current() && attempt(left - 1), delayMs);
        else failures.fail(list, e instanceof Error ? e.message : String(e));
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

/** The failures of one refresh, said together. */
export interface FailuresTogether {
  /** `list` failed (twice): said with the others that fail within the wait. */
  fail(list: ReadList, message: string): void;
  /** `list` is read again: its failure still waiting is not said (the new read decides). */
  drop(list: ReadList): void;
  /** The page leaves: nothing waiting is said. */
  cancel(): void;
}
/**
 * The reads of one refresh fail one by one: their failures wait `delayMs` for each other (the wait starts again at
 * each), then `say` gets them all at once, so the alert changes, and is announced, once.
 */
export function failuresTogether(say: (failures: [ReadList, string][]) => void, { delayMs, later = laterByTimer }: { delayMs: number; later?: Later }): FailuresTogether {
  let waiting: [ReadList, string][] = [];
  let stop: (() => void) | undefined;
  const flush = () => {
    const failures = waiting;
    waiting = [];
    if (failures.length) say(failures);
  };
  return {
    fail(list, message) {
      waiting.push([list, message]);
      stop?.();
      stop = later(flush, delayMs);
    },
    drop(list) {
      waiting = waiting.filter(([l]) => l !== list);
    },
    cancel() {
      stop?.(); // only frees the timer: with nothing waiting, it would say nothing
      waiting = []; // a failure after a cancel does not bring the old ones back
    },
  };
}
