/**
 * Live 2D preview (docs/specs/venue-fixtures-stage.md, « Live preview 2D »): top view of the stage,
 * audience at the bottom. Zones are drawn from their polygons; fixtures at their position, each
 * head coloured from the real output (topic light:preview, after rules, parks and Blackout).
 * Fixtures with no stage position are lined up along the front edge. With moving heads, « Viser »
 * points them at the clicked spot (position.aim, at a standing person's height). « Placer » lets
 * fixtures be dragged to their place (snapped to 10 cm). The front view shows heights (X, Z): risers
 * at their floor height, and dragging there sets a fixture's height. A strobing fixture gets a still
 * dashed outline and its rate: the screen never flashes (a flashing screen is a photosensitive risk too).
 * « Orienter »: click a fixture, then pick where it points (audience, upstage wall, jardin, cour,
 * ceiling, floor), turn it by 15° (buttons, ← / →), type an angle, or drag around it to turn it; an arrow shows the
 * beam, ⊙ / ⊗ when it points at / away from the viewer. A lit fixture whose beam is known (its
 * orientation, or a moving head's pan/tilt read back from the output: light:preview beams) casts a
 * cone of its colour to where the light lands on the floor of the zone below, 2 m otherwise. A zone
 * no moving head may point into is hatched.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { stream } from "../ws";

export interface PlanFixture {
  id: string;
  name: string;
  role?: string;
  mount?: string;
  position?: { x: number; y: number; z: number };
  /** yaw: 0 audience, 90 cour, 180 upstage, −90 jardin; pitch: −90 floor … 90 ceiling (venue/orientation.ts). */
  orientation?: { yaw: number; pitch?: number };
  /** The named facing the orientation matches (venue.fixture.list). */
  facing?: Facing;
}
export type Facing = "audience" | "upstage" | "houseLeft" | "houseRight" | "ceiling" | "floor";
export type OrientChange = { facing?: Facing; yaw?: number; pitch?: number; turn?: number };
const FACINGS: Facing[] = ["audience", "upstage", "houseLeft", "houseRight", "ceiling", "floor"];
type Vec = { x: number; y: number; z: number };
/** Zoom steps of the plan; above 1 it scrolls inside its frame. */
const ZOOMS = [1, 1.5, 2, 3, 4];
/** The opening drawn when the definition gives none: a typical wash. */
const DEFAULT_BEAM_ANGLE = 24;

/** The beam as a unit vector, stage frame (X cour, Y upstage, Z up): the convention of venue/orientation.ts. */
function beam(o?: { yaw: number; pitch?: number }): { x: number; y: number; z: number } {
  const yaw = ((o?.yaw ?? 0) * Math.PI) / 180;
  const pitch = ((o?.pitch ?? 0) * Math.PI) / 180;
  return { x: Math.sin(yaw) * Math.cos(pitch), y: -Math.cos(yaw) * Math.cos(pitch), z: Math.sin(pitch) };
}
export interface PlanZone {
  id: string;
  name: string;
  type: string;
  polygon: [number, number][];
  floorHeight: number;
  protected: boolean;
  /** No moving head may point into it: hatched on the plan. */
  noAim?: boolean;
}

const ZONE_FILL: Record<string, string> = { stage: "#2a2f3b", riser: "#343b4a", floor: "#22262f", audience: "#1b2a22", wall: "#3a2f2a", pillar: "#3a2f2a", backdrop: "#30283a" };

/** Default height of a fixture placed for the first time, from its mount (metres). */
const defaultHeight = (mount?: string) => (mount === "hung" || mount === "truss" || mount === "ceiling" ? 5 : mount === "stand" ? 1.8 : mount === "wall" || mount === "pillar" ? 3 : 0.3);

