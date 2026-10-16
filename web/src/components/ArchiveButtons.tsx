import { downloadArchive, previewArchive, restoreArchive, type FolderDiff } from "../api";
import { useT } from "../App";

/**
 * A .lightshow file of the open show (and its venue): download it, or restore one after seeing what
 * it would change (added, changed, removed files) — nothing is written before confirming.
 */
export function ArchiveButtons({ onError, onRestored }: { onError: (msg: string) => void; onRestored: () => void }) {
  const t = useT();
  return (
    <div className="row">
      <button onClick={() => void downloadArchive(true).catch((e: Error) => onError(e.message))}>⤓ {t.download}</button>
      <label className="button-like">
        ⤒ {t.restore}
        <input
          type="file"
          accept=".lightshow,.zip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ""; // the same file can be chosen again
            if (!f) return;
            void previewArchive(f)
              .then((p) => {
                const part = (label: string, d: FolderDiff | null) =>
                  d === null
                    ? `${label} : ${t.untouchedPart}`
                    : `${label} : +${d.added.length} / ~${d.changed.length} / -${d.removed.length}${[...d.added.map((x) => `\n  + ${x}`), ...d.changed.map((x) => `\n  ~ ${x}`), ...d.removed.map((x) => `\n  - ${x}`)].slice(0, 12).join("")}`;
                const nothing = [p.show, p.venue].every((d) => d === null || d.added.length + d.changed.length + d.removed.length === 0);
                if (nothing) return onError(t.restoreSame);
                const summary = `${t.restoreConfirm}\n\n${part(t.show, p.show)}\n${part(t.venue, p.venue)}`;
                if (confirm(summary)) return restoreArchive(f).then(onRestored);
              })
              .catch((err: Error) => onError(err.message));
          }}
        />
      </label>
    </div>
  );
}
