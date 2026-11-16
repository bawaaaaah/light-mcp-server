/**
 * The target pad (T24, lot 4; docs/specs/ui-dashboards.md, « Cible 3D »): a dashboard widget that moves a 3D target
 * and engages it. On the left the stage seen from above (zones, the target's heads as dots, the other fixtures greyed,
 * the target's point as a reticle with its height); on the right a fader for Z, in metres across the target's bounds.
 * A drag sends target.set {x, y} at most every 40 ms (useThrottledSend, as the XY pad); « Engager » engages it, and a
 * second press puts it back on top (decision T-a). The status line says, from the motion layer, what each head does.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useMotionHeads } from "../hooks/useMotionHeads";
import { useThrottledSend } from "../hooks/useThrottledSend";
import { targetsStore, useTarget, type Point3, type TargetRow } from "../hooks/useTargets";
import { fittedBox, pointerToDrawing, stageFrame, stageLayout } from "../stage-frame";
import { placeLabels, textWidth } from "../plan-tools";
import { aimSpot, zoneAt, type Pt } from "../zone-shape";
import { metresText, targetHeads, targetParts, type TargetPart } from "../target-status";
import { holdText } from "../hold-text";
import { FaderTrack } from "./FaderTrack";
import type { Texts } from "../i18n";

export interface PadFixture {
  id: string;
  name: string;
  position?: { x: number; y: number; z: number };
  absent?: boolean;
}
export interface PadZone {
  id: string;
  name: string;
  polygon: Pt[];
  noAim?: boolean;
  /** An aiming zone (T27): a tap in it puts the target on its aiming point (`target.zone`). */
  aim?: { height: number; point?: Pt; color?: string };
}

/** The drawing's width (units); its height follows the stage. */
const W = 400;
/** Sizes on screen (px), whatever the pad's size: the drawing's units are scaled back to them. */
const LABEL_PX = 12;
const HEAD_PX = 6;
const RING_PX = 11;
/** How far (px) a press in an aiming zone may wander and still be a tap (to the zone) rather than a drag (free). */
const TAP_SLOP_PX = 8;
/** The aiming point's mark of an aiming zone (px). */
const AIM_MARK_PX = 5;
/** Keyboard steps (metres): an arrow; Shift + arrow and Page up / Page down (the height, as on the Z fader). */
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
      .replace("{reason}", () => part.reason ?? "")
      .replace("{by}", () => part.by ?? t.targets.stronger);
  const w = t.targets;
  const one = n === 1;
  switch (part.state) {
    case "follows":
      return fill(one ? w.followsOne : w.followsMany);
    case "held":
      return fill(one ? w.heldOne : w.heldMany);
    case "manual":
      return fill(one ? w.manualOne : w.manualMany);
    case "released":
      return fill(one ? w.releasedOne : w.releasedMany);
    case "resting":
      return fill(one ? w.restingOne : w.restingMany);
    case "masked":
      return fill(one ? w.maskedOne : w.maskedMany);
    case "frozen":
      return fill(one ? w.frozenOne : w.frozenMany);
    case "waiting":
      return w.waiting;
    case "idle":
      return fill(one ? w.idleOne : w.idleMany);
  }
}

/** A padlock drawn in the plan (a frozen head): a vector glyph, legible at any size, unlike an emoji. */
function Padlock({ x, y, size }: { x: number; y: number; size: number }): ReactElement {
  const s = size / 10;
  return (
    <g className="tp-head-lock" transform={`translate(${x} ${y}) scale(${s})`}>
      <path d="M-2.6 -1 v-1.6 a2.6 2.6 0 0 1 5.2 0 v1.6" fill="none" strokeWidth={1.4} />
      <rect x={-3.6} y={-1} width={7.2} height={5.4} rx={1} />
    </g>
  );
}

type Write = { id: string; point: Partial<Point3> };

/**
 * The widget of a target in a dashboard: its pad, or why it has none (no target chosen, the target deleted — said by
 * its last known name). Keyed by the target's id by the caller: another target is another pad, its send loop included.
 */
export function TargetWidget({ id, label, stage, onError, disabled = false, interactive = true }: {
  id: string | undefined;
  label?: string;
  stage: { fixtures: PadFixture[]; zones: PadZone[] };
  onError: (message: string) => void;
  disabled?: boolean;
  interactive?: boolean;
}): ReactElement {
  const t = useT();
  const { row, loaded } = useTarget(id);
  if (!id) return <div className="fill missing">{t.targets.unbound}</div>;
  if (!row) return <div className="fill missing">{loaded ? t.targets.missing.replace("{name}", () => targetsStore.lastName(id)) : "…"}</div>;
  return <TargetPad target={row} label={label} stage={stage} onError={onError} disabled={disabled} interactive={interactive} />;
}

