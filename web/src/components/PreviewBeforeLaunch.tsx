import { useEffect, useRef, useState, type ReactElement } from "react";
import { useT } from "../App";
import { LookPeek } from "./LookPeek";
import { armGhostGuard } from "../ghost-guard";
import { guardPassed, SHEET_GUARD_MS } from "../preview-first";
import { Modal } from "./Modal";

/**
 * The choice before a look goes on stage (docs/specs/ui-dashboards.md, « Aperçu avant lancement »): its
 * animated preview, then Cancel or Launch. Cancel comes first in the page, so it takes the focus: a
 * stray press starts nothing. Launch stays available while the preview loads, or if it cannot: a broken
 * preview must not make a look impossible to start. The caller closes the sheet and starts the look.
 */
export function PreviewBeforeLaunch({ lookId, name, danger, manualOnly, onCancel, onLaunch }: { lookId: string; name: string; danger?: boolean; manualOnly?: boolean; onCancel: () => void; onLaunch: () => void }): ReactElement {
  const t = useT();
  const openedAt = useRef(performance.now());
  // Launch is greyed during the guard, so that a press ignored is a press seen to be
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), SHEET_GUARD_MS + 25);
    return () => window.clearTimeout(timer);
  }, []);
  // the sheet closing at a press: the echo of that press (a double tap) must not reach what is under it
  useEffect(() => {
    let last: { x: number; y: number; at: number } | null = null;
    const record = (e: PointerEvent) => void (last = { x: e.clientX, y: e.clientY, at: performance.now() });
    window.addEventListener("pointerdown", record, true);
    return () => {
      window.removeEventListener("pointerdown", record, true);
      if (last && performance.now() - last.at < 1000) armGhostGuard(last);
    };
  }, []);
  return (
    <Modal label={`${t.previewBeforeLaunch}${t.colon} ${name}`} className="sheet" onClose={onCancel}>
      <h3 className="sheet-name">
        {manualOnly && <span className="mark">✋</span>}
        {name}
        {danger && <small className="danger-mark"> · {t.flagNames.danger}</small>}
      </h3>
      <LookPeek id={lookId} compact />
      <div className="sheet-actions">
        <button onClick={onCancel}>{t.cancel}</button>
        <button className="primary" disabled={!ready} onClick={() => guardPassed(performance.now(), openedAt.current) && onLaunch()}>
          {t.launch}
        </button>
      </div>
    </Modal>
  );
}
