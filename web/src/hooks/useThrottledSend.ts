import { useCallback, useEffect, useRef } from "react";

/** At most one write every 40 ms (25 a second) while a finger drags: the spec's pad rate (ui-dashboards.md). */
export const SEND_INTERVAL_MS = 40;

export interface ThrottledSend<T> {
  /** Queues `value`: it replaces (or, with `merge`, merges into) the pending one; never a queue behind the finger. */
  send: (value: T) => void;
  /** Drops the pending value; resolves once the write already on the wire (if any) has settled. */
  drop: () => Promise<void>;
  /** Nothing pending and nothing on the wire. */
  idle: () => boolean;
}

/**
 * The send loop of a pad (XyPad, TargetPad): one write in flight, at most one every `intervalMs`, the latest pending
 * value only — a slow link never builds a queue behind the finger. `merge` folds a new value into the one still
 * pending (a target pad's x/y and its Z fader: the axes of both go out together). `onSettled` runs after each write,
 * failed or not. On unmount, the pending value still goes out once, without waiting for the interval.
 */
export function useThrottledSend<T>(write: (value: T) => Promise<void>, options: { intervalMs?: number; merge?: (pending: T, next: T) => T; onSettled?: () => void } = {}): ThrottledSend<T> {
  const { intervalMs = SEND_INTERVAL_MS } = options;
  const writeRef = useRef(write);
  writeRef.current = write;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const pending = useRef<{ value: T } | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const lastStart = useRef(-Infinity);
  const timer = useRef<number | undefined>(undefined);
  /** Unmounted: the pending value goes out as soon as the wire is free, no timer is set any more. */
  const gone = useRef(false);

  const pump = useCallback(
    (now = false) => {
      if (inFlight.current || !pending.current) return;
      const wait = lastStart.current + intervalMs - performance.now();
      if (wait > 0 && !now && !gone.current) {
        if (timer.current === undefined)
          timer.current = window.setTimeout(() => {
            timer.current = undefined;
            pump();
          }, wait);
        return;
      }
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = undefined;
      const { value } = pending.current;
      pending.current = null;
      lastStart.current = performance.now();
      inFlight.current = Promise.resolve()
        .then(() => writeRef.current(value))
        .catch(() => undefined) // the writer reports its own errors: the loop goes on
        .finally(() => {
          inFlight.current = null;
          optionsRef.current.onSettled?.();
          pump();
        });
    },
    [intervalMs],
  );

  const send = useCallback(
    (value: T) => {
      const merge = optionsRef.current.merge;
      pending.current = { value: pending.current && merge ? merge(pending.current.value, value) : value };
      pump();
    },
    [pump],
  );
  const drop = useCallback(async () => {
    pending.current = null;
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
    const writing = inFlight.current;
    if (writing) await writing;
  }, []);
  const idle = useCallback(() => !pending.current && !inFlight.current, []);
  // the last point of a gesture still goes out when the pad goes away; no timer stays behind
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = undefined;
      pump(true);
    };
  }, [pump]);
  return { send, drop, idle };
}
