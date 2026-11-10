import { useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useFloatingMenu } from "./menu";
import { folderLabel } from "../folder";

/**
 * Right-click (or a long press) on a folder header of the Show list: rename it (its `dossier:` tag
 * is rewritten on every look, its sub-folders keep their tail, an existing name merges the two),
 * create a sub-folder into it, or disband it (its looks — the whole subtree — go back « sans
 * dossier », the looks themselves stay). Written through the folder commands.
 */
export function FolderMenu({ folder, at, onChanged, onClose }: { folder: string; at: { x: number; y: number }; onChanged: () => void; onClose: () => void }) {
  const t = useT();
  const { box, style } = useFloatingMenu(at, onClose);
  const [mode, setMode] = useState<"idle" | "rename" | "sub">("idle");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const act = (p: Promise<unknown>) => void p.then(() => (onClose(), onChanged()), (e: Error) => setError(e.message));
  const submit = () => {
    const v = name.trim();
    if (!v) return;
    void act(cmd(mode === "sub" ? "show.folder.create" : "show.folder.rename", mode === "sub" ? { folder: v } : { from: folder, to: v }));
  };
  return (
    <div ref={box} className="widget-menu" role="dialog" aria-label={t.folder} style={style} onContextMenu={(e) => e.preventDefault()}>
      <h3>{folderLabel(folder)}</h3>
      {mode === "idle" ? (
        <div className="row">
          <button className="primary" onClick={() => (setMode("rename"), setName(folder))}>
            {t.renameFolder}
          </button>
          <button onClick={() => (setMode("sub"), setName(`${folder}/`))}>
            {t.newSub}
          </button>
          <button className="danger" onClick={() => confirm(t.disbandFolderConfirm.replace("{name}", folder)) && void act(cmd("show.folder.delete", { folder }))}>
            {t.disbandFolder}
          </button>
        </div>
      ) : (
        <div className="row new-folder">
          <input
            autoFocus
            value={name}
            aria-label={mode === "sub" ? t.newSub : t.renameFolder}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
          />
          <button className="primary" disabled={!name.trim()} aria-label={t.save} title={t.save} onClick={() => void submit()}>
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
