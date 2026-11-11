/**
 * The intentions of the Show page (T15, docs/specs/presets-songs-notes.md « Base de connaissances
 * couleur »): every intention known to the show with its colours, energy, family, origin (shipped,
 * private file, personal library, this show) and uses; a new one is stored in the show or in the
 * personal library, chosen in the editor; a shipped one is touched up or hidden for the show, a
 * personal one copied into the show. Everything goes through the commands (`intention.put`,
 * `intention.delete`, `intention.preview`); the list is the one the page reads (`knowledge.get`), read
 * again by the page when a command changes it.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import type { Texts } from "../i18n";
import { Modal } from "./Modal";
import { confirmDelete } from "./confirmDelete";
import {
  actionsOf,
  addColor,
  draftOf,
  draftProblems,
  ENERGIES,
  familiesOf,
  fill,
  intentionKey,
  intentionsOf,
  MAX_COLORS,
  moveColor,
  newDraft,
  normalizeHex,
  plural,
  putArgs,
  removeColor,
  replacedBy,
  searchIntentions,
  takenIn,
  type IntentionDraft,
  type IntentionOrigin,
  type IntentionRow,
  type KnowledgeIntentions,
  type RowAction,
} from "../intentions";

export function IntentionsManager({ kb, onError }: { kb: KnowledgeIntentions | null; onError: (message: string) => void }): ReactElement {
  const t = useT();
  const id = useId();
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<IntentionDraft | null>(null);
  const list = useMemo(() => intentionsOf(kb), [kb]);
  const origin = (o: IntentionOrigin) => t.intentionOrigins[o];
  const shown = searchIntentions(list, query, origin);
  const fail = (e: Error) => onError(e.message);

  const act = (row: IntentionRow, action: RowAction) => {
    const name = row.label;
    if (action === "edit" || action === "touchUp") return setDraft(draftOf(row));
    if (action === "copyToShow") return void cmd("intention.put", putArgs({ ...draftOf(row), scope: "show" })).catch(fail);
    if (action === "restore") return void cmd("intention.delete", { id: row.key }).catch(fail);
    if (action === "revert") return confirm(fill(t.intentionRevertAsk, { name, origin: origin(row.over ?? "generic") })) && void cmd("intention.delete", { id: row.key }).catch(fail);
    // what would leave songs or looks naming an unknown intention: the uses read now, said first, forced on the yes
    const words =
      action === "hide"
        ? { plain: fill(t.intentionHideAsk, { name, origin: origin(row.origin) }), usedBy: t.intentionUsedBy, anyway: t.intentionHideAnyway }
        : { plain: fill(row.origin === "personal" ? t.intentionDeletePersonal : t.intentionDeleteShow, { name }), usedBy: t.intentionUsedBy, anyway: t.intentionDeleteAnyway, forced: t.intentionOthersAnyway };
    void confirmDelete("intention", row.key, name, t, undefined, words).catch(fail);
  };

  const label = (action: RowAction): string =>
    ({ edit: t.edit, touchUp: t.intentionTouchUp, copyToShow: t.intentionCopyToShow, revert: t.intentionRevert, delete: t.delete, hide: t.intentionHide, restore: t.intentionRestore })[action];

  return (
    <section className="intentions" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t.intentions}</h2>
      <p className="hint">{t.intentionsHelp}</p>
      <div className="row intentions-bar">
        <input type="search" aria-label={t.intentionSearch} placeholder={t.intentionSearch} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="primary" onClick={() => setDraft(newDraft())}>
          {t.intentionNew}
        </button>
      </div>
      {/* nothing said while the list is not there yet (loading, or the read failed: the page says why) */}
      {kb && list.length > 0 && shown.length === 0 && <p className="hint">{t.noMatch}</p>}
      {shown.length > 0 && (
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
              {/* a mask keeps saying what it hides: « livrée · masquée dans ce show » */}
              <span className={`badge origin-${row.hidden ? (row.over ?? "generic") : row.origin}`}>{origin(row.hidden ? (row.over ?? "generic") : row.origin)}</span>
              {row.over && !row.hidden && <small className="hint">{fill(t.intentionOver, { origin: origin(row.over) })}</small>}
              {row.hidden && <small className="warn">{t.intentionHidden}</small>}
              {row.usedBy.length ? (
                <details className="intention-uses">
                  <summary>{plural(row.usedBy.length, t.intentionUse, t.intentionUses)}</summary>
                  <ul>
                    {row.usedBy.map((u) => (
                      <li key={u}>{u}</li>
                    ))}
                  </ul>
                </details>
              ) : (
                <small className="hint">{t.intentionNotUsed}</small>
              )}
              <span className="row intention-actions">
                {actionsOf(row).map((a) => (
                  <button key={a} className={a === "delete" || a === "hide" ? "ghost" : ""} aria-label={`${label(a)} · ${row.label}`} aria-describedby={a === "copyToShow" ? `${id}-copy-${row.key}` : undefined} onClick={() => act(row, a)}>
                    {label(a)}
                  </button>
                ))}
              </span>
              {/* said on screen, for a finger as for a mouse: what copying into the show is for */}
              {actionsOf(row).includes("copyToShow") && (
                <small className="hint intention-copy-help" id={`${id}-copy-${row.key}`}>
                  {t.intentionCopyHelp}
                </small>
              )}
            </li>
          ))}
        </ul>
      )}
      {draft && <IntentionEditor initial={draft} list={list} t={t} onClose={() => setDraft(null)} />}
    </section>
  );
}

