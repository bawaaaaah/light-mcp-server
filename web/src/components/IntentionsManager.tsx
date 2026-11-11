/**
 * The intentions of the Show page (T15, docs/specs/presets-songs-notes.md « Base de connaissances
 * couleur »): every intention known to the show with its colours, energy, family, origin (shipped,
 * private file, personal library, this show) and uses; a new one is stored in the show or in the
 * personal library, chosen in the editor; a shipped one is touched up or hidden for the show, a
 * personal one copied into the show so that it travels with its backups. Everything goes through
 * the commands (`intention.put`, `intention.delete`, `intention.preview`); the list is the one the
 * page already reads (`knowledge.get`) and comes back through `onChanged`.
 */
import { useEffect, useId, useMemo, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import type { Texts } from "../i18n";
import { quoted, beforeMark } from "../typography";
import { Modal } from "./Modal";
import {
  actionsOf,
  addColor,
  draftOf,
  draftProblems,
  ENERGIES,
  familiesOf,
  intentionKey,
  intentionsOf,
  MAX_COLORS,
  moveColor,
  newDraft,
  normalizeHex,
  putArgs,
  removeColor,
  searchIntentions,
  takenIn,
  type IntentionDraft,
  type IntentionRow,
  type KnowledgeIntentions,
  type RowAction,
} from "../intentions";

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (m, k: string) => String(values[k] ?? m));

