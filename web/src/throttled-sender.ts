/**
 * The send loop of a pad (XyPad, TargetPad; docs/specs/ui-dashboards.md): one write in flight, at most one every
 * `intervalMs`, the latest pending value only — a slow link never builds a queue behind the finger. Pure: the clock
 * and the timers are given, so the loop is tested without a browser (useThrottledSend wraps it for React).
 */

/** At most one write every 40 ms (25 a second) while a finger drags: the spec's pad rate (ui-dashboards.md). */
export const SEND_INTERVAL_MS = 40;

/** The time and the timers the loop runs on (performance.now and window.setTimeout in a page). */
export interface SenderClock<H = unknown> {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => H;
  clearTimer: (handle: H) => void;
}

export interface SenderOptions<T> {
  intervalMs?: number;
  /** Folds a new value into the one still pending (a target pad's x/y and its Z fader); default: the new one replaces it. */
  merge?: (pending: T, next: T) => T;
  /** After each write, failed or not. */
  onSettled?: () => void;
}

export interface ThrottledSender<T> {
  /** Queues `value`: it replaces (or, with `merge`, merges into) the pending one; never a queue behind the finger. */
  send: (value: T) => void;
  /** Drops the pending value; resolves once the write already on the wire (if any) has settled. */
  drop: () => Promise<void>;
  /** Nothing pending and nothing on the wire. */
  idle: () => boolean;
  /**
   * The pad goes away: the pending value goes out as soon as the wire is free, without waiting for the interval, and
   * no timer is set any more.
   */
  flush: () => void;
  /** Mounted again (React's strict mode mounts twice): the interval holds again. */
  resume: () => void;
}

export function createThrottledSender<T, H = unknown>(write: (value: T) => Promise<void>, clock: SenderClock<H>, options: SenderOptions<T> = {}): ThrottledSender<T> {
  const intervalMs = options.intervalMs ?? SEND_INTERVAL_MS;
  let pending: { value: T } | null = null;
  let inFlight: Promise<void> | null = null;
  let lastStart = -Infinity;
  let timer: { handle: H } | null = null;
  let gone = false;

  const stopTimer = (): void => {
    if (timer) clock.clearTimer(timer.handle);
    timer = null;
  };
  const pump = (): void => {
    if (inFlight || !pending) return;
    const wait = lastStart + intervalMs - clock.now();
    if (wait > 0 && !gone) {
      if (!timer)
        timer = {
          handle: clock.setTimer(() => {
            timer = null;
            pump();
          }, wait),
        };
      return;
    }
    stopTimer();
    const { value } = pending;
    pending = null;
    lastStart = clock.now();
    // the write starts now (an async call runs to its first await): its time is the one the interval counts from
    inFlight = (async () => write(value))()
      .catch(() => undefined) // the writer reports its own errors: the loop goes on
      .finally(() => {
        inFlight = null;
        options.onSettled?.();
        pump();
      });
  };

  return {
    send(value) {
      pending = { value: pending && options.merge ? options.merge(pending.value, value) : value };
      pump();
    },
    async drop() {
      pending = null;
      stopTimer();
      if (inFlight) await inFlight;
    },
    idle: () => !pending && !inFlight,
    flush() {
      gone = true;
      stopTimer();
      pump();
    },
    resume() {
      gone = false;
    },
  };
}