export function StagePlan({
  fixtures,
  zones,
  onError,
  onMove,
  onOrient,
  compact = false,
}: {
  fixtures: PlanFixture[];
  zones: PlanZone[];
  onError: (msg: string) => void;
  onMove?: (fixture: PlanFixture, position: { x: number; y: number; z: number }) => void;
  onOrient?: (fixture: PlanFixture, change: OrientChange) => void;
  compact?: boolean;
}) {
  const t = useT();
  const [colors, setColors] = useState<Record<string, string[]>>({});
  const [strobe, setStrobe] = useState<Record<string, number | null>>({});
  const [beams, setBeams] = useState<Record<string, Vec & { angle?: number; to: Vec }>>({});
  const [aiming, setAiming] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [orienting, setOrienting] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  /** Heading while dragging around the selected fixture, saved on release. */
  const [turning, setTurning] = useState<number | null>(null);
  const [view, setView] = useState<"top" | "front">("top");
  const front = view === "front";
  // The drawing works on (x, y) pairs: top view = stage plan, front view = (x, height).
  const shown = useMemo(() => {
    const fx = fixtures.map((f) => (front && f.position ? { ...f, position: { x: f.position.x, y: f.position.z, z: f.position.y } } : f));
    const zs = front
      ? zones.map((z) => {
          const xs = z.polygon.map((p) => p[0]);
          const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
          const top = Math.max(0.05, z.floorHeight);
          return { ...z, polygon: [[x0, 0], [x1, 0], [x1, top], [x0, top]] as [number, number][] };
        })
      : zones;
    return { fixtures: fx, zones: zs };
  }, [fixtures, zones, front]);
  const [heads, setHeads] = useState(0);
  const svg = useRef<SVGSVGElement>(null);
  // zoom: the drawing grows inside a scrolling frame, keeping what was at the centre there
  const [zoom, setZoom] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const centre = useRef<[number, number] | null>(null);
  const zoomTo = (z: number) => {
    const el = scroller.current;
    if (el) centre.current = [(el.scrollLeft + el.clientWidth / 2) / el.scrollWidth, (el.scrollTop + el.clientHeight / 2) / el.scrollHeight];
    setZoom(z);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !centre.current) return;
    el.scrollLeft = centre.current[0] * el.scrollWidth - el.clientWidth / 2;
    el.scrollTop = centre.current[1] * el.scrollHeight - el.clientHeight / 2;
    centre.current = null;
  }, [zoom]);

  useEffect(
    () =>
      stream.subscribe("light:preview", (d) => {
        const update = d as { fixtures: Record<string, string[]>; strobe?: Record<string, number | null>; beams?: Record<string, Vec & { angle?: number; to: Vec }> };
        setColors(update.fixtures);
        setStrobe(update.strobe ?? {});
        setBeams(update.beams ?? {});
      }),
    [],
  );
  useEffect(() => {
    void cmd<unknown[]>("position.list").then((h) => setHeads(h.length)).catch(() => undefined);
  }, [fixtures]);

  // Frame: zones and placed fixtures, with a margin; unplaced fixtures go on a row in front.
  const layout = useMemo(() => {
    const { fixtures: fxs, zones: zs } = shown;
    const pts: [number, number][] = [...zs.flatMap((z) => z.polygon), ...fxs.filter((f) => f.position).map((f) => [f.position!.x, f.position!.y] as [number, number])];
    const unplaced = fxs.filter((f) => !f.position);
    const rowHalf = Math.max(1.5, unplaced.length * 0.6);
    let minX = -rowHalf;
    let maxX = rowHalf;
    let minY: number;
    let maxY: number;
    let rowY = 0;
    if (pts.length) {
      minX = Math.min(...pts.map((p) => p[0]));
      maxX = Math.max(...pts.map((p) => p[0]));
      minY = Math.min(...pts.map((p) => p[1]));
      maxY = Math.max(...pts.map((p) => p[1]));
      if (unplaced.length) {
        rowY = Math.min(minY, 0) - 0.8; // a row in front of the stage
        minY = rowY - 0.3;
        minX = Math.min(minX, -rowHalf);
        maxX = Math.max(maxX, rowHalf);
      }
    } else [minY, maxY] = [rowY - 0.3, rowY + 0.3]; // nothing placed yet: just the row
    const m = pts.length ? 0.8 : 0.3;
    const pos = new Map<string, { x: number; y: number }>();
    for (const f of fxs) if (f.position) pos.set(f.id, { x: f.position.x, y: f.position.y });
    unplaced.forEach((f, i) => pos.set(f.id, { x: -rowHalf + (2 * rowHalf * (i + 0.5)) / unplaced.length, y: rowY }));
    return { minX: minX - m, maxX: maxX + m, minY: minY - m, maxY: maxY + m, pos, unplaced: unplaced.length };
  }, [shown]);

  const W = 800;
  const scale = W / (layout.maxX - layout.minX);
  const H = Math.max(160, (layout.maxY - layout.minY) * scale);
  const sx = (x: number) => (x - layout.minX) * scale;
  const sy = (y: number) => H - (y - layout.minY) * scale; // upstage at the top, audience at the bottom
  const toStage = (px: number, py: number) => ({ x: px / scale + layout.minX, y: (H - py) / scale + layout.minY });

  const eventToStage = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return toStage(((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H);
  };
  const snap = (v: number) => Math.round(v * 10) / 10;
  const dropDrag = () => {
    if (!drag) return;
    const f = fixtures.find((x) => x.id === drag.id);
    setDrag(null);
    // front view: the vertical axis is the height; the depth is kept
    if (f && onMove) onMove(f, front ? { x: snap(drag.x), y: f.position?.y ?? 1, z: Math.max(0, snap(drag.y)) } : { x: snap(drag.x), y: snap(drag.y), z: f.position?.z ?? defaultHeight(f.mount) });
  };

  // « Orienter »: dragging around the selected fixture turns it (by 15°, or freely with Shift)
  const selectedFixture = fixtures.find((f) => f.id === selected);
  const turnTo = (e: React.PointerEvent) => {
    const at = selected ? layout.pos.get(selected) : undefined;
    if (turning === null || !at || front) return;
    const p = eventToStage(e);
    const [dx, dy] = [p.x - at.x, p.y - at.y];
    if (Math.hypot(dx, dy) * scale < 12) return; // too close to the centre to tell a direction
    const raw = (Math.atan2(dx, -dy) * 180) / Math.PI;
    setTurning(e.shiftKey ? Math.round(raw) : Math.round(raw / 15) * 15);
  };
  // keyboard: ← / → turn the selected fixture by 15° (as ⟲ / ⟳), Escape lets it go
  useEffect(() => {
    if (!orienting || !selectedFixture || !onOrient) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        onOrient(selectedFixture, { turn: e.key === "ArrowLeft" ? 15 : -15 });
      } else if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [orienting, selectedFixture, onOrient]);
  const dropTurn = () => {
    if (turning === null || !selectedFixture) return;
    const was = selectedFixture.orientation?.yaw ?? 0;
    setTurning(null);
    if (turning !== was && onOrient) onOrient(selectedFixture, { yaw: turning });
  };

  /** The beam's cone on the view: from the fixture to where it lands (worked out by the server), opening with the distance. */
  const cone = (f: PlanFixture, color: string) => {
    const d = beams[f.id];
    if (!d || !f.position || drag?.id === f.id) return null;
    const end = d.to;
    const view = (v: Vec) => [sx(v.x), sy(front ? v.z : v.y)] as const;
    const [ox, oy] = view(f.position);
    const [ex, ey] = view(end);
    const len = Math.hypot(ex - ox, ey - oy);
    if (len < 6) return null; // straight at the viewer: the halo says it
    // the opening from the definition's lens, kept readable: a 2° pin spot still shows as a line
    const halfAngle = (Math.min(Math.max(d.angle ?? DEFAULT_BEAM_ANGLE, 4), 120) * Math.PI) / 360;
    const half = Math.hypot(end.x - f.position.x, end.y - f.position.y, end.z - f.position.z) * Math.tan(halfAngle) * scale;
    const [nx, ny] = [-(ey - oy) / len, (ex - ox) / len];
    return (
      <g key={`beam-${f.id}`} className="light-cone" data-beam={f.id} fill={color}>
        <polygon points={`${ox},${oy} ${ex + nx * half},${ey + ny * half} ${ex - nx * half},${ey - ny * half}`} opacity={0.18} />
        {!front && d.z < -0.05 && <circle cx={ex} cy={ey} r={half} opacity={0.3} />}
      </g>
    );
  };

  const aimAt = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!aiming || placing || orienting || front || !svg.current) return;
    const p = eventToStage(e);
    const zone = zones.find((z) => inside(p.x, p.y, z.polygon));
    void cmd<{ results: { fixture: string; error?: string }[] }>("position.aim", { point: { x: p.x, y: p.y, z: (zone?.floorHeight ?? 0) + 1.5 } })
      .then((res) => {
        const errors = res.results.filter((x) => x.error).map((x) => `${x.fixture} : ${x.error}`);
        if (errors.length) onError(errors.join(" · "));
      })
      .catch((err: Error) => onError(err.message));
  };

  return (
    <div className={compact ? "stage-plan compact" : "stage-plan"}>
      {!compact && (
        <div className="row">
        <small className="hint">
          {front ? t.audienceFacing : `${t.audience} ↓`}{layout.unplaced ? ` · ${layout.unplaced} ${t.unplaced}` : ""}
        </small>
        {onMove && (
          <label className="row">
            <input type="checkbox" checked={placing} onChange={(e) => (setPlacing(e.target.checked), setAiming(false), setOrienting(false))} /> {t.placeMode}
          </label>
        )}
        {onOrient && (
          <label className="row">
            <input type="checkbox" checked={orienting} onChange={(e) => (setOrienting(e.target.checked), setPlacing(false), setAiming(false), setSelected(null))} /> {t.orientMode}
          </label>
        )}
        <span className="row view-switch">
          <button className={front ? "ghost" : "ghost on"} onClick={() => setView("top")}>
            {t.viewTop}
          </button>
          <button className={front ? "ghost on" : "ghost"} onClick={() => (setView("front"), setAiming(false))}>
            {t.viewFront}
          </button>
        </span>
        <span className="row zoom">
          <button className="ghost" aria-label={t.zoomOut} title={t.zoomOut} disabled={zoom <= ZOOMS[0]!} onClick={() => zoomTo(ZOOMS[ZOOMS.indexOf(zoom) - 1] ?? 1)}>
            −
          </button>
          <small>×{zoom}</small>
          <button className="ghost" aria-label={t.zoomIn} title={t.zoomIn} disabled={zoom >= ZOOMS[ZOOMS.length - 1]!} onClick={() => zoomTo(ZOOMS[ZOOMS.indexOf(zoom) + 1] ?? zoom)}>
            +
          </button>
        </span>
        {heads > 0 && !placing && !orienting && !front && (
          <label className="row">
            <input type="checkbox" checked={aiming} onChange={(e) => setAiming(e.target.checked)} /> {t.aimMode}
          </label>
        )}
        </div>
      )}
      <div className="plan-scroll" ref={scroller}>
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className={aiming ? "aiming" : placing ? "placing" : orienting ? "orienting" : ""}
        style={zoom > 1 ? { width: `${zoom * 100}%`, maxWidth: "none" } : undefined}
        onClick={aimAt}
        onPointerMove={(e) => (drag ? setDrag({ ...drag, ...eventToStage(e) }) : turnTo(e))}
        onPointerUp={() => (dropDrag(), dropTurn())}
        role="img"
        aria-label={t.stagePreview}
      >
        <defs>
          <marker id="beam-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#ffb454" />
          </marker>
          <pattern id="no-aim" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="#e5484d" strokeWidth="2" opacity="0.5" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="#12141a" />
        {front && <line x1={0} x2={W} y1={sy(0)} y2={sy(0)} stroke="#3b4150" />}
        {shown.zones.map((z) => (
          <g key={z.id} className="zone">
            <polygon points={z.polygon.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ")} fill={ZONE_FILL[z.type] ?? "#262a33"} stroke={z.protected || z.noAim ? "#e5484d" : "#3b4150"} strokeDasharray={z.protected || z.noAim ? "6 4" : undefined} />
            {z.noAim && <polygon className="no-aim" points={z.polygon.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ")} fill="url(#no-aim)" />}
            <text x={sx(z.polygon.reduce((a, p) => a + p[0], 0) / z.polygon.length)} y={sy(Math.max(...z.polygon.map((p) => p[1]))) + 14} textAnchor="middle" className="zone-name">
              {z.name}
              {z.protected ? ` (${t.protectedZone})` : ""}
              {z.noAim ? ` (${t.noAimZone})` : ""}
            </text>
          </g>
        ))}
        {/* light first, under every fixture: a cone where the beam is known, a halo otherwise */}
        {fixtures.map((f) => {
          const p = drag?.id === f.id ? drag : layout.pos.get(f.id)!;
          const lit = (colors[f.id] ?? []).filter((c) => c !== "#000000");
          if (!lit.length) return null;
          const beam = cone(f, lit[Math.floor(lit.length / 2)]!);
          if (beam) return beam;
          const w = Math.min(1.2, Math.max(0.3, (colors[f.id]?.length ?? 1) * 0.2)) * scale;
          const h = Math.max(8, Math.min(28, 0.2 * scale));
          return <ellipse key={`halo-${f.id}`} cx={sx(p.x)} cy={sy(p.y)} rx={w * 0.75} ry={h * 1.5} fill={lit[Math.floor(lit.length / 2)]} opacity={0.22} />;
        })}
        {fixtures.map((f) => {
          const p = drag?.id === f.id ? drag : layout.pos.get(f.id)!;
          const cols = colors[f.id] ?? ["#000000"];
          // sized in metres, so the plan reads at any scale: ~20 cm per head, 30 cm to 1.2 m wide
          const w = Math.min(1.2, Math.max(0.3, cols.length * 0.2)) * scale;
          const h = Math.max(8, Math.min(28, 0.2 * scale));
          const cw = w / cols.length;
          const x0 = sx(p.x) - w / 2;
          const y0 = sy(p.y) - h / 2;
          const isSelected = orienting && selected === f.id;
          const o = isSelected && turning !== null ? { ...f.orientation, yaw: turning } : f.orientation;
          // seen from above, the body turns with its heading (its front, the long side, faces the audience at 0)
          const body = !front && o?.yaw ? `rotate(${-o.yaw} ${sx(p.x)} ${sy(p.y)})` : undefined;
          // the beam, projected on the view; what is left points at or away from the viewer
          const d = beam(o);
          const [px, py, toward] = front ? [d.x, -d.z, -d.y] : [d.x, -d.y, d.z];
          const reach = Math.max(w, h) / 2 + 16;
          // half the height the turned body takes on the plan: the name goes under it
          const turn = body ? ((o?.yaw ?? 0) * Math.PI) / 180 : 0;
          const halfHeight = Math.abs((w / 2) * Math.sin(turn)) + Math.abs((h / 2) * Math.cos(turn));
          const showBeam = Boolean(f.orientation) || isSelected;
          return (
            <g
              key={f.id}
              className={isSelected ? "fixture selected" : "fixture"}
              data-fixture={f.id}
              onPointerDown={(e) => {
                if (orienting) {
                  e.stopPropagation();
                  setSelected(f.id);
                  if (!front) {
                    svg.current?.setPointerCapture(e.pointerId);
                    setTurning(f.orientation?.yaw ?? 0);
                  }
                  return;
                }
                if (!placing) return;
                e.stopPropagation();
                svg.current?.setPointerCapture(e.pointerId);
                setDrag({ id: f.id, ...eventToStage(e) });
              }}
            >
              <g transform={body}>
                {cols.map((c, i) => (
                  <rect key={i} x={x0 + i * cw} y={y0} width={Math.max(2, cw - 1)} height={h} fill={c} stroke="#4a5060" strokeWidth={0.5} />
                ))}
                {isSelected && <rect className="selection" x={x0 - 4} y={y0 - 4} width={w + 8} height={h + 8} fill="none" />}
                {f.id in strobe && cols.some((c) => c !== "#000000") && <rect className="strobe-outline" x={x0 - 3} y={y0 - 3} width={w + 6} height={h + 6} fill="none" />}
              </g>
              {showBeam && (
                <g className="beam">
                  <title>{f.facing ? `${t.facingLabel} : ${t.facings[f.facing]}` : `${t.heading} ${Math.round(o?.yaw ?? 0)}° · ${t.pitchLabel} ${Math.round(o?.pitch ?? 0)}°`}</title>
                  {Math.hypot(px, py) >= 0.35 && <line x1={sx(p.x)} y1={sy(p.y)} x2={sx(p.x) + px * reach} y2={sy(p.y) + py * reach} markerEnd="url(#beam-head)" />}
                  {Math.abs(toward) > 0.7 && (
                    <g transform={`translate(${x0 + w + 10} ${y0 - 2})`}>
                      <circle r={6} fill="#12141a" />
                      {toward > 0 ? <circle r={1.8} className="dot" /> : <path d="M -3.5 -3.5 L 3.5 3.5 M -3.5 3.5 L 3.5 -3.5" />}
                    </g>
                  )}
                </g>
              )}
              {f.id in strobe && cols.some((c) => c !== "#000000") && (
                <g className="strobe-mark">
                  <title>{strobe[f.id] === null ? t.strobing : `${t.strobing} · ${Math.round(strobe[f.id]!)} Hz`}</title>
                  <text x={sx(p.x)} y={y0 - 6} textAnchor="middle">
                    ⚡{strobe[f.id] === null ? "" : ` ${Math.round(strobe[f.id]!)} Hz`}
                  </text>
                </g>
              )}
              <text x={sx(p.x)} y={sy(p.y) + halfHeight + 14} textAnchor="middle" className="fixture-name">
                {f.name}
              </text>
            </g>
          );
        })}
      </svg>
      </div>
      {orienting && !compact && (
        <div className="orient-panel row">
          {selectedFixture && onOrient ? (
            <>
              <strong>{selectedFixture.name}</strong>
              <span className="hint">{t.facingLabel}</span>
              {FACINGS.map((facing) => (
                <button key={facing} className={selectedFixture.facing === facing ? "on" : ""} aria-pressed={selectedFixture.facing === facing} onClick={() => onOrient(selectedFixture, { facing })}>
                  {t.facings[facing]}
                </button>
              ))}
              <button title={t.turnLeft} aria-label={t.turnLeft} onClick={() => onOrient(selectedFixture, { turn: 15 })}>
                ⟲ 15°
              </button>
              <button title={t.turnRight} aria-label={t.turnRight} onClick={() => onOrient(selectedFixture, { turn: -15 })}>
                ⟳ 15°
              </button>
              <AngleField key={`yaw-${selectedFixture.orientation?.yaw ?? 0}`} label={t.heading} value={selectedFixture.orientation?.yaw ?? 0} min={-180} max={180} onCommit={(yaw) => onOrient(selectedFixture, { yaw })} />
              <AngleField key={`pitch-${selectedFixture.orientation?.pitch ?? 0}`} label={t.pitchLabel} value={selectedFixture.orientation?.pitch ?? 0} min={-90} max={90} onCommit={(pitch) => onOrient(selectedFixture, { pitch })} />
            </>
          ) : (
            <span className="hint">{front ? t.orientHintFront : t.orientHint}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** A number of degrees, saved on Enter or when leaving the field. */
function AngleField({ label, value, min, max, onCommit }: { label: string; value: number; min: number; max: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(Math.round(value)));
  const commit = () => {
    const v = Number(text);
    if (text.trim() !== "" && Number.isFinite(v) && v >= min && v <= max && v !== value) onCommit(v);
  };
  return (
    <label className="row">
      {label}
      <input type="number" min={min} max={max} step={15} aria-label={`${label} (°)`} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />°
    </label>
  );
}

function inside(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Self-loading live preview, for a dashboard widget. */
export function LiveStage({ onError }: { onError: (msg: string) => void }) {
  const [fixtures, setFixtures] = useState<PlanFixture[]>([]);
  const [zones, setZones] = useState<PlanZone[]>([]);
  useEffect(() => {
    void cmd<PlanFixture[]>("venue.fixture.list").then(setFixtures).catch(() => undefined);
    void cmd<PlanZone[]>("stage.zone.list").then(setZones).catch(() => undefined);
  }, []);
  return <StagePlan fixtures={fixtures} zones={zones} onError={onError} compact />;
}