export function IntentionsManager({ kb, onChanged, onError }: { kb: KnowledgeIntentions | null; onChanged: () => void; onError: (message: string) => void }): ReactElement {
  const t = useT();
  const id = useId();
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<IntentionDraft | null>(null);
  const list = useMemo(() => intentionsOf(kb), [kb]);
  const origin = (o: string) => t.intentionOrigins[o] ?? o;
  const shown = searchIntentions(list, query, origin);
  const run = (name: string, args: unknown) =>
    cmd(name, args)
      .then(onChanged)
      .catch((e: Error) => onError(e.message));

  const act = (row: IntentionRow, action: RowAction) => {
    const name = row.label;
    // what would leave songs or looks naming an unknown intention: say where first, force on the yes
    const askUses = (plain: string) => (row.usedBy.length ? confirm(`${quoted(t, name)} ${t.usedBy}\n\n• ${row.usedBy.join("\n• ")}\n\n${t.deleteAnyway}`) : confirm(plain));
    if (action === "edit" || action === "touchUp") return setDraft(draftOf(row));
    if (action === "copyToShow") return void run("intention.put", putArgs({ ...draftOf(row), scope: "show" }));
    if (action === "restore") return void run("intention.delete", { id: row.key });
    if (action === "revert") return confirm(fill(t.intentionRevertAsk, { name, origin: origin(row.over ?? "generic") })) && void run("intention.delete", { id: row.key });
    if (action === "hide") return askUses(fill(t.intentionHideAsk, { name })) && void run("intention.delete", { id: row.key, force: row.usedBy.length > 0 });
    const question = row.origin === "personal" ? fill(t.intentionDeletePersonal, { name }) : `${t.delete} ${quoted(t, name)}${beforeMark(t)}?`;
    return askUses(question) && void run("intention.delete", { id: row.key, force: row.usedBy.length > 0 });
  };

  const label = (action: RowAction): string =>
    ({ edit: t.edit, touchUp: t.intentionTouchUp, copyToShow: t.intentionCopyToShow, revert: t.intentionRevert, delete: t.delete, hide: t.intentionHide, restore: t.intentionRestore })[action];

  return (
    <section className="intentions" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t.intentions}</h2>
      <p className="hint">{t.intentionsHelp}</p>
      <div className="row">
        <input type="search" aria-label={t.intentionSearch} placeholder={t.intentionSearch} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="primary" onClick={() => setDraft(newDraft())}>
          {t.intentionNew}
        </button>
      </div>
      {shown.length === 0 && <p className="hint">{t.noMatch}</p>}
      <ul className="intention-list" aria-label={t.intentionList}>
        {shown.map((row) => (
          <li key={`${row.key}${row.hidden ? "-hidden" : ""}`} className={row.hidden ? "hidden-intention" : ""}>
            <span className="intention-swatches" aria-hidden="true">
              {row.colors.map((c, k) => (
                <i key={k} style={{ background: c }} />
              ))}
            </span>
            <span className="intention-name">
              <strong>{row.label}</strong>{" "}
              <small className="hint">
                {t.energies[row.energy]}
                {row.family ? ` · ${row.family}` : ""}
              </small>
            </span>
            <span className={`badge origin-${row.origin}`}>{origin(row.origin)}</span>
            {row.over && !row.hidden && <small className="hint">{fill(t.intentionOver, { origin: origin(row.over) })}</small>}
            {row.hidden && <small className="warn">{t.intentionHidden}</small>}
            <small className="hint" title={row.usedBy.join("\n")}>
              {row.usedBy.length ? fill(t.intentionUses, { n: row.usedBy.length }) : t.intentionNotUsed}
            </small>
            <span className="row intention-actions">
              {actionsOf(row).map((a) => (
                <button key={a} className={a === "delete" || a === "hide" ? "ghost" : ""} aria-label={`${label(a)} · ${row.label}`} title={a === "copyToShow" ? t.intentionCopyHelp : undefined} onClick={() => act(row, a)}>
                  {label(a)}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ul>
      {draft && (
        <IntentionEditor
          initial={draft}
          list={list}
          t={t}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

interface Preview {
  explanation: string[];
  contrast?: number;
}

function IntentionEditor({ initial, list, t, onClose, onSaved }: { initial: IntentionDraft; list: IntentionRow[]; t: Texts; onClose: () => void; onSaved: () => void }): ReactElement {
  const id = useId();
  const [d, setD] = useState(initial);
  const [hex, setHex] = useState<string[]>(initial.colors);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const problems = draftProblems(d, takenIn(list));
  const families = useMemo(() => familiesOf(list), [list]);
  const key = d.id ?? intentionKey(d.label);
  const creating = d.id === undefined;
  const shadowed = d.scope === "personal" && list.some((r) => r.key === key && r.origin === "show" && !r.hidden);
  const set = (patch: Partial<IntentionDraft>) => setD((x) => ({ ...x, ...patch }));
  const setColors = (colors: string[]) => {
    set({ colors });
    setHex(colors);
  };

  // the proposal these settings would give, refreshed as they change (debounced)
  const previewArgs = JSON.stringify(putArgs(d).intention);
  const valid = !problems.includes("colors");
  useEffect(() => {
    if (!valid) return setPreview(null);
    const timer = setTimeout(() => {
      void cmd<Preview>("intention.preview", { intention: JSON.parse(previewArgs) as unknown })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(timer);
  }, [previewArgs, valid]);

  const save = () =>
    void cmd("intention.put", putArgs(d))
      .then(onSaved)
      .catch((e: Error) => setError(e.message));

  return (
    <Modal label={creating ? t.intentionNew : initial.label || key}>
      <div className="intention-editor">
        <h3>{creating ? t.intentionNew : initial.label || key}</h3>
        <label>
          {t.intentionLabel}
          <input value={d.label} onChange={(e) => set({ label: e.target.value })} aria-invalid={problems.includes("label") || problems.includes("taken")} />
        </label>
        {key && <small className="hint">{t.intentionKey.replace("{key}", key)}</small>}
        {problems.includes("label") && d.label.trim() !== "" && <small className="warn">{t.intentionNoLabel}</small>}
        {problems.includes("taken") && <small className="warn">{t.intentionTaken}</small>}
        <fieldset>
          <legend>{t.intentionColors}</legend>
          <ol className="intention-colors">
            {d.colors.map((c, k) => {
              const n = k + 1;
              return (
                <li key={k} className="row">
                  <input type="color" aria-label={t.intentionColor.replace("{n}", String(n))} value={normalizeHex(c) ?? "#000000"} onChange={(e) => setColors(d.colors.map((x, j) => (j === k ? e.target.value : x)))} />
                  <input
                    className="hex"
                    aria-label={t.intentionColorHex.replace("{n}", String(n))}
                    value={hex[k] ?? c}
                    aria-invalid={!normalizeHex(hex[k] ?? c)}
                    onChange={(e) => {
                      const text = e.target.value;
                      setHex((h) => h.map((x, j) => (j === k ? text : x)));
                      set({ colors: d.colors.map((x, j) => (j === k ? (normalizeHex(text) ?? text) : x)) });
                    }}
                    onBlur={() => setHex(d.colors)}
                  />
                  <button type="button" aria-label={t.intentionColorUp.replace("{n}", String(n))} disabled={k === 0} onClick={() => setColors(moveColor(d.colors, k, -1))}>
                    ↑
                  </button>
                  <button type="button" aria-label={t.intentionColorDown.replace("{n}", String(n))} disabled={k === d.colors.length - 1} onClick={() => setColors(moveColor(d.colors, k, 1))}>
                    ↓
                  </button>
                  <button type="button" className="ghost" aria-label={t.intentionColorRemove.replace("{n}", String(n))} disabled={d.colors.length <= 1} onClick={() => setColors(removeColor(d.colors, k))}>
                    ×
                  </button>
                </li>
              );
            })}
          </ol>
          <button type="button" disabled={d.colors.length >= MAX_COLORS} onClick={() => setColors(addColor(d.colors))}>
            {t.intentionColorAdd}
          </button>
          {problems.includes("colors") && <small className="warn">{t.intentionBadColors}</small>}
        </fieldset>
        <label>
          {t.energy}
          <select value={d.energy} onChange={(e) => set({ energy: e.target.value as IntentionDraft["energy"] })}>
            {ENERGIES.map((e) => (
              <option key={e} value={e}>
                {t.energies[e]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.intentionFamily}
          <input list={`${id}-families`} value={d.family} onChange={(e) => set({ family: e.target.value })} />
          <datalist id={`${id}-families`}>
            {families.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>
        <label>
          {t.notes}
          <textarea rows={2} value={d.notes} onChange={(e) => set({ notes: e.target.value })} />
        </label>
        {creating && (
          <fieldset>
            <legend>{t.intentionScope}</legend>
            <label className="row">
              <input type="radio" name={`${id}-scope`} checked={d.scope === "show"} onChange={() => set({ scope: "show" })} />
              {t.intentionScopeShow}
            </label>
            <label className="row">
              <input type="radio" name={`${id}-scope`} checked={d.scope === "personal"} onChange={() => set({ scope: "personal" })} />
              {t.intentionScopePersonal}
            </label>
          </fieldset>
        )}
        {shadowed && <small className="hint">{t.intentionShadowed}</small>}
        {preview && (
          <div className="intention-preview" aria-live="polite">
            <strong>{t.intentionPreview}</strong>
            <ul className="hint">
              {preview.explanation.map((x) => (
                <li key={x}>{x}</li>
              ))}
              {preview.contrast !== undefined && (
                <li className={preview.contrast < 25 ? "warn" : ""}>
                  {t.intentionContrast.replace("{n}", String(preview.contrast))}
                  {preview.contrast < 25 ? ` — ${t.intentionLowContrast}` : ""}
                </li>
              )}
            </ul>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row actions">
          <button className="primary" disabled={problems.length > 0} onClick={save}>
            {t.save}
          </button>
          <button onClick={onClose}>{t.cancel}</button>
        </div>
      </div>
    </Modal>
  );
}
