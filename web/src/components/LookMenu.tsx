import { useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useFloatingMenu } from "./menu";
import { LookPeek } from "./LookPeek";
import { confirmDelete } from "./confirmDelete";
import type { LookDraft } from "./LookEditor";

/**
 * Right-click (or a long press) on a look of the Show page: edit it, start or stop it, duplicate or
 * delete it, and its preview, as from its button on the Live.
 */
export function LookMenu({ look, at, onEdit, onChanged, onClose }: { look: { id: string; name: string; active: boolean }; at: { x: number; y: number }; onEdit: (draft: LookDraft) => void; onChanged: () => void; onClose: () => void }) {
  const t = useT();
  const { box, style } = useFloatingMenu(at, onClose);
  const [wide, setWide] = useState(false);
  const [error, setError] = useState("");
  const open = (copy: boolean) =>
    void cmd<LookDraft>("look.get", { id: look.id }).then(
      (full) => (onClose(), onEdit(copy ? { ...full, id: "", name: `${full.name} (${t.copySuffix})` } : full)),
      (e: Error) => setError(e.message),
    );
  const act = (p: Promise<unknown>) => void p.then(onChanged, (e: Error) => setError(e.message));
  return (
    <div ref={box} className={wide ? "widget-menu wide" : "widget-menu"} role="dialog" aria-label={t.lookMenu} style={style} onContextMenu={(e) => e.preventDefault()}>
      <h3>{look.name}</h3>
      <div className="row">
        <button className="primary" onClick={() => open(false)}>
          ✎ {t.edit}
        </button>
        <button onClick={() => act(cmd(look.active ? "look.stop" : "look.go", { id: look.id }))}>{look.active ? `■ ${t.stop}` : `▶ ${t.launch}`}</button>
        <button onClick={() => open(true)}>⧉ {t.duplicate}</button>
      </div>
      <LookPeek id={look.id} onStage={setWide} />
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="danger" onClick={() => void confirmDelete("look", look.id, look.name, t).then((done) => done && (onClose(), onChanged()), (e: Error) => setError(e.message))}>
          {t.delete}
        </button>
        <span className="grow" />
        <button onClick={onClose}>{t.close}</button>
      </div>
    </div>
  );
}
