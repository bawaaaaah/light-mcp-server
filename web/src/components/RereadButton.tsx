import { useEffect, useRef, useState, type FocusEvent, type ReactElement } from "react";
import { useT } from "../i18n-context";

const clock = (d: Date): string => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
const NOW = (): Date => new Date();

/** « Relire » and what it says, shared by its button and its message, which its owner places apart. */
export interface Reread {
  busy: boolean;
  press: () => void;
  /** « Relu à 21:04:12, toujours illisible. », or empty. */
  still: string;
}

/**
 * « Relire »: reads a list (or the Live's lists) that could not be read again. While a read is under way it is busy and
 * a press does nothing more; a press whose read fails again (the button still there once the read is over) is said with
 * the time, without the whole alert again. A read it did not start says nothing. Its owner mounts it with what it
 * says « illisible » (the alert, a picker's reason): a list read takes what it said away with it. The time is
 * injectable (`now`).
 */
export function useReread(busy: boolean, onRetry: () => void, now: () => Date = NOW): Reread {
  const t = useT();
  /** Pressed, and its read not over yet. */
  const pressed = useRef(false);
  const [still, setStill] = useState("");
  useEffect(() => {
    if (busy || !pressed.current) return;
    pressed.current = false;
    setStill(t.rereadStill.replace("{time}", () => clock(now())));
  }, [busy, t, now]);
  return {
    busy,
    still,
    press: () => {
      if (busy) return;
      pressed.current = true;
      setStill(""); // a read again: the last one's time is not said any more
      onRetry();
    },
  };
}

/** The button: `aria-disabled` and `aria-busy` while a read is under way, never `disabled` (the focus stays on it). */
export function RereadButton({ reread, onFocus, onBlur }: { reread: Reread; onFocus?: (e: FocusEvent<HTMLButtonElement>) => void; onBlur?: (e: FocusEvent<HTMLButtonElement>) => void }): ReactElement {
  const t = useT();
  return (
    <button type="button" className="reread" aria-disabled={reread.busy} aria-busy={reread.busy} onFocus={onFocus} onBlur={onBlur} onClick={reread.press}>
      {t.readAgain}
    </button>
  );
}

/** Its message: a live region there from the start (emptied by its content, never hidden), on a line of its own. */
export function RereadStill({ reread }: { reread: Reread }): ReactElement {
  return (
    <span className="reread-still" aria-live="polite">
      {reread.still}
    </span>
  );
}
