import { useState } from "react";
import { useT } from "../App";
import { labelOf } from "../util";
import { useFloatingMenu } from "./menu";
import { rectPolygon, zoneRect } from "../zone-shape";
import type { PlanZone } from "./StagePlan";

/**
 * Right-click (or a long press) on a zone of the stage plan: its name, type, sizes (a rectangle as
 * the Lieu page draws it), floor, protected and no-aim; saved by « Enregistrer », or deleted.
 */
export function ZoneMenu({ zone, at, onSave, onDelete, onClose }: { zone: PlanZone; at: { x: number; y: number }; onSave: (zone: PlanZone) => void; onDelete: () => void; onClose: () => void }) {
  const t = useT();
  const { box, style } = useFloatingMenu(at, onClose);
  const rect = zoneRect(zone.polygon);
  const [draft, setDraft] = useState({
    name: zone.name,
    type: zone.type,
    floor: String(zone.floorHeight),
    protected: zone.protected,
    noAim: Boolean(zone.noAim),
    ...(rect ? { width: String(rect.width), depth: String(rect.depth), x: String(rect.x), y: String(rect.y) } : {}),
  });
  const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  const save = () => {
    const polygon = rect ? rectPolygon(num(draft.width, rect.width), num(draft.depth, rect.depth), num(draft.x, rect.x), num(draft.y, rect.y)) : zone.polygon;
    onSave({ ...zone, name: draft.name.trim() || zone.name, type: draft.type, floorHeight: num(draft.floor, zone.floorHeight), protected: draft.protected, noAim: draft.noAim, polygon });
    onClose();
  };
  const sizes = rect ? ([["width", t.zoneWidth], ["depth", t.zoneDepth], ["x", t.zoneCentreX], ["y", t.zoneFrontY]] as const) : [];
  return (
    <div ref={box} className="widget-menu zone-menu" role="dialog" aria-label={t.zoneMenu} style={style} onContextMenu={(e) => e.preventDefault()}>
      <h3>{zone.name}</h3>
      <label className="field">
        <span>{t.zoneName}</span>
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
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
            <input type="number" step={0.1} aria-label={label} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
          </label>
        ))}
        <label className="field">
          <span>{t.zoneFloor}</span>
          <input type="number" step={0.1} aria-label={t.zoneFloor} value={draft.floor} onChange={(e) => setDraft({ ...draft, floor: e.target.value })} />
        </label>
      </div>
      {!rect && <small className="hint">{t.zoneNotRect}</small>}
      <label className="row">
        <input type="checkbox" checked={draft.protected} onChange={(e) => setDraft({ ...draft, protected: e.target.checked })} /> {t.protectedZone}
      </label>
      <label className="row" title={t.noAimHelp}>
        <input type="checkbox" checked={draft.noAim} onChange={(e) => setDraft({ ...draft, noAim: e.target.checked })} /> {t.noAimZone}
      </label>
      <div className="row">
        <button className="primary" onClick={save}>
          {t.save}
        </button>
        <button className="danger" onClick={() => confirm(`${t.delete} « ${zone.name} » ?`) && (onDelete(), onClose())}>
          {t.delete}
        </button>
        <span className="grow" />
        <button onClick={onClose}>{t.close}</button>
      </div>
    </div>
  );
}
