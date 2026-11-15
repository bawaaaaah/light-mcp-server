/**
 * The Show page's « Positions » section (T32, lot 4; docs/specs/venue-fixtures-stage.md, « Positions nommées »): the
 * show's named positions with their colour, how many heads they cover (or their point), « rappelée » while heads hold
 * one, and « à revoir » when one is stale. Each is recalled, renamed and recoloured (a point moved), saved again from
 * the heads held by hand, deleted (asking when something uses it), and its earlier versions put back. A stale one
 * offers the three choices of decision Q4: recompute it from the point it was aimed at, adjust it by hand (its heads
 * recalled, a pad each, then saved), or keep it as it is. Nothing is corrected silently.
 */
import { useId, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { can, cmd, type Role } from "../api";
import { useMe, useT } from "../App";
import { useMotionHeads } from "../hooks/useMotionHeads";
import { headNames, holding, storedOf, usePositions, type PositionRow } from "../hooks/usePositions";
import type { Point3 } from "../hooks/useTargets";
import { recallPosition } from "../positionRecall";
import { metresText } from "../target-status";
import { quoted } from "../typography";
import { confirmDelete } from "./confirmDelete";
import { showLockToast } from "./MotionLockButton";
import { SwatchPicker } from "./SwatchPicker";
import { Versions } from "./Versions";
import { XyPad } from "./XyPad";

type Axis = "x" | "y" | "z";
const AXES: readonly Axis[] = ["x", "y", "z"];
const metres = (v: string): number => (v.trim() === "" ? NaN : Number(v.replace(",", ".")));

interface SaveReply {
  position: PositionRow;
  captured?: string[];
}
interface RefreshReply {
  position: PositionRow;
  refreshed: string[];
  unreachable?: { fixture: string; error: string }[];
  notAimed?: string[];
}

export function PositionsPanel({ onError }: { onError: (message: string) => void }): ReactElement {
  const t = useT();
  const w = t.positions;
  const me = useMe() as Role | null;
  const may = (right: string) => (me ? can(me, right) : false);
  const { positions, loaded } = usePositions();
  const { heads } = useMotionHeads();
  const [editing, setEditing] = useState<string | null>(null);
  /** The stale position being adjusted by hand, and the heads recalled for it. */
  const [byHand, setByHand] = useState<{ id: string; heads: string[] } | null>(null);
  const installed = new Set(heads.map((h) => h.id));
  const m = (v: number) => metresText(v, t.decimalMark);
  const fail = (e: unknown) => onError((e as Error).message);

  const resave = (p: PositionRow, then?: () => void) =>
    void cmd<SaveReply>("position.preset.save", { id: p.id })
      .then((r) => {
        showLockToast(w.resaved.replace("{name}", () => quoted(t, p.name)).replace("{names}", () => headNames(r.position, r.captured ?? [])));
        then?.();
      })
      // P3: refused when no head of it is held by hand; the reason goes in the toast, where the eye is
      .catch((e: Error) => showLockToast(e.message));
  const refresh = (p: PositionRow, how: "recompute" | "keep") =>
    void cmd<RefreshReply>("position.preset.refresh", { id: p.id, how })
      .then((r) => {
        const said = [r.refreshed.length ? (how === "recompute" ? w.recomputed : w.kept).replace("{names}", () => headNames(r.position, r.refreshed)) : ""];
        if (r.unreachable?.length) said.push(w.unreachable.replace("{names}", () => r.unreachable!.map((u) => `${headNames(p, [u.fixture])} (${u.error})`).join(", ")));
        if (r.notAimed?.length) said.push(w.notAimed.replace("{names}", () => headNames(p, r.notAimed!)));
        showLockToast(said.filter(Boolean).join(" · "));
      })
      .catch((e: Error) => showLockToast(e.message));
  const adjustByHand = (p: PositionRow) => {
    const stale = p.stale.filter((h) => installed.has(h));
    // the heads to review go to the position first: the pad starts from where it puts them
    void recallPosition(t, p.id, p.name, (id) => headNames(p, [id]), stale).then((recalled) => recalled.length && setByHand({ id: p.id, heads: recalled }));
  };

  return (
    <div className="positions-panel">
      <p className="hint">{w.help}</p>
      {loaded && positions.length === 0 && <p className="hint">{w.none}</p>}
      <ul className="position-list">
        {positions.map((p) => {
          const holds = holding(p.id, heads);
          const covered = p.kind === "point" ? heads.length : p.covers.filter((c) => installed.has(c.id)).length;
          const stale = p.stale.length > 0;
          return (
            <li key={p.id} className="position-row" data-position={p.id} style={p.color ? ({ "--position-color": p.color } as CSSProperties) : undefined}>
              <div className="position-line">
                <span className="position-swatch" aria-hidden="true" />
                <strong>{p.name}</strong>
                <small>
                  {p.kind === "point"
                    ? w.pointAt.replace("{x}", () => m(p.point!.x)).replace("{y}", () => m(p.point!.y)).replace("{z}", () => m(p.point!.z))
                    : p.covers.length === 1
                      ? w.headCountOne
                      : w.headCountMany.replace("{n}", () => String(p.covers.length))}
                </small>
                {holds.length > 0 && (
                  <span className="badge recalled" data-testid="position-recalled">
                    ● {holds.length === covered ? w.recalledBadge : w.recalledPart.replace("{n}", String(holds.length)).replace("{m}", String(covered))}
                  </span>
                )}
                {stale && (
                  <span className="badge stale" title={w.staleHelp} data-testid="position-stale">
                    ⚠ {w.stale}
                  </span>
                )}
                <span className="grow" />
                {may("commands:position") && (
                  <button title={w.recallHelp} aria-label={w.recallName.replace("{name}", () => p.name)} onClick={() => void recallPosition(t, p.id, p.name, (id) => headNames(p, [id]))}>
                    {w.recall}
                  </button>
                )}
                {may("show:write") && (
                  <>
                    <button aria-label={w.editing.replace("{name}", () => p.name)} aria-expanded={editing === p.id} onClick={() => setEditing(editing === p.id ? null : p.id)}>
                      {w.edit}
                    </button>
                    {p.kind === "pantilt" && (
                      <button title={w.resaveHelp} aria-label={w.resaveName.replace("{name}", () => p.name)} onClick={() => resave(p)}>
                        {w.resave}
                      </button>
                    )}
                    <button className="ghost position-delete" aria-label={w.deleteName.replace("{name}", () => p.name)} title={w.deleteName.replace("{name}", () => p.name)} onClick={() => void confirmDelete("position", p.id, p.name, t).catch(fail)}>
                      ✕
                    </button>
                  </>
                )}
              </div>
              {stale && (
                <div className="position-stale" role="group" aria-label={`${w.choices} ${p.name}`}>
                  <p className="warning">
                    {w.staleHeads.replace("{names}", () => headNames(p, p.stale))}
                    <br />
                    <small>{w.staleHelp}</small>
                  </p>
                  {may("show:write") && (
                    <div className="row position-choices">
                      <button title={p.aim ? w.recomputeHelp : w.recomputeNone} disabled={!p.aim} aria-describedby={p.aim ? undefined : `${p.id}-norecompute`} onClick={() => refresh(p, "recompute")}>
                        {w.recompute}
                      </button>
                      {may("commands:position") && (
                        <button title={w.byHandHelp} aria-expanded={byHand?.id === p.id} onClick={() => (byHand?.id === p.id ? setByHand(null) : adjustByHand(p))}>
                          {w.byHand}
                        </button>
                      )}
                      <button title={w.keepHelp} onClick={() => refresh(p, "keep")}>
                        {w.keep}
                      </button>
                      {!p.aim && (
                        <small className="hint" id={`${p.id}-norecompute`}>
                          {w.recomputeNone}
                        </small>
                      )}
                    </div>
                  )}
                </div>
              )}
              {p.missing.length > 0 && <p className="hint">{w.missing.replace("{names}", () => headNames(p, p.missing))}</p>}
              {byHand?.id === p.id && (
                <div className="position-by-hand">
                  <p className="hint">{w.byHandHelp}</p>
                  <div className="position-pads">
                    {byHand.heads.map((h) => (
                      <XyPad key={h} fixture={h} label={headNames(p, [h])} onError={onError} />
                    ))}
                  </div>
                  <div className="row">
                    <button className="primary" onClick={() => resave(p, () => setByHand(null))}>
                      {w.byHandSave}
                    </button>
                    <button className="ghost" onClick={() => setByHand(null)}>
                      {t.close}
                    </button>
                  </div>
                </div>
              )}
              {editing === p.id && <PositionEditForm key={p.id} position={p} onClose={() => setEditing(null)} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Rename, recolour, move a point; earlier versions. Written whole by position.preset.put (a save would capture the heads). */
function PositionEditForm({ position: p, onClose }: { position: PositionRow; onClose: () => void }): ReactElement {
  const t = useT();
  const w = t.positions;
  const id = useId();
  const [name, setName] = useState(p.name);
  const [color, setColor] = useState(p.color);
  const [point, setPoint] = useState<Record<Axis, string> | null>(p.point ? { x: String(p.point.x), y: String(p.point.y), z: String(p.point.z) } : null);
  const [problem, setProblem] = useState("");
  const form = useRef<HTMLFormElement | null>(null);
  const save = async () => {
    if (!name.trim()) return setProblem(w.nameRequired);
    let moved: Point3 | undefined;
    if (point) {
      const wrong = AXES.find((a) => !Number.isFinite(metres(point[a])));
      if (wrong) {
        form.current?.querySelector<HTMLInputElement>(`input[data-axis="${wrong}"]`)?.focus();
        return setProblem(w.pointNumber);
      }
      moved = { x: metres(point.x), y: metres(point.y), z: metres(point.z) };
    }
    try {
      await cmd("position.preset.put", { position: storedOf(p, { name: name.trim(), color: color ?? null, ...(moved ? { point: moved } : {}) }) });
      onClose();
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  return (
    <form
      ref={form}
      id={id}
      className="position-form"
      aria-label={w.editing.replace("{name}", () => quoted(t, p.name))}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="field">
        <span>{t.name}</span>
        <input value={name} aria-required="true" autoFocus onChange={(e) => (setName(e.target.value), setProblem(""))} />
      </label>
      {point && (
        <fieldset>
          <legend>{w.pointNow}</legend>
          <div className="position-point">
            {AXES.map((a) => (
              <label key={a} className="field">
                <span>{w.pointAxis.replace("{axis}", a.toUpperCase())}</span>
                <input type="text" inputMode="decimal" data-axis={a} value={point[a]} onChange={(e) => (setPoint({ ...point, [a]: e.target.value }), setProblem(""))} />
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <SwatchPicker label={w.color} noneLabel={w.noColor} value={color} onChange={setColor} />
      <Versions collection="positions" id={p.id} help={w.versionsHelp} onRestored={onClose} />
      <div className="row">
        <button type="submit" className="primary">
          {t.save}
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          {t.close}
        </button>
        {problem && (
          <span className="error" role="alert">
            {problem}
          </span>
        )}
      </div>
    </form>
  );
}
