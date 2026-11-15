/**
 * The venue's « Cibles » section (T24, lot 4; docs/specs/venue-fixtures-stage.md, « Cible »): the show's 3D targets,
 * listed under the stage plan, created, edited and deleted here — name, the moving heads that follow it (boxes) and/or
 * a group, bounds (the stage volume by default), smoothing of the point, how the heads arrive, colour. The point and
 * the engagement are live state: moved and engaged from the target pad, MIDI, OSC or the AI, never by this form.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents } from "../hooks/useTopic";
import type { Box3, MoveFade, Smoothing, TargetRow } from "../hooks/useTargets";
import { slug, uniqueId } from "../util";
import { SWATCHES } from "../color";
import { quoted } from "../typography";
import { confirmDelete } from "./confirmDelete";
import { SmoothingField } from "./SmoothingField";
import { MoveFadeInput } from "./LookEditor";
import { metresText } from "../target-status";

interface Named {
  id: string;
  name: string;
}
type Axis = "x" | "y" | "z";
type End = "min" | "max";
const AXES: readonly Axis[] = ["x", "y", "z"];
/** The bounds as typed: strings, so a field being typed (« -1, », empty) is not rewritten under the cursor. */
type BoundsText = Record<End, Record<Axis, string>>;

interface Draft {
  /** Absent: a new target. */
  id?: string;
  name: string;
  fixtures: string[];
  group: string;
  /** null: the stage volume. */
  bounds: BoundsText | null;
  smoothing?: Smoothing;
  fade?: MoveFade;
  color?: string;
}

const boundsText = (b: Box3): BoundsText => ({
  min: { x: String(b.min.x), y: String(b.min.y), z: String(b.min.z) },
  max: { x: String(b.max.x), y: String(b.max.y), z: String(b.max.z) },
});
const draftOf = (row: TargetRow): Draft => ({
  id: row.id,
  name: row.name,
  fixtures: [...row.fixtures],
  group: row.group ?? "",
  bounds: row.bounds ? boundsText(row.bounds) : null,
  ...(row.smoothing ? { smoothing: row.smoothing } : {}),
  ...(row.fade ? { fade: row.fade } : {}),
  ...(row.color ? { color: row.color } : {}),
});
/** What the form compares to see whether a target changed elsewhere since it opened (not its point nor its engagement). */
const settingsOf = (row: TargetRow): string => JSON.stringify([row.name, row.fixtures, row.group, row.bounds, row.smoothing, row.fade, row.color]);

const num = (v: string): number => (v.trim() === "" ? NaN : Number(v.replace(",", ".")));
/** Per bound typed, what is wrong with it: not a number, or a minimum above its maximum (said at the minimum). */
function boundsProblems(b: BoundsText): Partial<Record<`${End}-${Axis}`, "number" | "order">> {
  const out: Partial<Record<`${End}-${Axis}`, "number" | "order">> = {};
  for (const a of AXES) {
    const [lo, hi] = [num(b.min[a]), num(b.max[a])];
    if (!Number.isFinite(lo)) out[`min-${a}`] = "number";
    if (!Number.isFinite(hi)) out[`max-${a}`] = "number";
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo > hi) out[`min-${a}`] = "order";
  }
  return out;
}
const parsedBounds = (b: BoundsText): Box3 => ({ min: { x: num(b.min.x), y: num(b.min.y), z: num(b.min.z) }, max: { x: num(b.max.x), y: num(b.max.y), z: num(b.max.z) } });

