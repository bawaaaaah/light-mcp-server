import { useEffect, useRef } from "react";
import { createThrottledSender, type SenderOptions, type ThrottledSender } from "../throttled-sender";

export { SEND_INTERVAL_MS, type ThrottledSender } from "../throttled-sender";

/**
 * A pad's send loop (throttled-sender.ts) for a component: one write in flight, at most one every 40 ms, the latest
 * pending value only. The writer and the options are read at each write (refs), so the loop outlives re-renders. On
 * unmount, the pending value still goes out once, without waiting for the interval.
 */
export function useThrottledSend<T>(write: (value: T) => Promise<void>, options: SenderOptions<T> = {}): ThrottledSender<T> {
  const writeRef = useRef(write);
  writeRef.current = write;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sender = useRef<ThrottledSender<T> | null>(null);
  sender.current ??= createThrottledSender<T, number>(
    (value) => writeRef.current(value),
    { now: () => performance.now(), setTimer: (fn, ms) => window.setTimeout(fn, ms), clearTimer: (h) => window.clearTimeout(h) },
    {
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      merge: (pending, next) => (optionsRef.current.merge ? optionsRef.current.merge(pending, next) : next),
      onSettled: () => optionsRef.current.onSettled?.(),
    },
  );
  // the last point of a gesture still goes out when the pad goes away; no timer stays behind
  useEffect(() => {
    sender.current?.resume();
    return () => sender.current?.flush();
  }, []);
  return sender.current;
}
