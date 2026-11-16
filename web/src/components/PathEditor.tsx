/**
 * The look editor's « Zone » and « Parcours » modes of the move (T28; docs/specs/ui-dashboards.md, « Éditeur d'effets »,
 * docs/specs/engine-effects-timing.md, « Parcours »):
 * - **Zone**: one button per aiming zone (a search list beyond eight); a press aims the look's heads at it (`at.zone`).
 * - **Parcours**: the same buttons add a stop, so do a click on the small plan (a zone, or a point elsewhere), « + Point »
 *   (X/Y/Z), « + Position nommée » and « + Cible »; the stops are reordered by dragging **and** by ↑ / ↓ (touch, keyboard),
 *   with a weight in weighted order and a height for a zone stop; order, part spent travelling, heads together,
 *   staggered or each its own. The plan draws the path statically (no animation: the look's preview is colours only;
 *   the real move is seen on the Live's stage); the stops a head cannot reach and the warnings (speed rule, no-aim zone
 *   crossed) come from look.preview, computed by the server as the render does.
 */
import { useId, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactElement } from "react";
import { useT } from "../App";
import { SearchPicker } from "./SearchPicker";
import { stageFrame, stageLayout, type StageXY } from "../stage-frame";
import { aimSpot, zoneAt } from "../zone-shape";
import type { PositionRow } from "../hooks/usePositions";
import type { TargetRow } from "../hooks/useTargets";

type Pt = [number, number];
export interface PathZone {
  id: string;
  name: string;
  polygon: Pt[];
  noAim?: boolean;
  aim?: { color?: string; height?: number; point?: Pt };
}
export interface PathStopDraft {
  zone?: string;
  point?: { x: number; y: number; z: number };
  position?: string;
  target?: string;
  height?: number;
  weight?: number;
}
export type PathOrder = "loop" | "pingpong" | "random" | "weighted";
export type PathHeads = "ensemble" | "decales" | "chacune";
export interface PathDraft {
  stops: PathStopDraft[];
  order: PathOrder;
  travel: number;
  heads: PathHeads;
}
/** look.preview's `path` (T28): each stop for each head, and the warnings. */
export interface PathReport {
  stops: { name: string; heads: { id: string; pan?: number; tilt?: number; error?: string }[] }[];
  warnings: { kind: string; message: string; stops: number[]; heads: string[]; zone?: string }[];
}
export interface PlanFixture {
  id: string;
  name: string;
  position?: { x: number; y: number; z: number };
}

export const NEW_PATH: PathDraft = { stops: [], order: "loop", travel: 0.5, heads: "ensemble" };
/** Up to this many zones, buttons; beyond, a list with a search. */
const ZONE_BUTTONS = 8;
const ORDERS: PathOrder[] = ["loop", "pingpong", "random", "weighted"];
const HEAD_MODES: PathHeads[] = ["ensemble", "decales", "chacune"];
const drawnOrder = (order: PathOrder) => order === "random" || order === "weighted";

/** A stop moved from `from` to `to`, the others in their order. Pure. */
export function moveStop<T>(stops: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= stops.length || to >= stops.length) return [...stops];
  const out = [...stops];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

