import { useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useFloatingMenu } from "./menu";
import { LookPeek } from "./LookPeek";
import { withFolder } from "../folder";
import { confirmDelete } from "./confirmDelete";
import type { LookDraft } from "./LookEditor";

/**
 * Right-click (or a long press) on a look of the Show page: edit it, start or stop it, move it to
 * another folder, duplicate or delete it, and its preview, as from its button on the Live.
 */
export function LookMenu({ look, folder, folders, at, onEdit, onChanged, onClose }: { look: { id: string; name: string; active: boolean }; folder?: string; folders: string[]; at: { x: number; y: number }; onEdit: (draft: LookDraft) => void; onChanged: () => void; onClose: () => void }) {
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
  /** A change of folder reads the whole look first (a partial one is refused by look.put), then writes it back; on failure the menu stays open. */
  const setFolder = (name: string) => act(cmd<LookDraft>("look.get", { id: look.id }).then((full) => cmd("look.put", { look: { ...full, tags: withFolder(full.tags, name || undefined) } })));
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
      <label className="field">
        <span>{t.folder}</span>
        <select value={folder ?? ""} onChange={(e) => setFolder(e.target.value)}>
          <option value="">{t.noFolder}</option>
          {folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
          {/* the current folder may have vanished from the list while the menu is open */}
          {folder && !folders.includes(folder) && <option value={folder}>{folder}</option>}
        </select>
      </label>
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
