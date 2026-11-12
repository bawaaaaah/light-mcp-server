import { useId, useState, type ReactElement } from "react";
import { Modal } from "./Modal";
import { downloadArchive, previewArchive, restoreArchive, type FixturePolicy, type FolderDiff, type FixtureSummary, type IntentionTwin } from "../api";
import { useT } from "../App";
import { fill, plural } from "../intentions";

/**
 * A .lightshow file of the open show (and its venue): download it, or restore one after seeing what
 * it would change (added, changed, removed files) — nothing is written before confirming.
 */
export function ArchiveButtons({ onError, onRestored }: { onError: (msg: string) => void; onRestored: () => void }): ReactElement {
  const t = useT();
  // intentions made apart on another machine (T15b): the restore waits for a choice per intention
  const [pending, setPending] = useState<{ file: File; policy: FixturePolicy; list: IntentionTwin[] } | null>(null);
  return (
    <div className="row">
      {pending && (
        <TwinsDialog
          twins={pending.list}
          onCancel={() => setPending(null)}
          onRestore={(keep) => {
            const { file, policy } = pending;
            setPending(null);
            void restoreArchive(file, policy, keep)
              .then(onRestored)
              .catch((err: Error) => onError(err.message));
          }}
        />
      )}
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
                // the show's intentions get a line of their own below: not listed twice
                const notIntention = (x: string) => !x.startsWith("intentions/");
                const part = (label: string, whole: FolderDiff | null) => {
                  const d = whole && { ...whole, added: whole.added.filter(notIntention), changed: whole.changed.filter(notIntention), removed: whole.removed.filter(notIntention) };
                  return d === null
                    ? `${label}${t.colon} ${t.untouchedPart}`
                    : `${label}${t.colon} +${d.added.length} / ~${d.changed.length} / -${d.removed.length}${[...d.added.map((x) => `\n  + ${x}`), ...d.changed.map((x) => `\n  ~ ${x}`), ...d.removed.map((x) => `\n  - ${x}`)].slice(0, 12).join("")}`;
                };
                const defs = (x: FixtureSummary) =>
                  x.missing.length + x.differs.length + x.invalid.length + x.rejected.length === 0
                    ? ""
                    : `\n${t.restoreFixtures}${t.colon} ${x.missing.length} ${t.restoreFixturesMissing}, ${x.differs.length} ${t.restoreFixturesDiffer}${x.invalid.length + x.rejected.length ? `, ${x.invalid.length + x.rejected.length} ${t.restoreFixturesSkipped}` : ""}${[...x.missing.map((n) => `\n  + ${n}`), ...x.differs.map((n) => `\n  ~ ${n}`)].slice(0, 12).join("")}`;
                const folders = [p.show, p.venue].every((d) => d === null || d.added.length + d.changed.length + d.removed.length === 0);
                if (folders && p.fixtures.missing.length + p.fixtures.differs.length === 0) return onError(t.restoreSame);
                // the show's intentions, apart: an older backup without any removes them (T15)
                const i = p.intentions;
                const known = p.intentionsKnown ?? [];
                const twins = p.intentionTwins ?? []; // an older server sends none
                const twinOrigin = (w: IntentionTwin) => t.intentionOrigins[w.machine.origin];
                const intentions =
                  (i && i.added + i.changed + i.removed ? `\n${t.restoreIntentions}${t.colon} +${i.added} / ~${i.changed} / -${i.removed}${i.removed && !i.added && !i.changed ? ` (${t.restoreIntentionsGone})` : ""}` : "") +
                  (known.length ? `\n${plural(known.length, t.restoreIntentionKnown, t.restoreIntentionsKnown)}${t.colon} ${known.map((k) => k.label).join(", ")}` : "") +
                  // made apart on another machine (T15b): restored as they are, a second intention of that label
                  twins.map((w) => `\n${fill(t.restoreIntentionTwin, { name: w.label, id: w.id, origin: twinOrigin(w), machineId: w.machine.id })}`).join("");
                const summary = `${t.restoreConfirm}\n\n${part(t.show, p.show)}${intentions}\n${part(t.venue, p.venue)}${defs(p.fixtures)}`;
                if (!confirm(summary)) return;
                // the policy: missing definitions are added; the differing ones only when asked
                const policy: FixturePolicy = p.fixtures.differs.length && confirm(t.restoreFixturesReplaceAsk) ? "replace" : "missing";
                // only differing definitions, and they are kept: a restore would just stop the show for nothing
                if (policy === "missing" && folders && p.fixtures.missing.length === 0) return;
                // made apart on another machine: one choice per intention before anything is written
                if (twins.length) return setPending({ file: f, policy, list: twins });
                return restoreArchive(f, policy).then(onRestored);
              })
              .catch((err: Error) => onError(err.message));
          }}
        />
      </label>
    </div>
  );
}

/** Colour swatches of an intention, said by their hexadecimal values for a reader. */
function Swatches({ colors }: { colors: readonly string[] }): ReactElement {
  return (
    <span className="intention-swatches" role="img" aria-label={colors.join(", ")}>
      {colors.map((c, k) => (
        <i key={k} style={{ background: c }} />
      ))}
    </span>
  );
}

/**
 * The intentions a backup brings that this machine made apart under another id (T15b): for each, keep
 * the backup's (a second intention of that label) or this machine's (the restored songs and looks name
 * it). Nothing is written before « Restaurer »; « Annuler la restauration » leaves everything as it is.
 */
function TwinsDialog({ twins, onRestore, onCancel }: { twins: IntentionTwin[]; onRestore: (keepMachine: string[]) => void; onCancel: () => void }): ReactElement {
  const t = useT();
  const id = useId();
  const [keep, setKeep] = useState<Record<string, boolean>>({});
  return (
    <Modal label={t.restoreTwinsTitle} onClose={onCancel}>
      <div className="restore-twins">
        <h3>{t.restoreTwinsTitle}</h3>
        <p className="hint">{t.restoreTwinsHelp}</p>
        {twins.map((w, k) => (
          <fieldset key={w.id}>
            <legend>
              « {w.label} »
            </legend>
            <label>
              <input type="radio" name={`${id}-${k}`} checked={!keep[w.id]} onChange={() => setKeep((x) => ({ ...x, [w.id]: false }))} />
              <Swatches colors={w.colors} />
              <span>{fill(t.restoreTwinArchive, { id: w.id, name: w.label })}</span>
            </label>
            <label>
              <input type="radio" name={`${id}-${k}`} checked={Boolean(keep[w.id])} onChange={() => setKeep((x) => ({ ...x, [w.id]: true }))} />
              <Swatches colors={w.machine.colors ?? []} />
              <span>{fill(t.restoreTwinMachine, { id: w.machine.id, origin: t.intentionOrigins[w.machine.origin] })}</span>
            </label>
          </fieldset>
        ))}
        <div className="row actions">
          <button className="primary" onClick={() => onRestore(twins.filter((w) => keep[w.id]).map((w) => w.id))}>
            {t.restoreTwinsGo}
          </button>
          <button onClick={onCancel}>{t.restoreTwinsCancel}</button>
        </div>
      </div>
    </Modal>
  );
}