export function TargetPad({ target: row, label, stage, onError, disabled = false, interactive = true }: {
  /** The target, as target.list reads it. */
  target: TargetRow;
  label?: string;
  /** The venue's fixtures and zones, read once by the page for all its pads. */
  stage: { fixtures: PadFixture[]; zones: PadZone[] };
  onError: (message: string) => void;
  /** No right to move the heads (commands:position): drawn, nothing sent. */
  disabled?: boolean;
  /** false while the dashboard is arranged: the presses are the grid's (nothing is disabled: the widget is still dragged). */
  interactive?: boolean;
}): ReactElement {
  const t = useT();
  const name = label ?? row.name;
  const off = disabled || !interactive;
  const { fixtures, zones } = stage;

  const headIds = useMemo(() => row.heads.map((h) => h.id), [row.heads]);
  // the status line reads light:motion (pushed as it changes): no gesture polling of position.list for this pad
  const { heads: motion } = useMotionHeads({ fixtures: headIds });
  const states = targetHeads(
    row.heads.map((h) => ({ id: h.id, name: h.name, motion: motion.find((m) => m.id === h.id)?.motion ?? null })),
    row.id,
    row.engaged,
    { reason: (a) => holdText(t, a), softLock: t.targets.softLock },
  );
  const parts = targetParts(states);
  const stateOf = new Map(states.map((s) => [s.id, s.state]));

  // the point shown: the one asked while a gesture is under way (or its writes are on the wire), else the server's
  const [local, setLocal] = useState<Point3 | null>(null);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const bounds = row.effectiveBounds;
  const point = local ?? row.point;
  const sender = useThrottledSend<Write>(
    async ({ id, point: p }) => {
      try {
        // each write carries the target it was made for (captured at the gesture), never the one shown now
        const reply = await cmd<{ id: string; point: Point3 }>("target.set", { id, ...p });
        if (reply?.point) targetsStore.patchPoint(id, reply.point);
      } catch (error) {
        setLocal(null); // the reticle goes back to the server's point, not left on the one refused
        onError((error as Error).message);
      }
    },
    {
      // the axes of one target go out together; a write for another target is never folded into it
      merge: (a, b) => (a.id === b.id ? { id: b.id, point: { ...a.point, ...b.point } } : b),
      onSettled: () => letGo(),
    },
  );
  /** The gesture is over and its writes have landed: the server's point (patched from target.set's answer) shows again. */
  const letGo = (): void => {
    if (!draggingRef.current && sender.idle()) setLocal(null);
  };
  // a new read of the target (a remote move: MIDI, another screen) shows once no gesture of this pad is under way
  useEffect(letGo, [row]); // eslint-disable-line react-hooks/exhaustive-deps -- a new row, whatever changed in it

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
    sender.send({ id: row.id, point: changed });
  };

  // the frame: what the point can reach (the bounds), the target's own placed heads and its point (stage-frame.ts, as
  // the venue's plan): the rest of the stage is cut at the edges
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
  /**
   * A press in an aiming zone (T27, lot 4): a tap until it wanders TAP_SLOP_PX, then a drag. A tap puts the target on the
   * zone's aiming point (target.zone, its height included); a drag stays a free move. Alt / Option: the exact point.
   */
  const tap = useRef<{ zone: PadZone; x: number; y: number } | null>(null);
  /** « Point exact » (decision P-d): a tap in an aiming zone is a free move, as with Alt / Option. */
  const [exact, setExact] = useState(false);
  /** The keyboard's Enter outside any aiming zone: a short hint, said (aria-live), gone after a moment. */
  const [keyHint, setKeyHint] = useState("");
  useEffect(() => {
    if (!keyHint) return;
    const timer = window.setTimeout(() => setKeyHint(""), 2500);
    return () => window.clearTimeout(timer);
  }, [keyHint]);
  /** The aiming zone drawn on top at a stage point, if the zone on top is one. */
  const aimZoneAt = (p: { x: number; y: number }): PadZone | undefined => {
    const z = zoneAt(zones, p);
    return z?.aim ? z : undefined;
  };
  const toZone = async (zone: PadZone): Promise<void> => {
    if (off) return;
    try {
      // a drag's last write still on the wire lands first, then the zone's point wins
      await sender.drop();
      const reply = await cmd<{ id: string; point: Point3 }>("target.zone", { id: row.id, zone: zone.id });
      if (reply?.point) targetsStore.patchPoint(row.id, reply.point);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      // the server's point shows again, unless a new gesture began meanwhile
      letGo();
    }
  };
  const endPointer = (e: React.PointerEvent): void => {
    if (activePointer.current !== e.pointerId) return;
    activePointer.current = null;
    rectAtDown.current = null;
    const tapped = e.type === "pointerup" ? tap.current?.zone : undefined;
    tap.current = null;
    draggingRef.current = false;
    setDragging(false);
    if (tapped) void toZone(tapped);
    else letGo();
  };
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" && !off) {
      // the keyboard's tap: the target onto the aiming point of the aiming zone it is in
      const zone = aimZoneAt(point);
      e.preventDefault();
      e.stopPropagation();
      if (zone) void toZone(zone);
      else setKeyHint(t.zoneAim.noZoneHere);
      return;
    }
    const step = e.shiftKey ? BIG_STEP : STEP;
    const by: Partial<Record<string, Partial<Point3>>> = {
      ArrowLeft: { x: point.x - step },
      ArrowRight: { x: point.x + step },
      ArrowUp: { y: point.y + step },
      ArrowDown: { y: point.y - step },
      PageUp: { z: point.z + BIG_STEP },
      PageDown: { z: point.z - BIG_STEP },
      // a slider's ends: the X bounds (and the page does not scroll)
      Home: { x: bounds.min.x },
      End: { x: bounds.max.x },
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
  const engageHelpId = useId();
  const [lineOpen, setLineOpen] = useState(false);

  const engage = (on: boolean): void => {
    if (off) return; // arranging: the press is the grid's; without the right: nothing is sent
    void cmd("target.engage", { id: row.id, on }).catch((error: Error) => onError(error.message));
  };

  // the reticle, the heads and the height, then the zones' names: no name over the reticle or a head (plan-tools.ts)
  const rx = sx(point.x);
  const ry = sy(point.y);
  const ring = Math.max(RING_PX * unit, Math.min(2 * RING_PX * unit, 0.3 * scale));
  const heightText = `${t.targets.z} ${metres(t, point.z)} m`;
  const zoneLabel = LABEL;
  const ownHeads = placed.filter((f) => stateOf.has(f.id));
  const aimZones = zones.filter((z) => z.aim);
  // a forbidden zone's dashed outline and an aiming zone's, edge by edge: the height is never written across them
  const outlines = zones
    .filter((z) => z.noAim || z.aim)
    .flatMap((z) =>
      z.polygon.map(([x0, y0], i) => {
        const [x1, y1] = z.polygon[(i + 1) % z.polygon.length]!;
        const [ax, bx, ay, by] = [sx(x0), sx(x1), sy(y0), sy(y1)];
        return { x0: Math.min(ax, bx) - unit, x1: Math.max(ax, bx) + unit, y0: Math.min(ay, by) - unit, y1: Math.max(ay, by) + unit };
      }),
    );
  const labels = placeLabels(
    [
      // the reticle and the target's heads first: no name is written over them
      { id: "#ring", x: rx, below: ry + 0.3 * LABEL, above: ry + 0.3 * LABEL, width: 3.4 * ring },
      ...ownHeads.map((f) => ({ id: `#head-${f.id}`, x: sx(f.position!.x), below: sy(f.position!.y) + 0.3 * LABEL, above: sy(f.position!.y) + 0.3 * LABEL, width: 3 * HEAD_PX * unit })),
      { id: "#point", x: rx, below: ry + ring * 1.7 + LABEL, above: ry - ring * 1.7 - LABEL * 0.3, width: textWidth(heightText, LABEL), avoid: outlines },
      // the other placed fixtures, greyed: a zone's name does not cover their dot
      ...placed.filter((f) => !stateOf.has(f.id)).map((f) => ({ id: `#fixture-${f.id}`, x: sx(f.position!.x), below: sy(f.position!.y) + 0.3 * LABEL, above: sy(f.position!.y) + 0.3 * LABEL, width: 2 * HEAD_PX * unit })),
      // the aiming zones' points (T27): no name over them either
      ...aimZones.map((z) => {
        const at = aimSpot(z);
        return { id: `#aim-${z.id}`, x: sx(at.x), below: sy(at.y) + 0.3 * LABEL, above: sy(at.y) + 0.3 * LABEL, width: 3.6 * AIM_MARK_PX * unit };
      }),
      // the aiming zones' names first: they are where a tap goes; a name that does not fit inside its zone is left
      // out (an aiming zone's then goes to the legend under the pad)
      ...[...aimZones, ...zones.filter((z) => !z.aim)].flatMap((z) => {
        const xs = z.polygon.map((p) => p[0]);
        const ys = z.polygon.map((p) => p[1]);
        const cx = sx((Math.min(...xs) + Math.max(...xs)) / 2);
        const width = textWidth(z.name, zoneLabel);
        const [wide, deep] = [sx(Math.max(...xs)) - sx(Math.min(...xs)), sy(Math.min(...ys)) - sy(Math.max(...ys))];
        if (width + zoneLabel > wide || 1.8 * zoneLabel > deep) return [];
        // inside the zone, clear of its outline: above its front edge, else under its back edge
        return [{ id: z.id, x: cx, below: sy(Math.min(...ys)) - 0.45 * zoneLabel, above: sy(Math.max(...ys)) + 1.15 * zoneLabel, width }];
      }),
    ],
    LABEL,
  );
  /** The aiming zones whose name the plan could not write: named in a legend under it (U2). */
  const unnamed = aimZones.filter((z) => !labels.has(z.id));
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
            draggingRef.current = true;
            const at = fromEvent(e);
            // in an aiming zone (Alt / Option and « Point exact » aside): a tap, unless it turns into a drag (nothing sent until then)
            const zone = e.altKey || exact ? undefined : aimZoneAt(at);
            tap.current = zone ? { zone, x: e.clientX, y: e.clientY } : null;
            if (zone) return;
            setDragging(true);
            move(at);
          }}
          onPointerMove={(e) => {
            if (activePointer.current !== e.pointerId || off) return;
            const pending = tap.current;
            if (pending) {
              if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < TAP_SLOP_PX) return;
              tap.current = null;
              setDragging(true);
            }
            move(fromEvent(e));
          }}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onLostPointerCapture={endPointer}
        >
          <rect className="tp-ground" x={0} y={0} width={W} height={H} />
          {zones.map((z) => (
            <polygon
              key={z.id}
              className={z.noAim ? "tp-zone no-aim" : z.aim ? "tp-zone aim" : "tp-zone"}
              data-zone={z.id}
              // an aiming zone in its colour (T27), as on the venue's plan
              style={z.aim && !z.noAim ? ({ "--zone-color": z.aim.color ?? "var(--aim-color)" } as React.CSSProperties) : undefined}
              points={z.polygon.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ")}
            >
              {/* every zone named, also one too small for its name on the plan */}
              <title>{z.name}</title>
            </polygon>
          ))}
          {aimZones.map((z) => {
            // its aiming point: a small cross in its colour (a tap in the zone puts the target there)
            const at = aimSpot(z);
            const r = AIM_MARK_PX * unit;
            return (
              <g key={`a-${z.id}`} className="tp-zone-aim" data-aim={z.id} transform={`translate(${sx(at.x)} ${sy(at.y)})`} style={{ "--zone-color": z.aim!.color ?? "var(--aim-color)" } as React.CSSProperties}>
                <line x1={-r} x2={r} y1={-r} y2={r} />
                <line x1={-r} x2={r} y1={r} y2={-r} />
              </g>
            );
          })}
          <rect className="tp-bounds" x={sx(bounds.min.x)} y={sy(bounds.max.y)} width={sx(bounds.max.x) - sx(bounds.min.x)} height={sy(bounds.min.y) - sy(bounds.max.y)} />
          {zones.map((z) => {
            const y = labels.get(z.id);
            if (y === undefined) return null;
            const xs = z.polygon.map((p) => p[0]);
            return (
              <text key={`n-${z.id}`} className={z.aim ? "tp-zone-name aim" : "tp-zone-name"} data-zone-name={z.id} x={sx((Math.min(...xs) + Math.max(...xs)) / 2)} y={y} textAnchor="middle" style={{ fontSize: zoneLabel, strokeWidth: 3 * unit }}>
                {z.name}
              </text>
            );
          })}
          {placed
            .filter((f) => !stateOf.has(f.id))
            .map((f) => (
              <circle key={f.id} className="tp-fixture" cx={sx(f.position!.x)} cy={sy(f.position!.y)} r={HEAD_PX * 0.6 * unit} />
            ))}
          <g className="tp-reticle" data-testid="target-reticle" transform={`translate(${rx} ${ry})`}>
            <circle r={ring} />
            <line x1={-ring * 1.6} x2={-ring * 0.45} y1={0} y2={0} />
            <line x1={ring * 0.45} x2={ring * 1.6} y1={0} y2={0} />
            <line y1={-ring * 1.6} y2={-ring * 0.45} x1={0} x2={0} />
            <line y1={ring * 0.45} y2={ring * 1.6} x1={0} x2={0} />
            <circle r={2.5 * unit} className="tp-reticle-dot" />
          </g>
          {/* the target's heads over the reticle: a head right under the point stays visible */}
          {ownHeads.map((f) => {
            const state = stateOf.get(f.id)!;
            const [x, y] = [sx(f.position!.x), sy(f.position!.y)];
            return (
              <g key={f.id} className="tp-head" data-state={state} data-fixture={f.id}>
                <circle cx={x} cy={y} r={HEAD_PX * unit} />
                {/* a held or frozen head carries a mark, never the colour alone */}
                {state === "held" && (
                  <text x={x} y={y + HEAD_PX * 0.6 * unit} textAnchor="middle" className="tp-head-mark" style={{ fontSize: HEAD_PX * 1.7 * unit }}>
                    !
                  </text>
                )}
                {state === "frozen" && <Padlock x={x} y={y - 0.3 * unit} size={HEAD_PX * 1.5 * unit} />}
              </g>
            );
          })}
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
            disabled={disabled}
            interactive={!off}
            valueText={`${shown(point.z)} m`}
            keyStep={zSpan > 0 ? STEP / zSpan : STEP}
            pageStep={zSpan > 0 ? BIG_STEP / zSpan : BIG_STEP}
            onChange={(level) => move({ z: bounds.min.z + level * zSpan })}
          />
          <small aria-hidden="true">{t.targets.z}</small>
        </div>
      </div>
      <span id={hintId} className="sr-only">
        {t.targets.keysHelp}
      </span>
      <div className="target-pad-status">
        <div className="target-pad-heading">
          <strong>{name}</strong>
          <small className="target-pad-where">{where}</small>
        </div>
        {unnamed.length > 0 && (
          <ul className="tp-legend" aria-label={t.zoneAim.targetLegend} data-testid="target-zone-legend">
            {unnamed.map((z) => (
              <li key={z.id} data-zone={z.id} style={{ "--zone-color": z.aim!.color ?? "var(--aim-color)" } as React.CSSProperties}>
                <i aria-hidden="true" />
                {z.name}
              </li>
            ))}
          </ul>
        )}
        <span className="hint tp-key-hint" aria-live="polite" data-testid="target-key-hint">
          {keyHint}
        </span>
        {/* two lines at most; a press shows it whole (a tablet has no tooltip) */}
        <button type="button" className={`target-pad-line${lineOpen ? " open" : ""}`} aria-expanded={lineOpen} title={lineOpen ? undefined : t.targets.lineMore} onClick={() => setLineOpen((o) => !o)}>
          <span id={statusId} data-testid="target-status" aria-live="polite" aria-atomic="true">
            {line}
          </span>
        </button>
      </div>
      <span id={engageHelpId} className="sr-only">
        {row.engaged ? t.targets.reengageHelp : t.targets.engageHelp}
      </span>
      <div className="row target-pad-actions">
        <button
          className={row.engaged ? "on" : ""}
          aria-pressed={row.engaged}
          aria-describedby={engageHelpId}
          aria-disabled={off || undefined}
          data-testid="target-engage"
          title={row.engaged ? t.targets.reengageHelp : t.targets.engageHelp}
          onClick={() => engage(true)}
        >
          <span aria-hidden="true">{row.engaged ? "◉ " : "◎ "}</span>
          {t.targets.engage}
        </button>
        <button data-testid="target-disengage" title={t.targets.disengageHelp} aria-disabled={off || !row.engaged || undefined} onClick={() => row.engaged && engage(false)}>
          {t.targets.disengage}
        </button>
        {aimZones.length > 0 && (
          // decision P-d: Alt / Option for the finger, as on the venue's plan
          <button
            type="button"
            className="tp-exact"
            aria-pressed={exact}
            aria-disabled={off || undefined}
            title={t.zoneAim.targetExactHelp}
            data-testid="target-exact"
            onClick={() => {
              if (!off) setExact((on) => !on);
            }}
          >
            {t.zoneAim.exact}
          </button>
        )}
      </div>
    </div>
  );
}
