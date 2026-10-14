/**
 * Live 2D preview (docs/specs/venue-fixtures-stage.md, « Live preview 2D »): top view of the stage,
 * audience at the bottom. Zones are drawn from their polygons; fixtures at their position, each
 * head coloured from the real output (topic light:preview, after rules, parks and Blackout).
 * Fixtures with no stage position are lined up along the front edge. With moving heads, « Viser »
 * points them at the clicked spot (position.aim, at a standing person's height). « Placer » lets
 * fixtures be dragged to their place (snapped to 10 cm).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { stream } from "../ws";

export interface PlanFixture {
  id: string;
  name: string;
  role?: string;
  mount?: string;
  position?: { x: number; y: number; z: number };
}
export interface PlanZone {
  id: string;
  name: string;
  type: string;
  polygon: [number, number][];
  floorHeight: number;
  protected: boolean;
}

const ZONE_FILL: Record<string, string> = { stage: "#2a2f3b", riser: "#343b4a", floor: "#22262f", audience: "#1b2a22", wall: "#3a2f2a", pillar: "#3a2f2a", backdrop: "#30283a" };

/** Default height of a fixture placed for the first time, from its mount (metres). */
const defaultHeight = (mount?: string) => (mount === "hung" || mount === "truss" || mount === "ceiling" ? 5 : mount === "stand" ? 1.8 : mount === "wall" || mount === "pillar" ? 3 : 0.3);

export function StagePlan({ fixtures, zones, onError, onMove, compact = false }: { fixtures: PlanFixture[]; zones: PlanZone[]; onError: (msg: string) => void; onMove?: (fixture: PlanFixture, position: { x: number; y: number; z: number }) => void; compact?: boolean }) {
  const t = useT();
  const [colors, setColors] = useState<Record<string, string[]>>({});
  const [aiming, setAiming] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [heads, setHeads] = useState(0);
  const svg = useRef<SVGSVGElement>(null);

  useEffect(() => stream.subscribe("light:preview", (d) => setColors((d as { fixtures: Record<string, string[]> }).fixtures)), []);
  useEffect(() => {
    void cmd<unknown[]>("position.list").then((h) => setHeads(h.length)).catch(() => undefined);
  }, [fixtures]);

  // Frame: zones and placed fixtures, with a margin; unplaced fixtures go on a row in front.
  const layout = useMemo(() => {
    const pts: [number, number][] = [...zones.flatMap((z) => z.polygon), ...fixtures.filter((f) => f.position).map((f) => [f.position!.x, f.position!.y] as [number, number])];
    const unplaced = fixtures.filter((f) => !f.position);
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
    for (const f of fixtures) if (f.position) pos.set(f.id, { x: f.position.x, y: f.position.y });
    unplaced.forEach((f, i) => pos.set(f.id, { x: -rowHalf + (2 * rowHalf * (i + 0.5)) / unplaced.length, y: rowY }));
    return { minX: minX - m, maxX: maxX + m, minY: minY - m, maxY: maxY + m, pos, unplaced: unplaced.length };
  }, [fixtures, zones]);

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
    if (f && onMove) onMove(f, { x: snap(drag.x), y: snap(drag.y), z: f.position?.z ?? defaultHeight(f.mount) });
  };

  const aimAt = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!aiming || placing || !svg.current) return;
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
          {t.audience} ↓{layout.unplaced ? ` · ${layout.unplaced} ${t.unplaced}` : ""}
        </small>
        {onMove && (
          <label className="row">
            <input type="checkbox" checked={placing} onChange={(e) => (setPlacing(e.target.checked), setAiming(false))} /> {t.placeMode}
          </label>
        )}
        {heads > 0 && !placing && (
          <label className="row">
            <input type="checkbox" checked={aiming} onChange={(e) => setAiming(e.target.checked)} /> {t.aimMode}
          </label>
        )}
        </div>
      )}
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className={aiming ? "aiming" : placing ? "placing" : ""}
        onClick={aimAt}
        onPointerMove={(e) => drag && setDrag({ ...drag, ...eventToStage(e) })}
        onPointerUp={dropDrag}
        role="img"
        aria-label={t.stagePreview}
      >
        <rect width={W} height={H} fill="#12141a" />
        {zones.map((z) => (
          <g key={z.id} className="zone">
            <polygon points={z.polygon.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ")} fill={ZONE_FILL[z.type] ?? "#262a33"} stroke={z.protected ? "#e5484d" : "#3b4150"} strokeDasharray={z.protected ? "6 4" : undefined} />
            <text x={sx(z.polygon.reduce((a, p) => a + p[0], 0) / z.polygon.length)} y={sy(Math.max(...z.polygon.map((p) => p[1]))) + 14} textAnchor="middle" className="zone-name">
              {z.name}
              {z.protected ? ` (${t.protectedZone})` : ""}
            </text>
          </g>
        ))}
        {/* halos first, under every fixture */}
        {fixtures.map((f) => {
          const p = drag?.id === f.id ? drag : layout.pos.get(f.id)!;
          const lit = (colors[f.id] ?? []).filter((c) => c !== "#000000");
          if (!lit.length) return null;
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
          return (
            <g
              key={f.id}
              className="fixture"
              data-fixture={f.id}
              onPointerDown={(e) => {
                if (!placing) return;
                e.stopPropagation();
                svg.current?.setPointerCapture(e.pointerId);
                setDrag({ id: f.id, ...eventToStage(e) });
              }}
            >
              {cols.map((c, i) => (
                <rect key={i} x={x0 + i * cw} y={y0} width={Math.max(2, cw - 1)} height={h} fill={c} stroke="#4a5060" strokeWidth={0.5} />
              ))}
              <text x={sx(p.x)} y={y0 + h + 14} textAnchor="middle" className="fixture-name">
                {f.name}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
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
