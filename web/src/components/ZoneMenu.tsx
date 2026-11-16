import { useId, useState, type ReactElement } from "react";
import { useT } from "../App";
import { labelOf } from "../util";
import { useFloatingMenu } from "./menu";
import { ellipsePolygon, rectPolygon, validZone, zoneRect, type Pt, type ZoneOutline } from "../zone-shape";
import { aimSpot, type PlanZone } from "./StagePlan";
import { SwatchPicker } from "./SwatchPicker";

/**
 * Right-click (or a long press) on a zone of the stage plan: its name, type, sizes (a rectangle as the Lieu page draws
 * it, an ellipse drawn on the plan by its axes, T27), floor, protected, no-aim and « Visée » (T27: an aiming zone, its
 * height, colour and aiming point); saved by « Enregistrer », or deleted (the page asks, saying what still uses it).
 * `creating`: a zone just drawn on the plan (T27), not yet saved: « Créer la zone », no delete, an aiming zone by default.
 */
export function ZoneMenu({
  zone,
  at,
  creating = false,
  onSave,
  onDelete,
  onClose,
}: {
  zone: PlanZone;
  at: { x: number; y: number };
  creating?: boolean;
  onSave: (zone: PlanZone) => void;
  onDelete?: () => void;
  onClose: () => void;
}): ReactElement {
  const t = useT();
  const w = t.zoneAim;
  const { box, style } = useFloatingMenu(at, onClose);
  const outline = zone.outline;
  // an ellipse by its axes; a rectangle by its sides (drawn as one, or read from its corners); a polygon as it is
  const ellipse = outline?.kind === "ellipse" ? outline : undefined;
  const rect = outline?.kind === "ellipse" || outline?.kind === "polygon" ? undefined : zoneRect(zone.polygon);
  const centre = aimSpot({ polygon: zone.polygon });
  const [draft, setDraft] = useState({
    name: zone.name,
    type: zone.type,
    floor: String(zone.floorHeight),
    protected: zone.protected,
    noAim: Boolean(zone.noAim),
    ...(rect ? { width: String(rect.width), depth: String(rect.depth), x: String(rect.x), y: String(rect.y) } : {}),
    ...(ellipse ? { ew: String(2 * ellipse.rx), ed: String(2 * ellipse.ry), ex: String(ellipse.cx), ey: String(ellipse.cy), rot: String(ellipse.rotation ?? 0) } : {}),
    aimOn: creating || Boolean(zone.aim),
    aimHeight: String(zone.aim?.height ?? 1.5),
    aimColor: zone.aim?.color,
    placed: Boolean(zone.aim?.point),
    px: String(zone.aim?.point?.[0] ?? Math.round(centre.x * 100) / 100),
    py: String(zone.aim?.point?.[1] ?? Math.round(centre.y * 100) / 100),
  });
  const [error, setError] = useState("");
  /** The ids of the aiming point's radios and of the section's help. */
  const radios = useId();
  const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  const save = () => {
    let polygon: Pt[] = zone.polygon;
    let drawn: ZoneOutline | undefined = outline;
    if (rect) polygon = rectPolygon(num(draft.width, rect.width), num(draft.depth, rect.depth), num(draft.x, rect.x), num(draft.y, rect.y));
    else if (ellipse) {
      const e = { cx: num(draft.ex, ellipse.cx), cy: num(draft.ey, ellipse.cy), rx: num(draft.ew, 2 * ellipse.rx) / 2, ry: num(draft.ed, 2 * ellipse.ry) / 2 };
      const rotation = num(draft.rot, ellipse.rotation ?? 0);
      polygon = e.rx > 0 && e.ry > 0 ? ellipsePolygon(e.cx, e.cy, e.rx, e.ry, rotation) : [];
      drawn = { kind: "ellipse", ...e, ...(rotation ? { rotation } : {}) };
    }
    if (!validZone(polygon)) return setError(w.invalid);
    const aim = draft.aimOn
      ? {
          height: Math.min(20, Math.max(0, num(draft.aimHeight, 1.5))),
          ...(draft.placed ? { point: [num(draft.px, centre.x), num(draft.py, centre.y)] as Pt } : {}),
          ...(draft.aimColor ? { color: draft.aimColor } : {}),
        }
      : undefined;
    const { aim: _aim, outline: _outline, ...rest } = zone;
    onSave({ ...rest, name: draft.name.trim() || zone.name, type: draft.type, floorHeight: num(draft.floor, zone.floorHeight), protected: draft.protected, noAim: draft.noAim, polygon, ...(drawn ? { outline: drawn } : {}), ...(aim ? { aim } : {}) });
    onClose();
  };
  const sizes = rect
    ? ([["width", t.zoneWidth], ["depth", t.zoneDepth], ["x", t.zoneCentreX], ["y", t.zoneFrontY]] as const)
    : ellipse
      ? ([["ew", w.ellipseWidth], ["ed", w.ellipseDepth], ["ex", w.ellipseX], ["ey", w.ellipseY], ["rot", w.rotation]] as const)
      : [];
  const title = creating ? t.zoneDraw.newZone : zone.name;
  return (
    <div ref={box} className="widget-menu zone-menu" role="dialog" aria-label={creating ? t.zoneDraw.newZone : t.zoneMenu} style={style} onContextMenu={(e) => e.preventDefault()}>
      <h3>{title}</h3>
      <label className="field">
        <span>{t.zoneName}</span>
        <input value={draft.name} autoFocus={creating} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </label>
      <label className="field">
        <span>{t.zoneType}</span>
        <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
          {Object.keys(t.zoneTypes).map((k) => (
            <option key={k} value={k}>
              {labelOf(t.zoneTypes, k)}
            </option>
          ))}
        </select>
      </label>
      <div className="zone-sizes">
        {sizes.map(([k, label]) => (
          <label key={k} className="field">
            <span>{label}</span>
            <input type="number" step={k === "rot" ? 15 : 0.1} aria-label={label} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
          </label>
        ))}
        <label className="field">
          <span>{t.zoneFloor}</span>
          <input type="number" step={0.1} aria-label={t.zoneFloor} value={draft.floor} onChange={(e) => setDraft({ ...draft, floor: e.target.value })} />
        </label>
      </div>
      {!rect && !ellipse && !creating && <small className="hint">{outline?.kind === "polygon" ? w.polygonHint : t.zoneNotRect}</small>}
      <label className="row">
        <input type="checkbox" checked={draft.protected} onChange={(e) => setDraft({ ...draft, protected: e.target.checked })} /> {t.protectedZone}
      </label>
      <label className="row" title={t.noAimHelp}>
        <input type="checkbox" checked={draft.noAim} onChange={(e) => setDraft({ ...draft, noAim: e.target.checked })} /> {t.noAimZone}
      </label>
      <fieldset className="zone-aim-section">
        <legend>{w.section}</legend>
        <label className="row">
          <input type="checkbox" checked={draft.aimOn} aria-describedby={`${radios}-help`} onChange={(e) => setDraft({ ...draft, aimOn: e.target.checked })} /> {w.isAim}
        </label>
        <small className="hint" id={`${radios}-help`}>
          {w.isAimHelp}
        </small>
        {draft.aimOn && (
          <>
            <label className="field">
              <span>{w.height}</span>
              <input type="number" min={0} max={20} step={0.1} aria-label={w.height} value={draft.aimHeight} onChange={(e) => setDraft({ ...draft, aimHeight: e.target.value })} />
            </label>
            <div className="aim-point" role="radiogroup" aria-labelledby={`${radios}-label`}>
              <span id={`${radios}-label`}>{w.point}</span>
              <span className="row">
                <label className="row">
                  <input type="radio" name={radios} checked={!draft.placed} onChange={() => setDraft({ ...draft, placed: false })} /> {w.centre}
                </label>
                <label className="row">
                  <input type="radio" name={radios} checked={draft.placed} onChange={() => setDraft({ ...draft, placed: true })} /> {w.placed}
                </label>
              </span>
            </div>
            {draft.placed && (
              <div className="zone-sizes">
                <label className="field">
                  <span>{w.pointX}</span>
                  <input type="number" step={0.1} aria-label={w.pointX} value={draft.px} onChange={(e) => setDraft({ ...draft, px: e.target.value })} />
                </label>
                <label className="field">
                  <span>{w.pointY}</span>
                  <input type="number" step={0.1} aria-label={w.pointY} value={draft.py} onChange={(e) => setDraft({ ...draft, py: e.target.value })} />
                </label>
              </div>
            )}
            <SwatchPicker label={w.color} noneLabel={t.noColor} value={draft.aimColor} onChange={(aimColor) => setDraft({ ...draft, aimColor })} />
          </>
        )}
      </fieldset>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button className="primary" disabled={creating && !draft.name.trim()} onClick={save}>
          {creating ? t.zoneDraw.create : t.save}
        </button>
        {!creating && onDelete && (
          <button className="danger" onClick={onDelete}>
            {t.delete}
          </button>
        )}
        <span className="grow" />
        <button onClick={onClose}>{creating ? t.cancel : t.close}</button>
      </div>
    </div>
  );
}