/** The zone buttons (aiming zones only, in their colour): a press picks one (mode Zone) or adds a stop (mode Parcours). */
export function ZoneButtons({ zones, current, onPick, adding, disabled }: { zones: readonly PathZone[]; current?: string | undefined; onPick: (zone: PathZone) => void; adding: boolean; disabled?: boolean }): ReactElement {
  const t = useT();
  const p = t.paths;
  const aiming = zones.filter((z) => z.aim);
  if (!aiming.length) return <p className="hint">{p.zonesNone}</p>;
  if (aiming.length > ZONE_BUTTONS)
    return (
      <SearchPicker
        title={adding ? p.addZones : p.zonePick}
        currentLabel={p.zoneCurrent}
        disabled={disabled}
        items={aiming.map((z) => ({ key: z.id, label: z.name, ...(z.aim?.color ? { color: z.aim.color } : {}), current: !adding && current === z.id }))}
        onPick={(item) => onPick(aiming.find((z) => z.id === item.key)!)}
      />
    );
  return (
    <div className="path-zone-buttons" role="group" aria-label={adding ? p.addZones : p.zones} data-testid={adding ? "path-zone-add" : "look-zone-buttons"}>
      {aiming.map((z) => {
        const on = !adding && current === z.id;
        return (
          <button
            key={z.id}
            type="button"
            className={`path-zone${on ? " on" : ""}`}
            data-zone={z.id}
            disabled={disabled}
            {...(adding ? { "aria-label": p.addZone.replace("{name}", () => z.name) } : { "aria-pressed": on })}
            style={{ "--zone-color": z.aim?.color ?? "var(--aim-color)" } as CSSProperties}
            onClick={() => onPick(z)}
          >
            <i className="zone-chip-mark" aria-hidden="true" />
            {adding && <span aria-hidden="true">+ </span>}
            {z.name}
            {on && <span aria-hidden="true"> ✓</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The editor of a look's path: its stops, their order, the travel and the heads, with the plan and the warnings. */
export function PathEditor({
  path,
  onChange,
  zones,
  positions,
  targets,
  fixtures,
  report,
  heads,
}: {
  path: PathDraft;
  onChange: (path: PathDraft) => void;
  zones: readonly PathZone[];
  positions: readonly PositionRow[];
  targets: readonly TargetRow[];
  fixtures: readonly PlanFixture[];
  report: PathReport | undefined;
  /** The installed moving heads by id: their names in « out of reach of ». */
  heads: readonly { id: string; name: string }[];
}): ReactElement {
  const t = useT();
  const p = t.paths;
  const id = useId();
  const [adding, setAdding] = useState<"point" | "position" | "target" | null>(null);
  const [point, setPoint] = useState({ x: 0, y: 2, z: 0 });
  const [said, setSaid] = useState("");
  const dragged = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const list = useRef<HTMLOListElement | null>(null);
  const zoneById = useMemo(() => new Map(zones.map((z) => [z.id, z])), [zones]);
  const headName = (h: string) => heads.find((x) => x.id === h)?.name ?? fixtures.find((f) => f.id === h)?.name ?? h;
  const round = (v: number) => String(Math.round(v * 100) / 100).replace(".", t.decimalMark);

  const stopName = (s: PathStopDraft): string => {
    if (s.zone !== undefined) return p.stopZone.replace("{name}", () => zoneById.get(s.zone!)?.name ?? p.stopGone.replace("{id}", () => s.zone!));
    if (s.position !== undefined) return p.stopPosition.replace("{name}", () => positions.find((x) => x.id === s.position)?.name ?? p.stopGone.replace("{id}", () => s.position!));
    if (s.target !== undefined) return p.stopTarget.replace("{name}", () => targets.find((x) => x.id === s.target)?.name ?? p.stopGone.replace("{id}", () => s.target!));
    if (s.point)
      return p.stopPoint
        .replace("{x}", () => round(s.point!.x))
        .replace("{y}", () => round(s.point!.y))
        .replace("{z}", () => round(s.point!.z));
    return "?";
  };
  /** Where a stop is on the plan (X/Y), if it has a place there. */
  const spotOf = (s: PathStopDraft): StageXY | undefined => {
    if (s.zone !== undefined) {
      const z = zoneById.get(s.zone);
      return z ? aimSpot(z) : undefined;
    }
    if (s.point) return { x: s.point.x, y: s.point.y };
    if (s.position !== undefined) return positions.find((x) => x.id === s.position)?.point;
    if (s.target !== undefined) return targets.find((x) => x.id === s.target)?.point;
    return undefined;
  };

  const set = (patch: Partial<PathDraft>) => onChange({ ...path, ...patch });
  const add = (stop: PathStopDraft) => {
    if (path.stops.length >= 32) return;
    set({ stops: [...path.stops, stop] });
    setSaid(p.added.replace("{n}", String(path.stops.length + 1)).replace("{name}", () => stopName(stop)));
  };
  const move = (from: number, to: number, focus = true) => {
    if (to < 0 || to >= path.stops.length) return;
    set({ stops: moveStop(path.stops, from, to) });
    setSaid(p.moved.replace("{from}", String(from + 1)).replace("{to}", String(to + 1)));
    // the focus follows the stop moved by the keyboard or a finger (its button in its new row)
    if (focus) requestAnimationFrame(() => list.current?.querySelectorAll<HTMLElement>("li")[to]?.querySelector<HTMLElement>(from > to ? ".path-stop-up" : ".path-stop-down")?.focus());
  };
  const remove = (i: number) => {
    set({ stops: path.stops.filter((_, k) => k !== i) });
    setSaid(p.removed.replace("{n}", String(i + 1)));
  };
  const patchStop = (i: number, patch: Partial<PathStopDraft>) => set({ stops: path.stops.map((s, k) => (k === i ? strip({ ...s, ...patch }) : s)) });

  const onDragStart = (i: number) => (e: DragEvent<HTMLLIElement>) => {
    dragged.current = i;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(i));
  };
  const onDrop = (i: number) => (e: DragEvent<HTMLLIElement>) => {
    e.preventDefault();
    const from = dragged.current;
    dragged.current = null;
    setOver(null);
    if (from !== null) move(from, i, false);
  };

  const warnings = report?.warnings ?? [];
  const reach = (i: number): string | undefined => {
    const row = report?.stops[i];
    if (!row || !row.heads.length) return undefined;
    const failing = row.heads.filter((h) => h.error !== undefined);
    if (!failing.length) return undefined;
    return failing.length === row.heads.length ? p.nowhere : p.unreachable.replace("{names}", () => failing.map((h) => headName(h.id)).join(", "));
  };

  return (
    <div className="path-editor" data-testid="path-editor">
      <p className="hint">{p.shapeFixed}</p>
      <ZoneButtons zones={zones} adding onPick={(z) => add({ zone: z.id })} />
      <div className="row path-add">
        {(["point", "position", "target"] as const).map((k) => (
          <button key={k} type="button" aria-expanded={adding === k} aria-controls={`${id}-${k}`} data-testid={`path-add-${k}`} className={adding === k ? "on" : undefined} onClick={() => setAdding((a) => (a === k ? null : k))}>
            {k === "point" ? p.addPoint : k === "position" ? p.addPosition : p.addTarget}
          </button>
        ))}
      </div>
      {adding === "point" && (
        <form
          id={`${id}-point`}
          className="row path-point"
          onSubmit={(e) => {
            e.preventDefault();
            add({ point: { ...point } });
          }}
        >
          {(["x", "y", "z"] as const).map((axis) => (
            <label key={axis} className="field">
              <span>{axis === "x" ? p.pointX : axis === "y" ? p.pointY : p.pointZ}</span>
              <input type="number" step={0.1} value={point[axis]} data-testid={`path-point-${axis}`} onChange={(e) => Number.isFinite(Number(e.target.value)) && setPoint({ ...point, [axis]: Number(e.target.value) })} />
            </label>
          ))}
          <button type="submit" data-testid="path-point-add">
            {p.add}
          </button>
        </form>
      )}
      {adding === "position" && (
        <div id={`${id}-position`}>
          {positions.length ? (
            <SearchPicker title={p.addPosition} focusOnOpen items={positions.map((x) => ({ key: x.id, label: x.name, ...(x.color ? { color: x.color } : {}), detail: x.kind === "point" ? t.positions.kindPoint : x.covers.length === 1 ? t.positions.headCountOne : t.positions.headCountMany.replace("{n}", () => String(x.covers.length)) }))} onPick={(item) => add({ position: item.key })} />
          ) : (
            <p className="hint">{t.positions.pickNone}</p>
          )}
        </div>
      )}
      {adding === "target" && (
        <div id={`${id}-target`}>
          {targets.length ? <SearchPicker title={p.addTarget} focusOnOpen items={targets.map((x) => ({ key: x.id, label: x.name }))} onPick={(item) => add({ target: item.key })} /> : <p className="hint">{t.targets.pickNone}</p>}
        </div>
      )}

      <h4 id={`${id}-stops`}>{p.stops}</h4>
      {path.stops.length === 0 ? (
        <p className="hint" data-testid="path-stops-none">
          {p.stopsNone}
        </p>
      ) : (
        <ol className="path-stops" ref={list} aria-labelledby={`${id}-stops`} data-testid="path-stops">
          {path.stops.map((s, i) => {
            const n = i + 1;
            const cut = reach(i);
            return (
              <li
                key={i}
                className={`path-stop${over === i ? " over" : ""}`}
                data-testid="path-stop"
                draggable
                onDragStart={onDragStart(i)}
                onDragOver={(e) => (e.preventDefault(), setOver(i))}
                onDragLeave={() => setOver((o) => (o === i ? null : o))}
                onDragEnd={() => (setOver(null), (dragged.current = null))}
                onDrop={onDrop(i)}
              >
                <span className="path-stop-grip" title={p.drag} aria-hidden="true">
                  ⠿
                </span>
                <span className="path-stop-n" aria-hidden="true">
                  {n}
                </span>
                <span className="path-stop-name">
                  <span>{stopName(s)}</span>
                  {cut && (
                    <small className="path-stop-cut">
                      <span aria-hidden="true">⚠ </span>
                      {cut}
                    </small>
                  )}
                </span>
                {s.zone !== undefined && (
                  <input
                    className="path-stop-height"
                    type="number"
                    min={0}
                    max={30}
                    step={0.1}
                    aria-label={p.heightOf.replace("{n}", String(n))}
                    title={p.heightHelp}
                    placeholder={zoneById.get(s.zone)?.aim?.height !== undefined ? String(zoneById.get(s.zone)!.aim!.height) : p.heightPlaceholder}
                    value={s.height ?? ""}
                    onChange={(e) => patchStop(i, { height: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })}
                  />
                )}
                {path.order === "weighted" && (
                  <input className="path-stop-weight" type="number" min={0} max={100} step={1} aria-label={p.weightOf.replace("{n}", String(n))} value={s.weight ?? 1} onChange={(e) => patchStop(i, { weight: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })} />
                )}
                <button type="button" className="path-stop-up" aria-label={p.up.replace("{n}", String(n))} title={p.up.replace("{n}", String(n))} disabled={i === 0} onClick={() => move(i, i - 1)}>
                  ↑
                </button>
                <button type="button" className="path-stop-down" aria-label={p.down.replace("{n}", String(n))} title={p.down.replace("{n}", String(n))} disabled={i === path.stops.length - 1} onClick={() => move(i, i + 1)}>
                  ↓
                </button>
                <button type="button" className="path-stop-remove danger" aria-label={p.remove.replace("{n}", String(n))} title={p.remove.replace("{n}", String(n))} onClick={() => remove(i)}>
                  ✕
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>

      <div className="fields path-settings">
        <label className="field">
          <span>{p.order}</span>
          <select value={path.order} data-testid="path-order" onChange={(e) => set({ order: e.target.value as PathOrder })}>
            {ORDERS.map((o) => (
              <option key={o} value={o}>
                {p.orders[o]}
              </option>
            ))}
          </select>
        </label>
        <label className="field" title={p.travelHelp}>
          <span>
            {p.travel} · {Math.round(path.travel * 100)} %
          </span>
          <input type="range" min={0} max={1} step={0.05} value={path.travel} data-testid="path-travel" onChange={(e) => set({ travel: Number(e.target.value) })} />
        </label>
        <fieldset className="move-aim field">
          <legend id={`${id}-heads`}>{p.heads}</legend>
          <div className="move-aim-choices" role="radiogroup" aria-labelledby={`${id}-heads`}>
            {HEAD_MODES.map((m) => {
              const off = m === "chacune" && !drawnOrder(path.order);
              return (
                <button key={m} type="button" role="radio" aria-checked={path.heads === m} data-testid={`path-heads-${m}`} title={off ? p.chacuneOnlyRandom : p.headsHelp[m]} aria-disabled={off || undefined} className={off ? "muted" : undefined} onClick={() => !off && set({ heads: m })}>
                  {p.headModes[m]}
                </button>
              );
            })}
          </div>
          <small className="hint">{path.heads === "chacune" && !drawnOrder(path.order) ? p.chacuneOnlyRandom : p.headsHelp[path.heads]}</small>
        </fieldset>
      </div>

      <PathPlan path={path} zones={zones} fixtures={fixtures} spotOf={spotOf} onAddZone={(z) => add({ zone: z })} onAddPoint={(xy) => add({ point: { x: Math.round(xy.x * 100) / 100, y: Math.round(xy.y * 100) / 100, z: point.z } })} />

      {warnings.length > 0 && (
        <div className="path-warnings" role="status" data-testid="path-warnings">
          <strong>
            <span aria-hidden="true">⚠ </span>
            {p.warnings}
          </strong>
          <ul>
            {warnings.map((w, k) => (
              <li key={k} data-kind={w.kind}>
                {w.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A stop without the fields left empty (a height or weight cleared). */
function strip(s: PathStopDraft): PathStopDraft {
  const out = { ...s };
  if (out.height === undefined) delete out.height;
  if (out.weight === undefined) delete out.weight;
  return out;
}

/**
 * The small plan of a path (top view, upstage at the top, `stage-frame.ts`): the zones (a no-aim zone dashed in the
 * danger colour), the placed heads, and the stops numbered in order, joined by arrows in loop and ping-pong (a drawn
 * order only numbers them). A click in an aiming zone adds the zone, elsewhere a point.
 */
function PathPlan({ path, zones, fixtures, spotOf, onAddZone, onAddPoint }: { path: PathDraft; zones: readonly PathZone[]; fixtures: readonly PlanFixture[]; spotOf: (s: PathStopDraft) => StageXY | undefined; onAddZone: (zone: string) => void; onAddPoint: (xy: StageXY) => void }): ReactElement {
  const t = useT();
  const p = t.paths;
  const marker = useId().replace(/:/g, "");
  const spots = path.stops.map(spotOf);
  const placed = fixtures.filter((f) => f.position);
  const layout = useMemo(() => stageLayout(placed, zones, spots.filter((s): s is StageXY => s !== undefined)), [placed, zones, spots]);
  const W = 320;
  const frame = stageFrame(layout, W, 140);
  if (!zones.length && !placed.length) return <p className="hint">{p.planEmpty}</p>;
  const pts = (poly: readonly Pt[]) => poly.map(([x, y]) => `${frame.sx(x)},${frame.sy(y)}`).join(" ");
  const joins: [number, number][] = [];
  if (!drawnOrder(path.order)) {
    for (let k = 0; k + 1 < spots.length; k++) joins.push([k, k + 1]);
    if (path.order === "loop" && spots.length > 2) joins.push([spots.length - 1, 0]);
  }
  const click = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const r = svg.getBoundingClientRect();
    const xy = frame.toStage(((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * frame.H);
    const zone = zoneAt(zones, xy);
    if (zone?.aim) onAddZone(zone.id);
    else onAddPoint(xy);
  };
  return (
    <figure className="path-plan">
      <figcaption>
        {p.plan} <small className="hint">{p.planHelp}</small>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${frame.H}`} role="img" aria-label={`${p.plan} : ${path.stops.length}`} data-testid="path-plan" onClick={click}>
        <defs>
          <marker id={`${marker}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="path-arrow-head" />
          </marker>
        </defs>
        {zones.map((z) => (
          <g key={z.id} className={`path-plan-zone${z.noAim ? " no-aim" : ""}`} style={{ "--zone-color": z.aim?.color ?? "var(--muted)" } as CSSProperties}>
            <polygon points={pts(z.polygon)} />
            {/* above the zone's outline: the stops' numbers sit on its aiming point */}
            <text x={frame.sx(aimSpot(z).x)} y={Math.min(...z.polygon.map(([, y]) => frame.sy(y))) - 4} textAnchor="middle">
              {z.noAim ? `⛔ ${z.name}` : z.name}
            </text>
          </g>
        ))}
        {placed.map((f) => (
          <rect key={f.id} className="path-plan-head" x={frame.sx(f.position!.x) - 4} y={frame.sy(f.position!.y) - 4} width={8} height={8}>
            <title>{f.name}</title>
          </rect>
        ))}
        {joins.map(([a, b]) => {
          const [from, to] = [spots[a], spots[b]];
          if (!from || !to || (from.x === to.x && from.y === to.y)) return null;
          return <line key={`${a}-${b}`} className="path-plan-trip" x1={frame.sx(from.x)} y1={frame.sy(from.y)} x2={frame.sx(to.x)} y2={frame.sy(to.y)} markerEnd={`url(#${marker}-arrow)`} {...(path.order === "pingpong" ? { markerStart: `url(#${marker}-arrow)` } : {})} />;
        })}
        {spots.map((s, k) =>
          s ? (
            <g key={k} className="path-plan-stop">
              <circle cx={frame.sx(s.x)} cy={frame.sy(s.y)} r={8} />
              <text x={frame.sx(s.x)} y={frame.sy(s.y) + 3.5} textAnchor="middle">
                {k + 1}
              </text>
            </g>
          ) : null,
        )}
      </svg>
    </figure>
  );
}
