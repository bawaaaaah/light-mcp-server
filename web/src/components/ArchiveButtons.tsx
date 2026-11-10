import type { ReactElement } from "react";
import { downloadArchive, previewArchive, restoreArchive, type FixturePolicy, type FolderDiff, type FixtureSummary } from "../api";
import { useT } from "../App";

/**
 * A .lightshow file of the open show (and its venue): download it, or restore one after seeing what
 * it would change (added, changed, removed files) — nothing is written before confirming.
 */
export function ArchiveButtons({ onError, onRestored }: { onError: (msg: string) => void; onRestored: () => void }): ReactElement {
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
                const defs = (x: FixtureSummary) =>
                  x.missing.length + x.differs.length + x.invalid.length + x.rejected.length === 0
                    ? ""
                    : `\n${t.restoreFixtures} : ${x.missing.length} ${t.restoreFixturesMissing}, ${x.differs.length} ${t.restoreFixturesDiffer}${x.invalid.length + x.rejected.length ? `, ${x.invalid.length + x.rejected.length} ${t.restoreFixturesSkipped}` : ""}${[...x.missing.map((n) => `\n  + ${n}`), ...x.differs.map((n) => `\n  ~ ${n}`)].slice(0, 12).join("")}`;
                const folders = [p.show, p.venue].every((d) => d === null || d.added.length + d.changed.length + d.removed.length === 0);
                if (folders && p.fixtures.missing.length + p.fixtures.differs.length === 0) return onError(t.restoreSame);
                const summary = `${t.restoreConfirm}\n\n${part(t.show, p.show)}\n${part(t.venue, p.venue)}${defs(p.fixtures)}`;
                if (!confirm(summary)) return;
                // the policy: missing definitions are added; the differing ones only when asked
                const policy: FixturePolicy = p.fixtures.differs.length && confirm(t.restoreFixturesReplaceAsk) ? "replace" : "missing";
                // only differing definitions, and they are kept: a restore would just stop the show for nothing
                if (policy === "missing" && folders && p.fixtures.missing.length === 0) return;
                return restoreArchive(f, policy).then(onRestored);
              })
              .catch((err: Error) => onError(err.message));
          }}
        />
      </label>
    </div>
  );
}
