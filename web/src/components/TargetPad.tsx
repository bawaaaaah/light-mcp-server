/**
 * The target pad (T24, lot 4; docs/specs/ui-dashboards.md, « Cible 3D »): a dashboard widget that moves a 3D target
 * and engages it. On the left the stage seen from above (zones, the target's heads as dots, the other fixtures greyed,
 * the target's point as a reticle with its height); on the right a fader for Z, in metres across the target's bounds.
 * A drag sends target.set {x, y} at most every 40 ms (useThrottledSend, as the XY pad); « Engager » engages it, and a
 * second press puts it back on top (decision T-a). The status line says, from the motion layer, what each head does.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents } from "../hooks/useTopic";
import { useMotionHeads } from "../hooks/useMotionHeads";
import { useThrottledSend } from "../hooks/useThrottledSend";
import type { Point3, TargetRow } from "../hooks/useTargets";
import { fittedBox, pointerToDrawing, stageFrame, stageLayout } from "../stage-frame";
import { placeLabels, textWidth } from "../plan-tools";
import { metresText, targetHeads, targetParts, type TargetPart } from "../target-status";
import { FaderTrack } from "./FaderTrack";
import type { Texts } from "../i18n";

interface PadFixture {
  id: string;
  name: string;
  position?: { x: number; y: number; z: number };
  absent?: boolean;
}
interface PadZone {
  id: string;
  name: string;
  polygon: [number, number][];
  noAim?: boolean;
}

/** The drawing's width (units); its height follows the stage. */
const W = 400;
/** Sizes on screen (px), whatever the pad's size: the drawing's units are scaled back to them. */
const LABEL_PX = 11;
const HEAD_PX = 6;
const RING_PX = 11;
/** Keyboard steps (metres): an arrow, Shift + arrow. */
const STEP = 0.1;
const BIG_STEP = 1;

const cm = (v: number): number => Math.round(v * 100) / 100;
const clampTo = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const metres = (t: Texts, v: number): string => metresText(v, t.decimalMark);

/** The status line's words for one part (« 1 tenue, hors de portée : Spot 2 »). */
function partText(t: Texts, part: TargetPart): string {
  const n = part.names.length;
  const fill = (template: string) =>
    template
      .replace("{n}", () => String(n))
      .replace("{names}", () => part.names.join(", "))
      .replace("{reason}", () => part.reason ?? "");
  const w = t.targets;
  switch (part.state) {
    case "follows":
      return fill(n === 1 ? w.followsOne : w.followsMany);
    case "held":
      return fill(n === 1 ? w.heldOne : w.heldMany);
    case "manual":
      return fill(n === 1 ? w.manualOne : w.manualMany);
    case "released":
      return fill(n === 1 ? w.releasedOne : w.releasedMany);
    case "masked":
      return fill(n === 1 ? w.maskedOne : w.maskedMany);
    case "frozen":
      return fill(n === 1 ? w.frozenOne : w.frozenMany);
    case "waiting":
      return w.waiting;
    case "idle":
      return fill(n === 1 ? w.idleOne : w.idleMany);
  }
}

