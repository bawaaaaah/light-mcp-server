import { useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useFloatingMenu } from "./menu";

/**
 * Right-click (or a long press) on a folder header of the Show list: rename it (its `dossier:` tag
 * is rewritten on every look, and an existing name merges the two) or disband it (its looks go back
 * « sans dossier », the looks themselves stay). Written through the folder commands.
 */
export function FolderMenu({ folder, at, onChanged, onClose }: { folder: string; at: { x: number; y: number }; onChanged: () => void; onClose: () => void }) {
  const t = useT();
  const { box, style } = useFloatingMenu(at, onClose);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(folder);
  const [error, setError] = useState("");
  const act = (p: Promise<unknown>) => void p.then(() => (onClose(), onChanged()), (e: Error) => setError(e.message));
  return (
    <div ref={box} className="widget-menu" role="dialog" aria-label={t.folder} style={style} onContextMenu={(e) => e.preventDefault()}>
      <h3>{folder}</h3>
      {!renaming ? (
        <div className="row">
          <button className="primary" onClick={() => setRenaming(true)}>
            {t.renameFolder}
          </button>
          <button className="danger" onClick={() => confirm(t.disbandFolderConfirm.replace("{name}", folder)) && act(cmd("show.folder.delete", { folder }))}>
            {t.disbandFolder}
          </button>
        </div>
      ) : (
        <div className="row">
          <label className="field">
            <span>{t.folder}</span>
            <input
              value={name}
              aria-label={t.renameFolder}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => name.trim() && e.key === "Enter" && void act(cmd("show.folder.rename", { from: folder, to: name.trim() }))}
            />
          </label>
          <button className="primary" disabled={!name.trim() || name.trim() === folder} aria-label={t.renameFolder} title={t.save} onClick={() => void act(cmd("show.folder.rename", { from: folder, to: name.trim() }))}>
            ✔
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <span className="grow" />
        <button onClick={onClose}>{t.close}</button>
      </div>
    </div>
  );
}
