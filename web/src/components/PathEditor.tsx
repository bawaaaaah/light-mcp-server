/**
 * The look editor's « Zone » and « Parcours » modes of the move (T28; docs/specs/ui-dashboards.md, « Éditeur d'effets »,
 * docs/specs/engine-effects-timing.md, « Parcours »):
 * - **Zone**: one button per aiming zone (a search list beyond eight); a press aims the look's heads at it (`at.zone`).
 * - **Parcours**: the same buttons add a stop, so do a click on the small plan (a zone, or a point elsewhere), « + Point »
 *   (X/Y/Z), « + Position nommée » and « + Cible »; the stops are reordered by dragging **and** by ↑ / ↓ (touch, keyboard),
 *   with a weight in weighted order and a height for a zone stop; order, part spent travelling, heads together,
 *   staggered (with the move's reverse and shuffle) or each its own. The plan draws the path statically (no animation:
 *   the look's preview is colours only; the real move is seen on the Live's stage); the stops a head cannot reach and
 *   the warnings (speed rule, no-aim zone) come from look.preview, computed by the server as the render does.
 */
import { useId, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactElement } from "react";
import { useT } from "../App";
import { SearchPicker } from "./SearchPicker";
import { stageFrame, stageLayout, type StageXY } from "../stage-frame";
import { aimSpot, zoneAt } from "../zone-shape";
import { placeLabels, textWidth } from "../plan-tools";
import { radioTabIndex } from "../radio-keys";
import { onRadioKey } from "../radio-group";
import { moveStop, typedNumber } from "../path-edit";
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
/** look.preview's `path` (T28): each stop for each head (`gone`: the last name of what it names, deleted), and the warnings. */
export interface PathReport {
  stops: { name: string; gone?: string; heads: { id: string; pan?: number; tilt?: number; error?: string }[] }[];
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
/** The bounds of a stop's fields (the server's schema): what is typed beyond is brought back, never refused in English. */
export const HEIGHT_MAX = 30;
export const WEIGHT_MAX = 100;
const clampTo = (v: number, max: number): number => Math.min(max, Math.max(0, v));

/**
 * The names of the zones, positions and targets seen in this session: one deleted since is still said by its name
 * (« Zone supprimée (Balcon) »), like the targets' and positions' stores do.
 */
const lastNames = new Map<string, string>();
const remember = (kind: string, rows: readonly { id: string; name: string }[]) => {
  for (const r of rows) lastNames.set(`${kind}:${r.id}`, r.name);
};
/** The last name known of a zone, position or target (`kind`), else the server's (`gone`), else its id. */
export const lastName = (kind: "zone" | "position" | "target", id: string, gone?: string): string => lastNames.get(`${kind}:${id}`) ?? gone ?? id;
export const rememberZones = (zones: readonly PathZone[]): void => remember("zone", zones);

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

/** What look.preview says before playing (a path's, or a look aimed at a zone's): the list, or nothing. */
export function PathWarnings({ report }: { report: PathReport | undefined }): ReactElement | null {
  const t = useT();
  const warnings = report?.warnings ?? [];
  if (!warnings.length) return null;
  return (
    <div className="path-warnings" role="status" data-testid="path-warnings">
      <strong>
        <span aria-hidden="true">⚠ </span>
        {t.paths.warnings}
      </strong>
      <ul>
        {warnings.map((w, k) => (
          <li key={k} data-kind={w.kind}>
            {w.message}
          </li>
        ))}
      </ul>
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
  move: stagger,
  onMove,
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
  /** The move's reverse and shuffle: they order the staggered heads (`decales`). */
  move: { reverse: boolean; shuffle?: boolean | undefined };
  onMove: (patch: { reverse?: boolean; shuffle?: boolean | undefined }) => void;
}): ReactElement {
  const t = useT();
  const p = t.paths;
  const id = useId();
  const [adding, setAdding] = useState<"point" | "position" | "target" | null>(null);
  // the point as typed: « -3 » or « 1, » stays as typed until it is added (converted then, refused when not a number)
  const [point, setPoint] = useState({ x: "0", y: "2", z: "0" });
  const [pointError, setPointError] = useState(false);
  const [said, setSaid] = useState("");
  const dragged = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const list = useRef<HTMLOListElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const zoneById = useMemo(() => new Map(zones.map((z) => [z.id, z])), [zones]);
  remember("zone", zones);
  remember("position", positions);
  remember("target", targets);
  const headName = (h: string) => heads.find((x) => x.id === h)?.name ?? fixtures.find((f) => f.id === h)?.name ?? h;
  const round = (v: number) => String(Math.round(v * 100) / 100).replace(".", t.decimalMark);

  const stopName = (s: PathStopDraft, i?: number): string => {
    const gone = i === undefined ? undefined : report?.stops[i]?.gone;
    if (s.zone !== undefined) {
      const z = zoneById.get(s.zone);
      return z ? p.stopZone.replace("{name}", () => z.name) : p.zoneGoneStop.replace("{name}", () => lastName("zone", s.zone!, gone));
    }
    if (s.position !== undefined) {
      const x = positions.find((r) => r.id === s.position);
      return x ? p.stopPosition.replace("{name}", () => x.name) : p.positionGoneStop.replace("{name}", () => lastName("position", s.position!, gone));
    }
    if (s.target !== undefined) {
      const x = targets.find((r) => r.id === s.target);
      return x ? p.stopTarget.replace("{name}", () => x.name) : p.targetGoneStop.replace("{name}", () => lastName("target", s.target!, gone));
    }
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
  /** A stop that names something still there but has no place on the floor: a pan/tilt named position. */
  const offPlan = (s: PathStopDraft): boolean => s.position !== undefined && positions.some((x) => x.id === s.position) && !spotOf(s);

  const set = (patch: Partial<PathDraft>) => onChange({ ...path, ...patch });
  const add = (stop: PathStopDraft) => {
    if (path.stops.length >= 32) return;
    set({ stops: [...path.stops, stop] });
    setSaid(p.added.replace("{n}", String(path.stops.length + 1)).replace("{name}", () => stopName(stop)));
  };
  const rowButton = (row: number, cls: string) => list.current?.querySelectorAll<HTMLElement>(":scope > li")[row]?.querySelector<HTMLButtonElement>(cls) ?? null;
  const move = (from: number, to: number, focus = true) => {
    if (to < 0 || to >= path.stops.length) return;
    set({ stops: moveStop(path.stops, from, to) });
    setSaid(p.moved.replace("{from}", String(from + 1)).replace("{to}", String(to + 1)));
    // the focus follows the stop moved by the keyboard or a finger (its button in its new row); at the first or last
    // row that button is disabled: the other one of the row, never the page's body
    if (focus)
      requestAnimationFrame(() => {
        const same = rowButton(to, from > to ? ".path-stop-up" : ".path-stop-down");
        (same && !same.disabled ? same : rowButton(to, from > to ? ".path-stop-down" : ".path-stop-up"))?.focus();
      });
  };
  const remove = (i: number) => {
    const left = path.stops.length - 1;
    set({ stops: path.stops.filter((_, k) => k !== i) });
    setSaid(p.removed.replace("{n}", String(i + 1)));
    // the focus on the ✕ of the row before (the first row's when it was the first), or the list's heading once empty
    requestAnimationFrame(() => (left > 0 ? rowButton(Math.max(0, i - 1), ".path-stop-remove") : heading.current)?.focus());
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
  const addPoint = () => {
    const [x, y, z] = [typedNumber(point.x), typedNumber(point.y), typedNumber(point.z)];
    if (x === undefined || y === undefined || z === undefined) {
      setPointError(true);
      return;
    }
    setPointError(false);
    add({ point: { x, y, z } });
  };

  const reach = (i: number): string | undefined => {
    const row = report?.stops[i];
    if (!row || !row.heads.length) return undefined;
    const failing = row.heads.filter((h) => h.error !== undefined);
    if (!failing.length) return undefined;
    return failing.length === row.heads.length ? p.nowhere : p.unreachable.replace("{names}", () => failing.map((h) => headName(h.id)).join(", "));
  };
  const headsMode = (m: PathHeads) => m === "chacune" && !drawnOrder(path.order);

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
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            addPoint();
          }}
        >
          {(["x", "y", "z"] as const).map((axis) => (
            <label key={axis} className="field">
              <span>{axis === "x" ? p.pointX : axis === "y" ? p.pointY : p.pointZ}</span>
              <input type="text" inputMode="decimal" value={point[axis]} aria-invalid={pointError && typedNumber(point[axis]) === undefined} data-testid={`path-point-${axis}`} onChange={(e) => setPoint({ ...point, [axis]: e.target.value })} />
            </label>
          ))}
          <button type="submit" data-testid="path-point-add">
            {p.add}
          </button>
          {pointError && (
            <small className="error" role="alert">
              {p.pointInvalid}
            </small>
          )}
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

      <h4 id={`${id}-stops`} ref={heading} tabIndex={-1} data-testid="path-stops-heading">
        {p.stops}
      </h4>
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
                  <span>{stopName(s, i)}</span>
                  {offPlan(s) && <small className="hint path-stop-offplan">{p.noPlace}</small>}
                  {cut && (
                    <small className="path-stop-cut">
                      <span aria-hidden="true">⚠ </span>
                      {cut}
                    </small>
                  )}
                </span>
                {s.zone !== undefined && (
                  <label className="path-stop-field" title={p.heightHelp}>
                    <small>{p.heightShort}</small>
                    <input
                      className="path-stop-height"
                      type="number"
                      min={0}
                      max={HEIGHT_MAX}
                      step={0.1}
                      aria-label={p.heightOf.replace("{n}", String(n))}
                      placeholder={zoneById.get(s.zone)?.aim?.height !== undefined ? String(zoneById.get(s.zone)!.aim!.height) : p.heightPlaceholder}
                      value={s.height ?? ""}
                      onChange={(e) => patchStop(i, { height: e.target.value === "" || !Number.isFinite(Number(e.target.value)) ? undefined : clampTo(Number(e.target.value), HEIGHT_MAX) })}
                    />
                  </label>
                )}
                {path.order === "weighted" && (
                  <label className="path-stop-field">
                    <small>{p.weight}</small>
                    <input
                      className="path-stop-weight"
                      type="number"
                      min={0}
                      max={WEIGHT_MAX}
                      step={1}
                      aria-label={p.weightOf.replace("{n}", String(n))}
                      value={s.weight ?? 1}
                      onChange={(e) => patchStop(i, { weight: e.target.value === "" || !Number.isFinite(Number(e.target.value)) ? undefined : clampTo(Number(e.target.value), WEIGHT_MAX) })}
                    />
                  </label>
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
      {path.order === "weighted" && path.stops.length > 0 && path.stops.every((s) => (s.weight ?? 1) <= 0) && (
        <p className="error" role="alert">
          {p.weightsZero}
        </p>
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
          <div className="move-aim-choices" role="radiogroup" aria-labelledby={`${id}-heads`} onKeyDown={(e) => onRadioKey(e, (k) => set({ heads: HEAD_MODES[k]! }))}>
            {HEAD_MODES.map((m, k) => {
              const off = headsMode(m);
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={path.heads === m}
                  tabIndex={radioTabIndex(path.heads === m, k, true)}
                  data-testid={`path-heads-${m}`}
                  title={off ? p.chacuneOnlyRandom : p.headsHelp[m]}
                  aria-disabled={off || undefined}
                  className={off ? "muted" : undefined}
                  onClick={() => !off && set({ heads: m })}
                >
                  {p.headModes[m]}
                </button>
              );
            })}
          </div>
          <small className="hint">{headsMode(path.heads) ? p.chacuneOnlyRandom : p.headsHelp[path.heads]}</small>
        </fieldset>
        {path.heads === "decales" && (
          // the staggered heads take their order from the move's reverse and shuffle (engine/path.ts stopOffset)
          <div className="row path-stagger" data-testid="path-stagger">
            <label className="row">
              <input type="checkbox" checked={stagger.reverse} onChange={(e) => onMove({ reverse: e.target.checked })} /> {t.fields.reverse}
            </label>
            <label className="row" title={t.shuffleHelp}>
              <input type="checkbox" checked={Boolean(stagger.shuffle)} onChange={(e) => onMove({ shuffle: e.target.checked || undefined })} /> {t.fields.shuffle}
            </label>
          </div>
        )}
      </div>

      <PathPlan
        path={path}
        zones={zones}
        fixtures={fixtures}
        spots={path.stops.map(spotOf)}
        onAddZone={(z) => add({ zone: z })}
        onAddPoint={(xy) => add({ point: { x: Math.round(xy.x * 100) / 100, y: Math.round(xy.y * 100) / 100, z: typedNumber(point.z) ?? 0 } })}
      />
      <PathWarnings report={report} />
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

/** The plan's font size, in its own units (a 320 wide drawing): never under 12 px where it is shown. */
const PLAN_FONT = 12;
/** A zone's name on the plan: a no-aim zone marked. */
const zoneLabel = (z: PathZone): string => (z.noAim ? `⛔ ${z.name}` : z.name);

/**
 * The small plan of a path (top view, upstage at the top, `stage-frame.ts`): the zones (a no-aim zone dashed in the
 * danger colour), the placed heads, and the stops numbered in order, joined by arrows in loop and ping-pong (a drawn
 * order only numbers them; a trip through a stop with no place on the floor is dashed). The zones' names never overlap
 * (`placeLabels`). A click in an aiming zone adds the zone, elsewhere a point.
 */
function PathPlan({ path, zones, fixtures, spots, onAddZone, onAddPoint }: { path: PathDraft; zones: readonly PathZone[]; fixtures: readonly PlanFixture[]; spots: readonly (StageXY | undefined)[]; onAddZone: (zone: string) => void; onAddPoint: (xy: StageXY) => void }): ReactElement {
  const t = useT();
  const p = t.paths;
  const marker = useId().replace(/:/g, "");
  const spotKey = spots.map((s) => (s ? `${s.x},${s.y}` : "-")).join(";");
  const placed = useMemo(() => fixtures.filter((f) => f.position), [fixtures]);
  const layout = useMemo(
    () => stageLayout(placed, zones, spots.filter((s): s is StageXY => s !== undefined)),
    // the spots as a key: a new array each render, the same points
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [placed, zones, spotKey],
  );
  const W = 320;
  const frame = useMemo(() => stageFrame(layout, W, 140), [layout]);
  /** Each zone's name: where it is drawn (centred on its zone, never cut at the drawing's edge, never on another). */
  const labels = useMemo(() => {
    const top = (z: PathZone) => Math.min(...z.polygon.map(([, y]) => frame.sy(y)));
    const bottom = (z: PathZone) => Math.max(...z.polygon.map(([, y]) => frame.sy(y)));
    const xOf = new Map(
      zones.map((z) => {
        const half = textWidth(zoneLabel(z), PLAN_FONT) / 2;
        return [z.id, Math.min(W - half, Math.max(half, frame.sx(aimSpot(z).x)))];
      }),
    );
    const ys = placeLabels(
      zones.map((z) => ({ id: z.id, x: xOf.get(z.id)!, above: top(z) - 4, below: bottom(z) + PLAN_FONT + 2, width: textWidth(zoneLabel(z), PLAN_FONT) })),
      PLAN_FONT,
    );
    return new Map([...ys].map(([id, y]) => [id, { x: xOf.get(id)!, y }]));
  }, [zones, frame]);
  if (!zones.length && !placed.length) return <p className="hint">{p.planEmpty}</p>;
  const pts = (poly: readonly Pt[]) => poly.map(([x, y]) => `${frame.sx(x)},${frame.sy(y)}`).join(" ");
  // the trips, from a stop on the plan to the next one on the plan; dashed when a stop off the plan is skipped
  const joins: { a: StageXY; b: StageXY; skipped: boolean; key: string }[] = [];
  if (!drawnOrder(path.order) && spots.length > 1) {
    const order = path.order === "loop" ? [...spots.keys(), 0] : [...spots.keys()];
    let last: { at: StageXY; k: number } | undefined;
    let skipped = false;
    for (const [n, k] of order.entries()) {
      const s = spots[k];
      if (!s) {
        if (last) skipped = true;
        continue;
      }
      if (last && !(n === order.length - 1 && k === 0 && spots.length < 3 && !skipped)) joins.push({ a: last.at, b: s, skipped, key: `${n}` });
      last = { at: s, k };
      skipped = false;
    }
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
      <svg viewBox={`0 0 ${W} ${frame.H}`} role="img" aria-label={`${p.plan} : ${path.stops.length}`} data-testid="path-plan" onClick={click} style={{ fontSize: PLAN_FONT }}>
        <defs>
          <marker id={`${marker}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="path-arrow-head" />
          </marker>
        </defs>
        {zones.map((z) => {
          const at = labels.get(z.id);
          return (
            <g key={z.id} className={`path-plan-zone${z.noAim ? " no-aim" : ""}`} style={{ "--zone-color": z.aim?.color ?? "var(--muted)" } as CSSProperties}>
              <polygon points={pts(z.polygon)} />
              {at && (
                <text x={at.x} y={at.y} textAnchor="middle">
                  {zoneLabel(z)}
                </text>
              )}
              <title>{z.name}</title>
            </g>
          );
        })}
        {placed.map((f) => (
          <rect key={f.id} className="path-plan-head" x={frame.sx(f.position!.x) - 4} y={frame.sy(f.position!.y) - 4} width={8} height={8}>
            <title>{f.name}</title>
          </rect>
        ))}
        {joins.map(({ a, b, skipped, key }) =>
          a.x === b.x && a.y === b.y ? null : (
            <line
              key={key}
              className={`path-plan-trip${skipped ? " skipped" : ""}`}
              x1={frame.sx(a.x)}
              y1={frame.sy(a.y)}
              x2={frame.sx(b.x)}
              y2={frame.sy(b.y)}
              markerEnd={`url(#${marker}-arrow)`}
              {...(path.order === "pingpong" ? { markerStart: `url(#${marker}-arrow)` } : {})}
            />
          ),
        )}
        {spots.map((s, k) =>
          s ? (
            <g key={k} className="path-plan-stop">
              <circle cx={frame.sx(s.x)} cy={frame.sy(s.y)} r={9} />
              <text x={frame.sx(s.x)} y={frame.sy(s.y) + 4} textAnchor="middle">
                {k + 1}
              </text>
            </g>
          ) : null,
        )}
      </svg>
    </figure>
  );
}