export function TargetPad({ target: row, label, onError, disabled = false, interactive = true }: {
  /** The target, as useTargets reads it. */
  target: TargetRow;
  label?: string;
  onError: (message: string) => void;
  /** No right to move the heads (commands:position): drawn, nothing sent. */
  disabled?: boolean;
  /** false while the dashboard is arranged: the presses are the grid's. */
  interactive?: boolean;
}): ReactElement {
  const t = useT();
  const name = label ?? row.name;
  const off = disabled || !interactive;
  const [fixtures, setFixtures] = useState<PadFixture[]>([]);
  const [zones, setZones] = useState<PadZone[]>([]);
  const readStage = useCallback(() => {
    void cmd<PadFixture[]>("venue.fixture.list").then(setFixtures, () => undefined);
    void cmd<PadZone[]>("stage.zone.list").then(setZones, () => undefined);
  }, []);
  useEffect(readStage, [readStage]);
  useCommandEvents(["venue.", "stage.", "show.open", "import.", "history."], readStage);

  const headIds = useMemo(() => row.heads.map((h) => h.id), [row.heads]);
  const { heads: motion, markGesture } = useMotionHeads({ fixtures: headIds });
  const states = targetHeads(
    row.heads.map((h) => ({ id: h.id, name: h.name, motion: motion.find((m) => m.id === h.id)?.motion ?? null })),
    row.id,
    row.engaged,
  );
  const parts = targetParts(states);
  const stateOf = new Map(states.map((s) => [s.id, s.state]));

  // the point shown: the one asked while a gesture is under way, else the server's
  const [local, setLocal] = useState<Point3 | null>(null);
  const [dragging, setDragging] = useState(false);
  const bounds = row.effectiveBounds;
  const point = local ?? row.point;
  const targetId = useRef(row.id);
  targetId.current = row.id;
  const sender = useThrottledSend<Partial<Point3>>(
    async (p) => {
      try {
        await cmd("target.set", { id: targetId.current, ...p });
      } catch (error) {
        onError((error as Error).message);
      }
    },
    { merge: (a, b) => ({ ...a, ...b }), onSettled: markGesture },
  );
  // the server's point once the gesture has landed: a remote move (MIDI, another screen) shows again
  useEffect(() => {
    if (!dragging && sender.idle()) setLocal(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new point from the server lets the asked one go
  }, [row.point.x, row.point.y, row.point.z]);
  useEffect(() => setLocal(null), [row.id]);

  const move = (p: Partial<Point3>): void => {
    if (off) return;
    const next = {
      x: cm(clampTo(p.x ?? point.x, bounds.min.x, bounds.max.x)),
      y: cm(clampTo(p.y ?? point.y, bounds.min.y, bounds.max.y)),
      z: cm(clampTo(p.z ?? point.z, bounds.min.z, bounds.max.z)),
    };
    setLocal(next);
    const changed: Partial<Point3> = {};
    for (const a of ["x", "y", "z"] as const) if (p[a] !== undefined) changed[a] = next[a];
    sender.send(changed);
    markGesture();
  };

  // the frame: the target's bounds, the zones and the placed fixtures (stage-frame.ts, as the venue's plan)
  // framed on what the point can reach and the target's own heads: the rest of the stage is cut at the edges
  const boundsZone = { polygon: [[bounds.min.x, bounds.min.y], [bounds.max.x, bounds.min.y], [bounds.max.x, bounds.max.y], [bounds.min.x, bounds.max.y]] as [number, number][] };
  const placed = fixtures.filter((f) => f.position && !f.absent);
  const layout = stageLayout(
    placed.filter((f) => headIds.includes(f.id)),
    [boundsZone],
  );
  const { H, sx, sy, toStage, scale } = stageFrame(layout, W, 120);
  const svg = useRef<SVGSVGElement>(null);
  // drawing units per screen pixel (the drawing is fitted whole in the pad): names and marks keep their size on screen
  const [unit, setUnit] = useState(1);
  useEffect(() => {
    const el = svg.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const k = Math.min(r.width / W, r.height / H);
      if (k > 0) setUnit(1 / k);
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [H]);
  const LABEL = LABEL_PX * unit;
  const activePointer = useRef<number | null>(null);
  const rectAtDown = useRef<DOMRect | null>(null);
  const fromEvent = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = rectAtDown.current ?? svg.current!.getBoundingClientRect();
    const { px, py } = pointerToDrawing(e, fittedBox(rect, W, H), W, H, { left: 0, top: 0 });
    return toStage(px, py);
  };
  const endPointer = (e: React.PointerEvent): void => {
    if (activePointer.current !== e.pointerId) return;
    activePointer.current = null;
    rectAtDown.current = null;
    setDragging(false);
  };
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    const by: Partial<Record<string, Partial<Point3>>> = {
      ArrowLeft: { x: point.x - step },
      ArrowRight: { x: point.x + step },
      ArrowUp: { y: point.y + step },
      ArrowDown: { y: point.y - step },
      PageUp: { z: point.z + step },
      PageDown: { z: point.z - step },
    };
    const p = by[e.key];
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    move(p);
  };

  const zSpan = bounds.max.z - bounds.min.z;
  const nz = zSpan > 0 ? (point.z - bounds.min.z) / zSpan : 0;
  const hintId = useId();
  const statusId = useId();

  const engage = (on: boolean): void => {
    void cmd("target.engage", { id: row.id, on }).catch((error: Error) => onError(error.message));
  };

  // the reticle and its height, then the zones' names, without overlap (plan-tools.ts)
  const rx = sx(point.x);
  const ry = sy(point.y);
  const ring = Math.max(RING_PX * unit, Math.min(2 * RING_PX * unit, 0.3 * scale));
  const heightText = `${t.targets.z} ${metres(t, point.z)} m`;
  const labels = placeLabels(
    [
      // the reticle itself first: no name is written over it
      { id: "#ring", x: rx, below: ry + 0.3 * LABEL, above: ry + 0.3 * LABEL, width: 3.2 * ring },
      { id: "#point", x: rx, below: ry + ring + LABEL * 1.1, above: ry - ring - LABEL * 0.4, width: textWidth(heightText, LABEL) },
      ...zones.map((z) => {
        const xs = z.polygon.map((p) => p[0]);
        const ys = z.polygon.map((p) => p[1]);
        const cx = sx((Math.min(...xs) + Math.max(...xs)) / 2);
        return { id: z.id, x: cx, below: sy(Math.min(...ys)) - 4, above: sy(Math.max(...ys)) + LABEL, width: textWidth(z.name, LABEL * 0.85) };
      }),
    ],
    LABEL,
  );
  const shown = (v: number) => metres(t, v);
  const where = t.targets.point.replace("{x}", () => shown(point.x)).replace("{y}", () => shown(point.y)).replace("{z}", () => shown(point.z));
  const line = row.heads.length ? parts.map((p) => partText(t, p)).join(" · ") : t.targets.noHeadsShort;

  return (
    <div className={`target-pad fill${dragging ? " dragging" : ""}`} data-engaged={row.engaged || undefined} data-testid="target-pad" style={row.color ? ({ "--target-color": row.color } as React.CSSProperties) : undefined}>
      <div className="target-pad-main">
        <svg
          ref={svg}
          className="target-pad-plan"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          role="slider"
          aria-label={t.targets.padLabel.replace("{name}", () => name)}
          aria-valuemin={bounds.min.x}
          aria-valuemax={bounds.max.x}
          aria-valuenow={cm(point.x)}
          aria-valuetext={where}
          aria-describedby={`${hintId} ${statusId}`}
          aria-disabled={off || undefined}
          tabIndex={off ? -1 : 0}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => {
            if (off || activePointer.current !== null || e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation(); // the dashboard grid does not take a drag that starts on the pad
            svg.current?.focus({ preventScroll: true });
            rectAtDown.current = e.currentTarget.getBoundingClientRect();
            activePointer.current = e.pointerId;
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
            move(fromEvent(e));
          }}
          onPointerMove={(e) => {
            if (activePointer.current === e.pointerId && !off) move(fromEvent(e));
          }}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        >
          <rect className="tp-ground" x={0} y={0} width={W} height={H} />
          {zones.map((z) => (
            <polygon key={z.id} className={z.noAim ? "tp-zone no-aim" : "tp-zone"} points={z.polygon.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ")} />
          ))}
          <rect className="tp-bounds" x={sx(bounds.min.x)} y={sy(bounds.max.y)} width={sx(bounds.max.x) - sx(bounds.min.x)} height={sy(bounds.min.y) - sy(bounds.max.y)} />
          {zones.map((z) => {
            const y = labels.get(z.id);
            if (y === undefined) return null;
            const xs = z.polygon.map((p) => p[0]);
            return (
              <text key={`n-${z.id}`} className="tp-zone-name" x={sx((Math.min(...xs) + Math.max(...xs)) / 2)} y={y} textAnchor="middle" style={{ fontSize: LABEL * 0.85 }}>
                {z.name}
              </text>
            );
          })}
          {placed.map((f) => {
            const state = stateOf.get(f.id);
            const p = f.position!;
            return state === undefined ? (
              <circle key={f.id} className="tp-fixture" cx={sx(p.x)} cy={sy(p.y)} r={HEAD_PX * 0.6 * unit} />
            ) : (
              <g key={f.id} className="tp-head" data-state={state} data-fixture={f.id}>
                <circle cx={sx(p.x)} cy={sy(p.y)} r={HEAD_PX * unit} />
                {/* a held or frozen head carries a mark, never the colour alone */}
                {(state === "held" || state === "frozen") && (
                  <text x={sx(p.x)} y={sy(p.y) + HEAD_PX * 0.6 * unit} textAnchor="middle" className="tp-head-mark" style={{ fontSize: HEAD_PX * 1.6 * unit }}>
                    {state === "held" ? "!" : "🔒"}
                  </text>
                )}
              </g>
            );
          })}
          <g className="tp-reticle" data-testid="target-reticle" transform={`translate(${rx} ${ry})`}>
            <circle r={ring} />
            <line x1={-ring * 1.6} x2={-ring * 0.45} y1={0} y2={0} />
            <line x1={ring * 0.45} x2={ring * 1.6} y1={0} y2={0} />
            <line y1={-ring * 1.6} y2={-ring * 0.45} x1={0} x2={0} />
            <line y1={ring * 0.45} y2={ring * 1.6} x1={0} x2={0} />
            <circle r={2.5 * unit} className="tp-reticle-dot" />
          </g>
          {labels.has("#point") && (
            <text className="tp-height" x={rx} y={labels.get("#point")} textAnchor="middle" style={{ fontSize: LABEL, strokeWidth: 3 * unit }}>
              {heightText}
            </text>
          )}
        </svg>
        <div className="fader target-z">
          <span className="value" aria-hidden="true">
            {shown(point.z)} m
          </span>
          <FaderTrack
            label={t.targets.zLabel.replace("{name}", () => name)}
            value={clampTo(nz, 0, 1)}
            disabled={off}
            interactive={!off}
            valueText={`${shown(point.z)} m`}
            keyStep={zSpan > 0 ? STEP / zSpan : STEP}
            onChange={(level) => move({ z: bounds.min.z + level * zSpan })}
          />
          <small aria-hidden="true">{t.targets.z}</small>
        </div>
      </div>
      <span id={hintId} className="sr-only">
        {t.targets.keysHelp}
      </span>
      <div className="target-pad-status" aria-live="polite" aria-atomic="true">
        <div className="target-pad-heading">
          <strong>{name}</strong>
          <small className="target-pad-where">{where}</small>
        </div>
        <small id={statusId} className="target-pad-line" data-testid="target-status" title={line}>
          {line}
        </small>
      </div>
      <div className="row target-pad-actions">
        <button
          className={row.engaged ? "on" : ""}
          aria-pressed={row.engaged}
          data-testid="target-engage"
          title={row.engaged ? t.targets.reengageHelp : t.targets.engageHelp}
          disabled={off}
          onClick={() => engage(true)}
        >
          <span aria-hidden="true">{row.engaged ? "◉ " : "◎ "}</span>
          {t.targets.engage}
        </button>
        <button data-testid="target-disengage" title={t.targets.disengageHelp} disabled={off || !row.engaged} onClick={() => engage(false)}>
          {t.targets.disengage}
        </button>
      </div>
    </div>
  );
}