export function TargetsPanel({ targets, onError, onChanged }: { targets: TargetRow[]; onError: (message: string) => void; onChanged: () => void }): ReactElement {
  const t = useT();
  const w = t.targets;
  const [heads, setHeads] = useState<Named[]>([]);
  const [groups, setGroups] = useState<Named[]>([]);
  const [showFade, setShowFade] = useState<MoveFade | undefined>(undefined);
  /** The stage volume as the server sees it (target.volume): a new target's bounds start from it. */
  const [stageVolume, setStageVolume] = useState<Box3 | undefined>(undefined);
  const read = useCallback(() => {
    void cmd<Named[]>("position.list").then((list) => setHeads(list.map((h) => ({ id: h.id, name: h.name }))), () => undefined);
    void cmd<Named[]>("group.list").then((list) => setGroups(list.map((g) => ({ id: g.id, name: g.name }))), () => undefined);
    // « automatique » says the show's own glide, as the look editor does
    void cmd<{ moveFade: MoveFade }>("show.settings").then((s) => setShowFade(s.moveFade), () => undefined);
    void cmd<Box3>("target.volume").then(setStageVolume, () => undefined);
  }, []);
  useEffect(read, [read]);
  useCommandEvents(["venue.", "stage.", "group.", "show.", "import.", "history."], read);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The draft as it opened: Close and « Modifier » on another row ask before dropping changes. */
  const opened = useRef<string>("");
  /** The target's settings when its draft opened: changed elsewhere since (another screen, the AI), the form says so. */
  const base = useRef<string>("");
  const [problem, setProblem] = useState("");
  const [tried, setTried] = useState(false);
  const formId = useId();
  const form = useRef<HTMLFormElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** « + Ajouter »: unmounted while a new target's form is open, it takes the focus back when that form closes. */
  const addButton = useRef<HTMLButtonElement | null>(null);
  const pendingFade = useRef<(() => { value: MoveFade | undefined } | null) | null>(null);
  // the target being edited deleted meanwhile (another screen, the AI): the form closes
  useEffect(() => {
    if (draft?.id && !targets.some((x) => x.id === draft.id)) setDraft(null);
  }, [targets, draft?.id]);
  // the form takes the focus when it opens (its name), and gives it back to what opened it when it closes
  const isOpen = draft !== null;
  useEffect(() => {
    if (isOpen) form.current?.querySelector<HTMLInputElement>("input")?.focus();
    // what opened it gone (« + Ajouter » while the form was open, a row deleted meanwhile): « + Ajouter » takes it
    else if (opener.current) (opener.current.isConnected ? opener.current : addButton.current)?.focus();
  }, [isOpen]);

  const dirty = (): boolean => draft !== null && JSON.stringify(draft) !== opened.current;
  /** Opens `next` (or closes, null), asking first when the draft open has changes. */
  const open = (next: Draft | null, from?: HTMLElement): void => {
    if (dirty() && !confirm(w.discardDraft)) return;
    if (from) opener.current = from;
    setProblem("");
    setTried(false);
    opened.current = next ? JSON.stringify(next) : "";
    const row = next?.id ? targets.find((x) => x.id === next.id) : undefined;
    base.current = row ? settingsOf(row) : "";
    setDraft(next);
  };
  const current = draft?.id ? targets.find((x) => x.id === draft.id) : undefined;
  const changedElsewhere = Boolean(current && base.current && settingsOf(current) !== base.current);

  const set = (patch: Partial<Draft>) => {
    setProblem("");
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };
  const problems = draft?.bounds ? boundsProblems(draft.bounds) : {};
  const save = async (): Promise<void> => {
    if (!draft) return;
    setTried(true);
    if (!draft.name.trim()) return setProblem(w.nameRequired);
    const wrong = AXES.flatMap((a) => (["min", "max"] as const).map((end) => `${end}-${a}` as const)).find((k) => problems[k]);
    if (wrong) {
      form.current?.querySelector<HTMLInputElement>(`.target-bounds input[data-bound="${wrong}"]`)?.focus();
      return setProblem(w.boundsInvalid);
    }
    // a unit picked for the arrival and not committed yet goes with this Save
    const fade = pendingFade.current ? pendingFade.current() : { value: draft.fade };
    if (!fade) return;
    const bounds = draft.bounds ? parsedBounds(draft.bounds) : undefined;
    try {
      // a new id is checked against the targets as they are now: one created elsewhere meanwhile is not replaced
      const id = draft.id ?? uniqueId(slug(draft.name, "cible"), (await cmd<TargetRow[]>("target.list")).map((x) => x.id));
      await cmd("target.put", {
        target: {
          id,
          name: draft.name.trim(),
          fixtures: draft.fixtures,
          ...(draft.group ? { group: draft.group } : {}),
          ...(bounds ? { bounds } : {}),
          ...(draft.smoothing ? { smoothing: draft.smoothing } : {}),
          ...(fade.value ? { fade: fade.value } : {}),
          ...(draft.color ? { color: draft.color } : {}),
          ...(current?.notes ? { notes: current.notes } : {}),
        },
      });
      opened.current = "";
      setDraft(null);
      onChanged();
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  const headCount = (n: number) => (n === 1 ? w.headCountOne : w.headCountMany.replace("{n}", () => String(n)));
  const m = (v: number) => metresText(v, t.decimalMark);
  const groupKnown = !draft?.group || groups.some((g) => g.id === draft.group);

  return (
    <div className="targets-panel">
      <p className="hint">{w.help}</p>
      {heads.length === 0 && <p className="hint">{w.noHeads}</p>}
      {targets.length === 0 ? (
        <p className="hint">{w.none}</p>
      ) : (
        <ul className="target-list">
          {targets.map((row) => (
            <li key={row.id} className="target-row" data-target={row.id} style={row.color ? ({ "--target-color": row.color } as React.CSSProperties) : undefined}>
              <span className="target-swatch" aria-hidden="true" />
              <strong>{row.name}</strong>
              <small>{headCount(row.heads.length)}</small>
              {row.engaged && <span className="badge">{w.engagedBadge}</span>}
              <small className="grow">{w.point.replace("{x}", () => m(row.point.x)).replace("{y}", () => m(row.point.y)).replace("{z}", () => m(row.point.z))}</small>
              <button aria-label={w.editing.replace("{name}", () => row.name)} title={w.editing.replace("{name}", () => row.name)} aria-expanded={draft?.id === row.id} aria-controls={draft?.id === row.id ? formId : undefined} onClick={(e) => open(draftOf(row), e.currentTarget)}>
                {t.edit}
              </button>
              <button
                className="ghost target-delete"
                aria-label={`${t.delete} ${row.name}`}
                title={`${t.delete} ${row.name}`}
                onClick={() => void confirmDelete("target", row.id, row.name, t, row.engaged ? w.deleteEngaged : undefined).then((done) => done && onChanged(), (e: Error) => onError(e.message))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {!draft && (
        <button ref={addButton} aria-expanded={false} onClick={(e) => open({ name: "", fixtures: [], group: "", bounds: null }, e.currentTarget)}>
          + {w.add}
        </button>
      )}
      {draft && (
        <form
          ref={form}
          id={formId}
          className="target-form"
          aria-label={draft.id ? w.editing.replace("{name}", () => quoted(t, draft.name)) : w.creating}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="field">
            <span>{t.name}</span>
            <input value={draft.name} required onChange={(e) => set({ name: e.target.value })} />
          </label>
          <fieldset>
            <legend>{w.headsLegend}</legend>
            <div className="target-heads">
              {heads.map((h) => (
                <label key={h.id}>
                  <input type="checkbox" checked={draft.fixtures.includes(h.id)} onChange={(e) => set({ fixtures: e.target.checked ? [...draft.fixtures, h.id] : draft.fixtures.filter((x) => x !== h.id) })} />
                  {h.name}
                </label>
              ))}
              {/* a fixture listed but no longer a moving head of the venue: kept, and can be unticked */}
              {draft.fixtures
                .filter((id) => !heads.some((h) => h.id === id))
                .map((id) => (
                  <label key={id}>
                    <input type="checkbox" checked onChange={() => set({ fixtures: draft.fixtures.filter((x) => x !== id) })} />
                    {id}
                  </label>
                ))}
            </div>
            <label className="field">
              <span>{w.group}</span>
              <select value={draft.group} onChange={(e) => set({ group: e.target.value })}>
                <option value="">{w.noGroup}</option>
                {/* a group deleted since: said, and can be left for another */}
                {!groupKnown && <option value={draft.group}>{w.groupGone.replace("{id}", () => draft.group)}</option>}
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          <fieldset>
            <legend>{w.bounds}</legend>
            <label className="target-volume">
              <input
                type="checkbox"
                checked={draft.bounds === null}
                onChange={(e) => {
                  // the bounds start from the volume really used: the target's own, else the stage's as the server sees it
                  const from = current?.effectiveBounds ?? stageVolume;
                  set({ bounds: e.target.checked || !from ? null : boundsText(from) });
                }}
              />
              <span>{w.stageVolume}</span>
            </label>
            {draft.bounds === null && <p className="hint">{w.stageVolumeHelp}</p>}
            {draft.bounds && (
              <div className="target-bounds">
                {AXES.map((a) => (
                  <div key={a} className="target-bounds-axis">
                    {(["min", "max"] as const).map((end) => {
                      const label = (end === "min" ? w.boundsMin : w.boundsMax).replace("{axis}", a.toUpperCase());
                      // said near the field once a Save was tried: « - » on the way to « -1 » is not an error yet
                      const wrong = tried ? problems[`${end}-${a}`] : undefined;
                      const errorId = `${formId}-${end}-${a}`;
                      return (
                        <label key={end}>
                          <span>{label}</span>
                          <input
                            type="text"
                            inputMode="decimal"
                            aria-label={label}
                            data-bound={`${end}-${a}`}
                            aria-invalid={Boolean(wrong) || undefined}
                            aria-describedby={wrong ? errorId : undefined}
                            value={draft.bounds![end][a]}
                            onChange={(e) => set({ bounds: { ...draft.bounds!, [end]: { ...draft.bounds![end], [a]: e.target.value } } })}
                          />
                          {wrong && (
                            <small id={errorId} className="error">
                              {wrong === "number" ? w.boundsNumber : w.boundsOrder}
                            </small>
                          )}
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </fieldset>
          <div className="fields">
            <SmoothingField value={draft.smoothing} onChange={(smoothing) => set({ smoothing })} />
            <label className="field" title={w.fadeHelp}>
              <span>{w.fade}</span>
              <MoveFadeInput automatic automaticValue={showFade} label={w.fade} value={draft.fade} onChange={(fade) => set({ fade })} pendingRef={pendingFade} />
            </label>
          </div>
          <div className="field">
            <span>{w.color}</span>
            <div className="swatches" role="radiogroup" aria-label={w.color}>
              <button type="button" className={`swatch none ${!draft.color ? "chosen" : ""}`} role="radio" aria-checked={!draft.color} title={w.noColor} aria-label={w.noColor} onClick={() => set({ color: undefined })} />
              {SWATCHES.map(([name, hex]) => (
                <button
                  type="button"
                  key={hex}
                  className={`swatch ${draft.color === hex ? "chosen" : ""}`}
                  role="radio"
                  aria-checked={draft.color === hex}
                  title={t.swatchNames[name as keyof typeof t.swatchNames]}
                  aria-label={t.swatchNames[name as keyof typeof t.swatchNames]}
                  style={{ background: hex }}
                  onClick={() => set({ color: hex })}
                />
              ))}
            </div>
          </div>
          {changedElsewhere && (
            <p className="warning" role="status">
              {w.changedElsewhere}
            </p>
          )}
          <div className="row">
            <button type="submit" className="primary">
              {t.save}
            </button>
            <button type="button" className="ghost" onClick={() => open(null)}>
              {t.close}
            </button>
            {problem && (
              <span className="error" role="alert">
                {problem}
              </span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
