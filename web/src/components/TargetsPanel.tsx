/**
 * The venue's « Cibles » section (T24, lot 4; docs/specs/venue-fixtures-stage.md, « Cible »): the show's 3D targets,
 * listed under the stage plan, created, edited and deleted here — name, the moving heads that follow it (boxes) and/or
 * a group, bounds (the stage volume by default), smoothing of the point, how the heads arrive, colour. The point and
 * the engagement are live state: moved and engaged from the target pad, MIDI, OSC or the AI, never by this form.
 */
import { useCallback, useEffect, useId, useState, type ReactElement } from "react";
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
const AXES: readonly Axis[] = ["x", "y", "z"];
/** The bounds as typed: strings, so a field being typed (« -1, », empty) is not rewritten under the cursor. */
type BoundsText = Record<"min" | "max", Record<Axis, string>>;

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
/** The bounds typed, as numbers; undefined when one is not a number or a minimum is above its maximum. */
function parsedBounds(b: BoundsText): Box3 | undefined {
  const num = (v: string) => (v.trim() === "" ? NaN : Number(v.replace(",", ".")));
  const out = { min: { x: num(b.min.x), y: num(b.min.y), z: num(b.min.z) }, max: { x: num(b.max.x), y: num(b.max.y), z: num(b.max.z) } };
  return AXES.every((a) => Number.isFinite(out.min[a]) && Number.isFinite(out.max[a]) && out.min[a] <= out.max[a]) ? out : undefined;
}

export function TargetsPanel({ targets, onError, onChanged }: { targets: TargetRow[]; onError: (message: string) => void; onChanged: () => void }): ReactElement {
  const t = useT();
  const w = t.targets;
  const [heads, setHeads] = useState<Named[]>([]);
  const [groups, setGroups] = useState<Named[]>([]);
  const read = useCallback(() => {
    void cmd<Named[]>("position.list").then((list) => setHeads(list.map((h) => ({ id: h.id, name: h.name }))), () => undefined);
    void cmd<Named[]>("group.list").then((list) => setGroups(list.map((g) => ({ id: g.id, name: g.name }))), () => undefined);
  }, []);
  useEffect(read, [read]);
  useCommandEvents(["venue.", "group.", "show.", "import.", "history."], read);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState("");
  const formId = useId();
  // the target being edited deleted meanwhile (another screen, the AI): the form closes
  useEffect(() => {
    if (draft?.id && !targets.some((x) => x.id === draft.id)) setDraft(null);
  }, [targets, draft?.id]);

  const set = (patch: Partial<Draft>) => {
    setProblem("");
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };
  const save = async (): Promise<void> => {
    if (!draft) return;
    if (!draft.name.trim()) return setProblem(w.nameRequired);
    const bounds = draft.bounds ? parsedBounds(draft.bounds) : undefined;
    if (draft.bounds && !bounds) return setProblem(w.boundsInvalid);
    const id = draft.id ?? uniqueId(slug(draft.name, "cible"), targets.map((x) => x.id));
    const current = targets.find((x) => x.id === draft.id);
    try {
      await cmd("target.put", {
        target: {
          id,
          name: draft.name.trim(),
          fixtures: draft.fixtures,
          ...(draft.group ? { group: draft.group } : {}),
          ...(bounds ? { bounds } : {}),
          ...(draft.smoothing ? { smoothing: draft.smoothing } : {}),
          ...(draft.fade ? { fade: draft.fade } : {}),
          ...(draft.color ? { color: draft.color } : {}),
          ...(current?.notes ? { notes: current.notes } : {}),
        },
      });
      setDraft(null);
      onChanged();
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  const headCount = (n: number) => (n === 1 ? w.headCountOne : w.headCountMany.replace("{n}", () => String(n)));
  const m = (v: number) => metresText(v, t.decimalMark);

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
              <button aria-label={w.editing.replace("{name}", () => row.name)} title={w.editing.replace("{name}", () => row.name)} aria-expanded={draft?.id === row.id} aria-controls={draft?.id === row.id ? formId : undefined} onClick={() => (setProblem(""), setDraft(draftOf(row)))}>
                {t.edit}
              </button>
              <button
                className="ghost"
                aria-label={`${t.delete} ${row.name}`}
                title={`${t.delete} ${row.name}`}
                onClick={() => void confirmDelete("target", row.id, row.name, t).then((done) => done && onChanged(), (e: Error) => onError(e.message))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {!draft && (
        <button aria-expanded={false} onClick={() => (setProblem(""), setDraft({ name: "", fixtures: [], group: "", bounds: null }))}>
          + {w.add}
        </button>
      )}
      {draft && (
        <form
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
            <label title={w.stageVolumeHelp}>
              <input
                type="checkbox"
                checked={draft.bounds === null}
                onChange={(e) => {
                  const shown = targets.find((x) => x.id === draft.id)?.effectiveBounds ?? { min: { x: -5, y: 0, z: 0 }, max: { x: 5, y: 8, z: 4 } };
                  set({ bounds: e.target.checked ? null : boundsText(shown) });
                }}
              />{" "}
              {w.stageVolume}
            </label>
            <p className="hint">{w.stageVolumeHelp}</p>
            {draft.bounds && (
              <div className="target-bounds">
                {(["min", "max"] as const).flatMap((end) =>
                  AXES.map((a) => {
                    const label = (end === "min" ? w.boundsMin : w.boundsMax).replace("{axis}", a.toUpperCase());
                    return (
                      <label key={`${end}-${a}`}>
                        <span>{label}</span>
                        <input type="text" inputMode="decimal" aria-label={label} value={draft.bounds![end][a]} onChange={(e) => set({ bounds: { ...draft.bounds!, [end]: { ...draft.bounds![end], [a]: e.target.value } } })} />
                      </label>
                    );
                  }),
                )}
              </div>
            )}
          </fieldset>
          <div className="fields">
            <SmoothingField value={draft.smoothing} onChange={(smoothing) => set({ smoothing })} />
            <label className="field" title={w.fadeHelp}>
              <span>{w.fade}</span>
              <MoveFadeInput automatic label={w.fade} value={draft.fade} onChange={(fade) => set({ fade })} />
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
          <div className="row">
            <button type="submit" className="primary">
              {t.save}
            </button>
            <button type="button" className="ghost" onClick={() => setDraft(null)}>
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
