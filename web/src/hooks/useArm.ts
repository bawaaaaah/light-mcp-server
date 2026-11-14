import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ARM_MS, CONFIRM_MIN_MS, confirms } from "../confirm.js";

/**
 * The two-press pattern: `press(key, payload)` arms `key` (and keeps `payload`, what the second press will act on: the
 * target as it was when armed), or, pressed again after `CONFIRM_MIN_MS`, returns the payload kept to fire. A press
 * too soon after arming changes nothing (it stays armed). `armed` is the key armed, for the button's look.
 */
export function useArm<P = undefined>(): { armed: string | null; press: (key: string, payload: P) => { payload: P } | null; disarm: () => void } {
  const [armed, setArmed] = useState<string | null>(null);
  const arm = useRef<{ key: string; at: number; payload: P } | null>(null);
  const timer = useRef(0);
  const disarm = useCallback(() => {
    window.clearTimeout(timer.current);
    arm.current = null;
    setArmed(null);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const press = useCallback(
    (key: string, payload: P): { payload: P } | null => {
      const now = performance.now();
      const current = arm.current;
      if (current && current.key === key && now - current.at < CONFIRM_MIN_MS) return null; // a double press: still armed
      if (current && confirms(current, key, now)) {
        disarm();
        return { payload: current.payload };
      }
      window.clearTimeout(timer.current);
      arm.current = { key, at: now, payload };
      setArmed(key);
      timer.current = window.setTimeout(disarm, ARM_MS);
      return null;
    },
    [disarm],
  );
  return { armed, press, disarm };
}

/**
 * A held Enter or Space repeats its key: the repeats must not press the button again (a confirmation armed by the first
 * would fire). Spread on a button that arms.
 */
export const noKeyRepeat = {
  onKeyDown: (e: KeyboardEvent): void => {
    if (e.repeat && (e.key === "Enter" || e.key === " ")) e.preventDefault();
  },
};
