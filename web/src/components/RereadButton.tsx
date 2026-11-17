import { useEffect, useRef, useState, type FocusEvent, type ReactElement } from "react";
import { useT } from "../i18n-context";

const clock = (d: Date): string => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");

/**
 * « Relire »: reads a list (or the Live's lists) that could not be read again. While that read is under way it is
 * busy and does nothing more (`aria-disabled`, never `disabled`: the focus stays on it); a press whose read fails again
 * says so beside it, with the time (« Relu à 21:04:12, toujours illisible »), announced without the whole alert again.
 * The time is injectable (`now`).
 */
export function RereadButton({ busy, failing, onRetry, onFocus, onBlur, now = () => new Date() }: {
  /** A read is under way. */
  busy: boolean;
  /** What it reads again is still not read. */
  failing: boolean;
  onRetry: () => void;
  onFocus?: (e: FocusEvent<HTMLButtonElement>) => void;
  onBlur?: (e: FocusEvent<HTMLButtonElement>) => void;
  now?: () => Date;
}): ReactElement {
  const t = useT();
  /** Pressed, and its read not over yet. */
  const pressed = useRef(false);
  const wasBusy = useRef(busy);
  const [still, setStill] = useState("");
  useEffect(() => {
    if (wasBusy.current && !busy && pressed.current) {
      pressed.current = false;
      if (failing) setStill(t.rereadStill.replace("{time}", () => clock(now())));
    }
    wasBusy.current = busy;
  }, [busy, failing, t, now]);
  return (
    <>
      <button
        type="button"
        className="reread"
        aria-disabled={busy}
        aria-busy={busy}
        onFocus={onFocus}
        onBlur={onBlur}
        onClick={() => {
          if (busy) return;
          pressed.current = true;
          setStill("");
          onRetry();
        }}
      >
        {t.readAgain}
      </button>
      <span className="reread-still" aria-live="polite">
        {still}
      </span>
    </>
  );
}