interface Preview {
  explanation: string[];
  contrast?: number;
  lowContrast?: boolean;
}

/** A colour of the draft with a stable id: its row keeps its key (and the focus) when it moves. */
interface Swatch {
  id: number;
  color: string;
  /** What is typed in its hexadecimal field (may be half typed). */
  text: string;
}

function IntentionEditor({ initial, list, t, onClose }: { initial: IntentionDraft; list: IntentionRow[]; t: Texts; onClose: () => void }): ReactElement {
  const id = useId();
  const next = useRef(0);
  const swatch = (color: string): Swatch => ({ id: next.current++, color, text: color });
  const [d, setD] = useState<Omit<IntentionDraft, "colors">>(initial);
  const [swatches, setSwatches] = useState<Swatch[]>(() => initial.colors.map(swatch));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  /** The colour to give the focus to after a move: its id, and which of its buttons. */
  const focusAfter = useRef<{ id: number; by: -1 | 1 } | null>(null);
  const draft: IntentionDraft = { ...d, colors: swatches.map((s) => s.color) };
  const problems = draftProblems(draft, takenIn(list));
  const families = useMemo(() => familiesOf(list), [list]);
  const key = d.id ?? intentionKey(d.label);
  const creating = d.id === undefined;
  const changed = JSON.stringify(putArgs(draft)) !== JSON.stringify(putArgs(initial));
  const shadowed = d.scope === "personal" && list.some((r) => r.key === key && r.origin === "show" && !r.hidden);
  const replaced = replacedBy(draft, list);
  const set = (patch: Partial<IntentionDraft>) => setD((x) => ({ ...x, ...patch }));
  const title = creating ? t.intentionNewTitle : initial.label || key;

  // the proposal these settings would give, refreshed as they change (debounced; a late answer is dropped; notes play no part)
  const { notes: _notes, ...shape } = putArgs(draft).intention;
  const previewArgs = JSON.stringify(shape);
  const valid = !problems.includes("colors");
  useEffect(() => {
    if (!valid) return setPreview(null);
    let current = true;
    const timer = setTimeout(() => {
      void cmd<Preview>("intention.preview", { intention: JSON.parse(previewArgs) as unknown })
        .then((p) => current && setPreview(p))
        .catch(() => current && setPreview(null));
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [previewArgs, valid]);

  useEffect(() => {
    const f = focusAfter.current;
    if (!f) return;
    focusAfter.current = null;
    // the moved colour's same button, or the other one when it reached an end
    const row = document.getElementById(`${id}-c${f.id}`);
    const button = row?.querySelector<HTMLButtonElement>(`button[data-move="${f.by}"]:not(:disabled)`) ?? row?.querySelector<HTMLButtonElement>("button[data-move]:not(:disabled)");
    button?.focus();
  }, [swatches, id]);

  const save = () => {
    setSaving(true);
    void cmd("intention.put", putArgs(draft))
      .then(onClose)
      .catch((e: Error) => {
        setError(e.message);
        setSaving(false);
      });
  };
  const move = (k: number, by: -1 | 1) => {
    focusAfter.current = { id: swatches[k]!.id, by };
    setSwatches((s) => moveColor(s, k, by));
  };
  const setColor = (k: number, patch: Partial<Swatch>) => setSwatches((s) => s.map((x, j) => (j === k ? { ...x, ...patch } : x)));

  return (
    // unchanged, Escape or a press beside it closes it (nothing to lose); once changed, only its buttons do
    <Modal label={title} onClose={changed ? undefined : onClose}>
      <div className="intention-editor">
        <h3>{title}</h3>
        <label>
          {t.intentionLabel}
          <input value={d.label} maxLength={120} onChange={(e) => set({ label: e.target.value })} aria-invalid={problems.includes("label") || problems.includes("taken") || problems.includes("long")} />
        </label>
        {key && <small className="hint">{fill(t.intentionKey, { key })}</small>}
        {problems.includes("label") && d.label.trim() !== "" && <small className="warn">{t.intentionNoLabel}</small>}
        {problems.includes("long") && <small className="warn">{t.intentionTooLong}</small>}
        {problems.includes("taken") && <small className="warn">{t.intentionTaken}</small>}
        {replaced && !problems.includes("taken") && (
          <small className="hint">{fill(t.intentionReplaces, { origin: t.intentionOrigins[replaced.hidden ? (replaced.over ?? "generic") : replaced.origin], name: replaced.label, where: d.scope === "show" ? t.intentionReplacesShow : t.intentionReplacesPersonal })}</small>
        )}
        <fieldset>
          <legend>{t.intentionColors}</legend>
          <ol className="intention-colors">
            {swatches.map((c, k) => {
              const n = k + 1;
              return (
                <li key={c.id} id={`${id}-c${c.id}`} className="row">
                  <input type="color" aria-label={fill(t.intentionColor, { n })} value={normalizeHex(c.color) ?? "#000000"} onChange={(e) => setColor(k, { color: e.target.value, text: e.target.value })} />
                  <input
                    className="hex"
                    aria-label={fill(t.intentionColorHex, { n })}
                    value={c.text}
                    aria-invalid={!normalizeHex(c.text)}
                    onChange={(e) => setColor(k, { text: e.target.value, color: normalizeHex(e.target.value) ?? e.target.value })}
                    onBlur={() => setColor(k, { text: normalizeHex(c.text) ?? c.text })}
                  />
                  <button type="button" data-move="-1" aria-label={fill(t.intentionColorUp, { n })} disabled={k === 0} onClick={() => move(k, -1)}>
                    ↑
                  </button>
                  <button type="button" data-move="1" aria-label={fill(t.intentionColorDown, { n })} disabled={k === swatches.length - 1} onClick={() => move(k, 1)}>
                    ↓
                  </button>
                  <button type="button" className="ghost" aria-label={fill(t.intentionColorRemove, { n })} disabled={swatches.length <= 1} onClick={() => setSwatches((s) => removeColor(s, k))}>
                    ×
                  </button>
                </li>
              );
            })}
          </ol>
          <button type="button" disabled={swatches.length >= MAX_COLORS} onClick={() => setSwatches((s) => [...s, swatch(addColor(s.map((x) => x.color)).at(-1)!)])}>
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
          <input list={`${id}-families`} value={d.family} maxLength={40} onChange={(e) => set({ family: e.target.value })} />
          <datalist id={`${id}-families`}>
            {families.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>
        <label>
          {t.notes}
          <textarea rows={2} value={d.notes} maxLength={2000} onChange={(e) => set({ notes: e.target.value })} />
        </label>
        {creating && (
          <fieldset className="intention-scope">
            <legend>{t.intentionScope}</legend>
            <label>
              <input type="radio" name={`${id}-scope`} checked={d.scope === "show"} onChange={() => set({ scope: "show" })} />
              <span>{t.intentionScopeShow}</span>
            </label>
            <label>
              <input type="radio" name={`${id}-scope`} checked={d.scope === "personal"} onChange={() => set({ scope: "personal" })} />
              <span>{t.intentionScopePersonal}</span>
            </label>
          </fieldset>
        )}
        {shadowed && <small className="hint">{t.intentionShadowed}</small>}
        {/* always there, so that a reader hears the proposal change */}
        <div className="intention-preview" aria-live="polite">
          {preview && (
            <>
              <strong>{t.intentionPreview}</strong>
              <ul className="hint">
                {preview.explanation.map((x) => (
                  <li key={x}>{x}</li>
                ))}
                {preview.contrast !== undefined && (
                  <li className={preview.lowContrast ? "warn" : ""}>
                    {fill(t.intentionContrast, { n: preview.contrast })}
                    {preview.lowContrast ? ` — ${t.intentionLowContrast}` : ""}
                  </li>
                )}
              </ul>
            </>
          )}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row actions">
          <button className="primary" disabled={problems.length > 0 || saving} onClick={save}>
            {t.save}
          </button>
          <button onClick={onClose}>{t.cancel}</button>
        </div>
      </div>
    </Modal>
  );
}
