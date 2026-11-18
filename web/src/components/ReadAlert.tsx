import type { FocusEvent, ReactElement } from "react";
import { useT } from "../i18n-context";
import { RereadButton, RereadStill, useReread } from "./RereadButton";

/**
 * The Live's lists that could not be read, in the bar: one alert, a line per message, how to read them again, its own
 * « Relire » (every role: the menus and the edit mode are not everyone's) and ✕. Mounted only while there is something
 * to say: what « Relire » said goes with it (a later failure starts afresh).
 */
export function ReadAlert({ lines, busy, onRetry, onClose, onFocus, onBlur }: {
  lines: { key: string; text: string }[];
  /** A read of a list it names is under way. */
  busy: boolean;
  onRetry: () => void;
  onClose: () => void;
  onFocus: () => void;
  onBlur: (e: FocusEvent<HTMLSpanElement>) => void;
}): ReactElement {
  const t = useT();
  const reread = useReread(busy, onRetry);
  return (
    <span className="error read-error" role="alert" onFocus={onFocus} onBlur={onBlur}>
      <span className="read-error-lines">
        {lines.map((line) => (
          <span key={line.key}>{line.text}</span>
        ))}
        <span>{t.readFailedHow}</span>
      </span>
      <RereadButton reread={reread} />
      <button className="ghost" aria-label={t.close} title={t.close} onClick={onClose}>
        ✕
      </button>
      {/* a renewed failure: under the lines, the whole width */}
      <RereadStill reread={reread} />
    </span>
  );
}
