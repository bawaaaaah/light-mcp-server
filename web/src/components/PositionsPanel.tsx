/**
 * The Show page's « Positions » section (T32, lot 4; docs/specs/venue-fixtures-stage.md, « Positions nommées »): the
 * show's named positions with their colour, how many heads they cover (or their point), « rappelée » while heads hold
 * one, and « à revoir » when one is stale. Each is recalled, renamed and recoloured (a point moved), saved again from
 * the heads held by hand, deleted (asking when something uses it), and its earlier versions put back. A stale one
 * offers the three choices of decision Q4: recompute it from the point it was aimed at, adjust it by hand (its heads
 * recalled, a pad each, then only the heads adjusted there saved: decision Q-A of 2026-11-16), or keep it as it is.
 * Nothing is corrected silently. While heads hold one by hand, « Rendre la main » on its row lets them go (Q-B): a head
 * recalled to a position only on that one's row, a head set at a pad without a recall on every row covering it.
 */
import { useId, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { can, cmd, type Role } from "../api";
import { useMe, useT } from "../App";
import { useMotionHeads } from "../hooks/useMotionHeads";
import { headNames, holding, storedOf, usePositions, type PositionRow } from "../hooks/usePositions";
import { AXES, pointFields, pointOf, wrongAxis, type SaveReply } from "../positionForm";
import { recallPosition } from "../positionRecall";
import { metresText } from "../target-status";
import { quoted } from "../typography";
import { confirmDelete } from "./confirmDelete";
import { showLockToast } from "./MotionLockButton";
import { SwatchPicker } from "./SwatchPicker";
import { Versions } from "./Versions";
import { XyPad } from "./XyPad";

interface RefreshReply {
  position: PositionRow;
  refreshed: string[];
  unreachable?: { fixture: string; error: string }[];
  notAimed?: string[];
  leftAim?: string[];
}

export function PositionsPanel({ onError }: { onError: (message: string) => void }): ReactElement {
  const t = useT();
  const w = t.positions;
  const me = useMe() as Role | null;
  const may = (right: string) => (me ? can(me, right) : false);
  const { positions, loaded } = usePositions();
  const { heads, loaded: headsLoaded } = useMotionHeads();
  const [editing, setEditing] = useState<string | null>(null);
  /** The stale position being adjusted by hand, the heads recalled for it, and those moved at their pad since (Q-A). */
  const [byHand, setByHand] = useState<{ id: string; heads: string[]; touched: string[] } | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const uid = useId();
  const installed = new Set(heads.map((h) => h.id));
  const m = (v: number) => metresText(v, t.decimalMark);
  const fail = (e: unknown) => onError((e as Error).message);
  /** A head by its name: one the position covers, else any installed head (one it does not cover, said by a recall). */
  const nameIn = (p: PositionRow) => (id: string) => heads.find((h) => h.id === id)?.name ?? headNames(p, [id]);
  /** The focus back on a row's button once what it opened is closed. */
  const focusRow = (id: string, button: string) =>
    window.requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`li[data-position="${CSS.escape(id)}"] ${button}`)?.focus());

  const resave = (p: PositionRow) =>
    void cmd<SaveReply>("position.preset.save", { id: p.id })
      .then((r) => showLockToast(w.resaved.replace("{name}", () => quoted(t, p.name)).replace("{names}", () => headNames(r.position, r.captured ?? [])), "neutral"))
      // P3: refused when no head of it is held by hand; the reason goes in the toast, where the eye is
      .catch((e: Error) => showLockToast(e.message));
  /**
   * The heads moved at their pad in this panel and still held by hand there: one handed back to the pad (« Rendre la
   * main », « Retour au repos ») or whose write was refused is no longer an adjusted head, it is not saved.
   */
  const adjusted = (b: { touched: string[] }) => b.touched.filter((h) => heads.some((x) => x.id === h && x.manual !== null));
  /** « Enregistrer les lyres ajustées » (Q-A): only the heads adjusted in this panel and still held; refused when none is. */
  const saveAdjusted = (p: PositionRow) => {
    const touched = byHand?.id === p.id ? adjusted(byHand) : [];
    if (!touched.length) return showLockToast(w.byHandNone);
    void cmd<SaveReply>("position.preset.save", { id: p.id, fixtures: touched })
      .then((r) => {
        showLockToast(`${w.resaved.replace("{name}", () => quoted(t, p.name)).replace("{names}", () => headNames(r.position, r.captured ?? []))} · ${w.stillHeld}`, "neutral");
        setByHand(null);
        // the choices go with the last head to review: the focus then goes to the row's « Rappeler » (or « Modifier »)
        const stillStale = r.position.stale.some((h) => installed.has(h));
        focusRow(p.id, stillStale ? "button.position-by-hand-open" : "button.position-recall, button.position-edit");
      })
      .catch((e: Error) => showLockToast(e.message));
  };
  const closeByHand = (p: PositionRow) => {
    setByHand(null);
    // the heads recalled for it stay where they are, held by hand (Q-B): said, with the way to let them go
    showLockToast(w.stillHeld, "neutral");
    focusRow(p.id, "button.position-by-hand-open");
  };
  const refresh = (p: PositionRow, how: "recompute" | "keep") =>
    void cmd<RefreshReply>("position.preset.refresh", { id: p.id, how })
      .then((r) => {
        const said = [r.refreshed.length ? (how === "recompute" ? w.recomputed : w.kept).replace("{names}", () => headNames(r.position, r.refreshed)) : ""];
        if (r.leftAim?.length) said.push(w.leftAim.replace("{names}", () => headNames(p, r.leftAim!)));
        if (r.unreachable?.length) said.push(w.unreachable.replace("{names}", () => r.unreachable!.map((u) => `${headNames(p, [u.fixture])} (${u.error})`).join(", ")));
        if (r.notAimed?.length) said.push(w.notAimed.replace("{names}", () => headNames(p, r.notAimed!)));
        const text = said.filter(Boolean).join(" · ");
        // nothing refreshed and nothing to say: still said, never an empty toast
        showLockToast(text || w.nothingRefreshed, r.refreshed.length && !r.unreachable?.length && !r.notAimed?.length ? "neutral" : "alert");
      })
      .catch((e: Error) => showLockToast(e.message));
  const adjustByHand = (p: PositionRow) => {
    const stale = p.stale.filter((h) => installed.has(h));
    // the heads to review go to the position first: the pad starts from where it puts them
    void recallPosition(t, p.id, p.name, nameIn(p), stale).then((recalled) => recalled.length && setByHand({ id: p.id, heads: recalled, touched: [] }));
  };
  const touch = (h: string) => setByHand((b) => (b && !b.touched.includes(h) ? { ...b, touched: [...b.touched, h] } : b));
  /** « Rendre la main » (Q-B): the heads of the position held by hand let go, one claim down. */
  const handBack = (p: PositionRow, held: string[]) =>
    void cmd<{ refused?: string[] }>("position.releaseTop", { fixtures: held })
      .then((r) => {
        const freed = held.filter((h) => !r.refused?.includes(h));
        showLockToast(
          [freed.length ? w.handedBack.replace("{names}", () => headNames(p, freed)) : "", r.refused?.length ? w.refused.replace("{names}", () => headNames(p, r.refused!)) : ""].filter(Boolean).join(" · "),
          r.refused?.length ? "alert" : "neutral",
        );
      })
      .catch((e: Error) => showLockToast(e.message));

  return (
    <div className="positions-panel">
      <p className="hint">{w.help}</p>
      {loaded && positions.length === 0 && <p className="hint">{w.none}</p>}
      <ul className="position-list" ref={list}>
        {positions.map((p) => {
          const holds = holding(p.id, heads);
          const covered = p.kind === "point" ? heads.length : p.covers.filter((c) => installed.has(c.id)).length;
          // held by hand (Q-B, decision of 2026-11-16): a head recalled to a position is held by that one only; a head set
          // at a pad without a recall, by every pan/tilt position covering it
          const held = p.kind === "point" ? holds : heads.filter((h) => h.manual !== null && (h.recalled === p.id || (h.recalled === undefined && Object.hasOwn(p.values, h.id)))).map((h) => h.id);
          const stale = p.stale.length > 0;
          /** One of the three choices of Q4, its help written beside it (not only in a title) and read with the button. */
          const choice = (key: string, help: string, button: (describedBy: string) => ReactElement) => (
            <div className="position-choice">
              {button(`${uid}-${p.id}-${key}`)}
              <small className="hint" id={`${uid}-${p.id}-${key}`}>
                {help}
              </small>
            </div>
          );
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
                    <span aria-hidden="true">● </span>
                    {holds.length === covered ? w.recalledBadge : w.recalledPart.replace("{n}", String(holds.length)).replace("{m}", String(covered))}
                  </span>
                )}
                {stale && (
                  <span className="badge stale" title={w.staleHelp} data-testid="position-stale">
                    <span aria-hidden="true">⚠ </span>
                    {w.stale}
                  </span>
                )}
                <span className="grow" />
                {may("commands:position") && (
                  <button className="position-recall" title={w.recallHelp} aria-label={w.recallName.replace("{name}", () => p.name)} disabled={!headsLoaded} onClick={() => void recallPosition(t, p.id, p.name, nameIn(p))}>
                    {w.recall}
                  </button>
                )}
                {may("commands:position") && held.length > 0 && (
                  <button className="position-hand-back" title={w.handBackHelp} aria-label={w.handBackName.replace("{name}", () => p.name)} onClick={() => handBack(p, held)}>
                    {t.releaseTop}
                  </button>
                )}
                {may("show:write") && (
                  <>
                    <button className="position-edit" aria-label={w.editing.replace("{name}", () => p.name)} aria-expanded={editing === p.id} onClick={() => setEditing(editing === p.id ? null : p.id)}>
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
                    <div className="position-choices">
                      {choice("recompute", p.aim ? w.recomputeHelp : w.recomputeNone, (d) => (
                        <button aria-describedby={d} disabled={!p.aim} onClick={() => refresh(p, "recompute")}>
                          {w.recompute}
                        </button>
                      ))}
                      {may("commands:position") &&
                        choice("by-hand", w.byHandHelp, (d) => (
                          <button className="position-by-hand-open" aria-describedby={d} aria-expanded={byHand?.id === p.id} onClick={() => (byHand?.id === p.id ? closeByHand(p) : adjustByHand(p))}>
                            {w.byHand}
                          </button>
                        ))}
                      {choice("keep", w.keepHelp, (d) => (
                        <button aria-describedby={d} onClick={() => refresh(p, "keep")}>
                          {w.keep}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {p.missing.length > 0 && <p className="hint">{w.missing.replace("{names}", () => headNames(p, p.missing))}</p>}
              {byHand?.id === p.id && (
                <div className="position-by-hand">
                  <div className="position-pads">
                    {byHand.heads.map((h) => (
                      <XyPad key={h} fixture={h} label={headNames(p, [h])} onError={onError} onMoved={() => touch(h)} />
                    ))}
                  </div>
                  <p className="hint" data-testid="position-adjusted">
                    {adjusted(byHand).length ? w.byHandAdjusted.replace("{names}", () => headNames(p, adjusted(byHand))) : w.byHandNoneYet}
                  </p>
                  <div className="row">
                    <button className="primary" onClick={() => saveAdjusted(p)}>
                      {w.byHandSave}
                    </button>
                    <button className="ghost" onClick={() => closeByHand(p)}>
                      {t.close}
                    </button>
                  </div>
                </div>
              )}
              {editing === p.id && (
                <PositionEditForm
                  key={p.id}
                  position={p}
                  onClose={() => {
                    setEditing(null);
                    focusRow(p.id, "button.position-edit");
                  }}
                />
              )}
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
  // with the interface's decimal mark (« 1,5 » in French), as the row says it
  const [point, setPoint] = useState(() => (p.point ? pointFields(p.point, t.decimalMark) : null));
  const [problem, setProblem] = useState("");
  const form = useRef<HTMLFormElement | null>(null);
  const save = async () => {
    if (!name.trim()) return setProblem(w.nameRequired);
    if (point) {
      const wrong = wrongAxis(point);
      if (wrong) {
        form.current?.querySelector<HTMLInputElement>(`input[data-axis="${wrong}"]`)?.focus();
        return setProblem(w.pointNumber);
      }
    }
    const moved = point ? pointOf(point) : undefined;
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
      onKeyDown={(e) => {
        // Escape closes the form (its row's « Modifier » takes the focus back), not the page around it
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
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
