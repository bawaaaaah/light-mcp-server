/**
 * Live 2D preview (docs/specs/venue-fixtures-stage.md, « Live preview 2D »): top view of the stage,
 * audience at the bottom. Zones are drawn from their polygons; fixtures at their position, each
 * head coloured from the real output (topic light:preview, after rules, parks and Blackout).
 * Fixtures with no stage position are lined up along the front edge. With moving heads, « Viser »
 * points them at the clicked spot (position.aim, at a standing person's height). « Placer » lets
 * fixtures be dragged to their place, on a magnetic grid (10 cm by default, or free), held on another
 * fixture's line or column (guides); several are chosen with Ctrl/⌘ or Shift, or a frame drawn on the
 * stage, then moved together, lined up or spread (plan-tools.ts), or nudged with the arrows. The front
 * view shows heights (X, Z): risers at their floor height, and dragging there sets a fixture's
 * height. Names are written at a readable size, under or above their fixture, never over another
 * (the rest on hover), and the drawing makes room for them. A strobing fixture gets a still
 * dashed outline and its rate: the screen never flashes (a flashing screen is a photosensitive risk too).
 * « Orienter »: click a fixture, then pick where it points (audience, upstage wall, jardin, cour,
 * ceiling, floor), turn it by 15° (buttons, ← / →), type an angle, or drag around it to turn it; an arrow shows the
 * beam, ⊙ / ⊗ when it points at / away from the viewer. A lit fixture whose beam is known (its
 * orientation, or a moving head's pan/tilt read back from the output: light:preview beams) casts a
 * cone of its colour to where the light lands on the floor of the zone below, 2 m otherwise. A zone
 * no moving head may point into is hatched.
 */
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { stream } from "../ws";
import { useContextMenu } from "./menu";
import { moveZone } from "../zone-shape";
import { arrange, dragOffset, inFrame, placeLabels, textWidth, type Arrange, type P } from "../plan-tools";
import { useStored } from "../hooks/useStored";

/** The 3D view, loaded when first opened: three.js stays out of the rest of the interface. */
const Stage3D = lazy(() => import("./Stage3D"));

export interface PlanFixture {
  id: string;
  name: string;
  role?: string;
  mount?: string;
  position?: { x: number; y: number; z: number };
  /** yaw: 0 audience, 90 cour, 180 upstage, −90 jardin; pitch: −90 floor … 90 ceiling (venue/orientation.ts). */
  orientation?: { yaw: number; pitch?: number; roll?: number };
  /** The named facing the orientation matches (venue.fixture.list). */
  facing?: Facing;
  /** Marker colour (venue.fixture.mark): the name is written in it. */
  color?: string;
}
export type Facing = "audience" | "upstage" | "houseLeft" | "houseRight" | "ceiling" | "floor";
export type OrientChange = { facing?: Facing; yaw?: number; pitch?: number; turn?: number; roll?: number };
const FACINGS: Facing[] = ["audience", "upstage", "houseLeft", "houseRight", "ceiling", "floor"];
type Vec = { x: number; y: number; z: number };
/** Zoom steps of the plan; above 1 it scrolls inside its frame. */
const ZOOMS = [1, 1.5, 2, 3, 4];
/** The opening drawn when the definition gives none: a typical wash. */
const DEFAULT_BEAM_ANGLE = 24;
/** The magnetic grid's steps (metres); 0: free, to the centimetre. */
const GRID_STEPS = [0, 0.1, 0.25, 0.5, 1];
/** Fixture names on screen (px), whatever the plan's size or zoom. */
const NAME_PX = 11;

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
  /** Looks allowed into it all the same. */
  allowLooks?: string[];
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
  views = false,
  shownColors,
  initialView = "top",
  onZoneMenu,
  onZoneMove,
}: {
  fixtures: PlanFixture[];
  zones: PlanZone[];
  onError: (msg: string) => void;
  /** « Placer »: fixtures moved (one dragged, or several at once), their new positions. */
  onMove?: (moves: { fixture: PlanFixture; position: Vec }[]) => void;
  onOrient?: (fixture: PlanFixture, change: OrientChange) => void;
  compact?: boolean;
  /** Compact, but with the top / face / 3D switch (the Live's stage, a look's preview). */
  views?: boolean;
  /** Colours to show instead of the live output (a look's preview): fixture → its heads. */
  shownColors?: Record<string, string[]>;
  /** The view it opens on. */
  initialView?: "top" | "front" | "3d";
  /** Right-click (or a long press) on a zone: its menu, at that point. */
  onZoneMenu?: (zone: PlanZone, at: { x: number; y: number }) => void;
  /** « Déplacer les zones »: a zone dragged on the plan, its new corners. */
  onZoneMove?: (zone: PlanZone, polygon: [number, number][]) => void;
}) {
  const t = useT();
  const [liveColors, setColors] = useState<Record<string, string[]>>({});
  const [liveStrobe, setStrobe] = useState<Record<string, number | null>>({});
  const [liveBeams, setBeams] = useState<Record<string, Vec & { angle?: number; to: Vec }>>({});
  // a preview shows its own colours, without the live output's strobe and beams
  const colors = shownColors ?? liveColors;
  const strobe = shownColors ? {} : liveStrobe;
  const beams = shownColors ? {} : liveBeams;
  const [aiming, setAiming] = useState(false);
  const [placing, setPlacing] = useState(false);
  /** « Placer »: the fixture held (`held`) and those moving with it, from where the pointer took it. */
  const [drag, setDrag] = useState<{ held: string; ids: string[]; from: P; at: P; moved: boolean } | null>(null);
  /** « Placer »: the fixtures chosen, to move, line up or spread together. */
  const [chosen, setChosen] = useState<string[]>([]);
  /** A frame drawn on the stage to choose the fixtures inside (`add`: Ctrl/⌘ or Shift, to the others). */
  const [band, setBand] = useState<{ from: P; at: P; add: boolean } | null>(null);
  const [gridStep, setGridStep] = useStored("stagePlan.grid", 0.1);
  const [guides, setGuides] = useStored("stagePlan.guides", true);
  /** « Déplacer les zones »: on, a zone dragged moves (never by a stray click otherwise). */
  const [movingZones, setMovingZones] = useState(false);
  const [zoneDrag, setZoneDrag] = useState<{ id: string; from: { x: number; y: number }; at: { x: number; y: number } } | null>(null);
  const zoneMenu = useContextMenu<string>((at, id) => {
    const z = zones.find((x) => x.id === id);
    if (z) onZoneMenu?.(z, at);
  });
  const [orienting, setOrienting] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  /** Heading while dragging around the selected fixture, saved on release. */
  const [turning, setTurning] = useState<number | null>(null);
  const [view, setView] = useState<"top" | "front" | "3d">(initialView);
  const front = view === "front";
  const in3d = view === "3d";
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

  // the drawing's width on screen (zoom included): names keep a readable size, the grid its density
  const [drawnWidth, setDrawnWidth] = useState(W);
  useEffect(() => {
    const el = svg.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setDrawnWidth(w);
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const nameSize = Math.min(14, (NAME_PX * W) / drawnWidth);

  /** Each fixture's body as drawn: its heads, size, turn, and the room it takes around its centre. */
  const bodyOf = (f: PlanFixture) => {
    const all = colors[f.id] ?? ["#000000"];
    const h = Math.max(8, Math.min(28, 0.2 * scale));
    // a standing bar (roll near 90°), seen from above, is only its top: one square, its middle head's colour
    const roll = f.orientation?.roll ?? 0;
    const standing = Math.abs(Math.sin((roll * Math.PI) / 180)) > 0.7;
    const cols = !front && standing ? [all[Math.floor(all.length / 2)]!] : all;
    // sized in metres, so the plan reads at any scale: ~20 cm per head, 30 cm to 1.2 m wide
    const w = !front && standing ? h : Math.min(1.2, Math.max(0.3, cols.length * 0.2)) * scale;
    const o = orienting && selected === f.id && turning !== null ? { ...f.orientation, yaw: turning } : f.orientation;
    // seen from above, the body turns with its heading (its front, the long side, faces the audience at 0);
    // from the audience, with its roll (a standing bar, its first head at the bottom)
    const angle = front ? roll : !standing ? (o?.yaw ?? 0) : 0;
    const turn = (angle * Math.PI) / 180;
    // half the height and width the turned body takes on the plan: the name goes under it
    const halfHeight = Math.abs((w / 2) * Math.sin(turn)) + Math.abs((h / 2) * Math.cos(turn));
    const halfWidth = Math.abs((w / 2) * Math.cos(turn)) + Math.abs((h / 2) * Math.sin(turn));
    return { cols, w, h, o, angle, halfHeight, halfWidth };
  };
  // names under their fixture, else above, never over another; where they stand still (not dragged)
  const names = placeLabels(
    fixtures.map((f) => {
      const p = layout.pos.get(f.id)!;
      const { halfHeight } = bodyOf(f);
      return { id: f.id, x: sx(p.x), below: sy(p.y) + halfHeight + nameSize * 1.3, above: sy(p.y) - halfHeight - nameSize * 0.5, width: textWidth(f.name, nameSize) };
    }),
    nameSize,
  );
  // room for the names past the edges of the stage
  const pad = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const [id, y] of names) {
    const f = fixtures.find((x) => x.id === id)!;
    const [x, half] = [sx(layout.pos.get(id)!.x), textWidth(f.name, nameSize) / 2 + 2];
    pad.left = Math.max(pad.left, half - x);
    pad.right = Math.max(pad.right, x + half - W);
    pad.top = Math.max(pad.top, nameSize - y);
    pad.bottom = Math.max(pad.bottom, y + nameSize * 0.4 - H);
  }
  const [VW, VH] = [W + pad.left + pad.right, H + pad.top + pad.bottom];
  /** Screen pixels per metre. */
  const pxPerMetre = (scale * drawnWidth) / VW;

  const eventToStage = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return toStage(((e.clientX - r.left) / r.width) * VW - pad.left, ((e.clientY - r.top) / r.height) * VH - pad.top);
  };
  const snap = (v: number) => Math.round(v * 10) / 10;
  /** Where a point of the view puts a fixture: the front view's vertical is its height, its depth kept. */
  const positionOf = (f: PlanFixture, p: P): Vec =>
    front ? { x: p.x, y: f.position?.y ?? 1, z: Math.max(0, p.y) } : { x: p.x, y: p.y, z: f.position?.z ?? defaultHeight(f.mount) };
  const cm = (v: number) => Math.round(v * 100) / 100;
  /** The chosen fixtures moved by dx, dy (metres on the view), or put at the points given. */
  const moveTo = (points: (P & { id: string })[]) => {
    const moves = points.flatMap((p) => {
      const f = fixtures.find((x) => x.id === p.id);
      const was = layout.pos.get(p.id);
      return f && was && (cm(p.x) !== was.x || cm(p.y) !== was.y || !f.position) ? [{ fixture: f, position: positionOf(f, { x: cm(p.x), y: cm(p.y) }) }] : [];
    });
    if (moves.length) onMove?.(moves);
  };
  const shift = (ids: readonly string[], dx: number, dy: number) =>
    moveTo(ids.flatMap((id) => (layout.pos.has(id) ? [{ id, x: layout.pos.get(id)!.x + dx, y: layout.pos.get(id)!.y + dy }] : [])));
  const arrangeChosen = (how: Arrange) => moveTo(arrange(chosen.flatMap((id) => (layout.pos.has(id) ? [{ id, ...layout.pos.get(id)! }] : [])), how));
  /** The drag now: the held fixture on the grid or another's line, the others keeping their place around it. */
  const dragged = (() => {
    if (!drag?.moved) return undefined;
    const held = layout.pos.get(drag.held)!;
    const others = shown.fixtures.filter((f) => f.position && !drag.ids.includes(f.id)).map((f) => layout.pos.get(f.id)!);
    return dragOffset(held, { x: held.x + drag.at.x - drag.from.x, y: held.y + drag.at.y - drag.from.y }, others, { step: gridStep, guides, reach: 8 / pxPerMetre });
  })();
  /** Where a fixture is drawn: moved with the drag when it is part of it. */
  const placeOf = (id: string): P => {
    const p = layout.pos.get(id)!;
    return dragged && drag!.ids.includes(id) ? { x: p.x + dragged.dx, y: p.y + dragged.dy } : p;
  };
  /** The zone dragged, where it is now: by 10 cm. */
  const zoneOffset = zoneDrag ? [snap(zoneDrag.at.x - zoneDrag.from.x), snap(zoneDrag.at.y - zoneDrag.from.y)] : [0, 0];
  const dropZone = () => {
    if (!zoneDrag) return;
    const z = zones.find((x) => x.id === zoneDrag.id);
    const [dx, dy] = zoneOffset as [number, number];
    setZoneDrag(null);
    if (z && onZoneMove && (dx || dy)) onZoneMove(z, moveZone(z.polygon, dx, dy));
  };
  const dropDrag = () => {
    if (!drag) return;
    setDrag(null);
    if (dragged && (dragged.dx || dragged.dy)) shift(drag.ids, dragged.dx, dragged.dy);
  };
  const dropBand = () => {
    if (!band) return;
    setBand(null);
    // a click on the stage, not a frame: lets the chosen fixtures go
    if (Math.hypot(band.at.x - band.from.x, band.at.y - band.from.y) * pxPerMetre < 4) return band.add ? undefined : setChosen([]);
    const inside = fixtures.filter((f) => inFrame(layout.pos.get(f.id)!, band.from, band.at)).map((f) => f.id);
    setChosen(band.add ? [...new Set([...chosen, ...inside])] : inside);
  };
  // keyboard, while placing: the arrows nudge the chosen fixtures by a grid step (×10 with Shift), Escape lets them go
  useEffect(() => {
    if (!placing || !chosen.length || !onMove) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "Escape") return setChosen([]);
      const d = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] } as Record<string, [number, number]>)[e.key];
      if (!d) return;
      e.preventDefault();
      const step = (gridStep || 0.01) * (e.shiftKey ? 10 : 1);
      shift(chosen, d[0] * step, d[1] * step);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
    if (!d || !f.position || (dragged && drag!.ids.includes(f.id))) return null;
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

  const viewSwitch = (
    <span className="row view-switch">
      <button className={view === "top" ? "ghost on" : "ghost"} aria-pressed={view === "top"} onClick={() => setView("top")}>
        {t.viewTop}
      </button>
      <button className={front ? "ghost on" : "ghost"} aria-pressed={front} onClick={() => (setView("front"), setAiming(false))}>
        {t.viewFront}
      </button>
      <button className={in3d ? "ghost on" : "ghost"} aria-pressed={in3d} title={t.view3dHelp} onClick={() => (setView("3d"), setAiming(false), setPlacing(false), setOrienting(false))}>
        {t.view3d}
      </button>
    </span>
  );
  /** The 3D view is drawn by the full plan, or a compact one with its views. */
  const show3d = in3d && (!compact || views);
  return (
    <div className={compact ? "stage-plan compact" : "stage-plan"}>
      {compact && views && <div className="row view-row">{viewSwitch}</div>}
      {!compact && (
        <div className="row">
        <small className="hint">
          {front ? t.audienceFacing : `${t.audience} ↓`}{layout.unplaced ? ` · ${layout.unplaced} ${t.unplaced}` : ""}
        </small>
        {onMove && !in3d && (
          <label className="row">
            <input type="checkbox" checked={placing} onChange={(e) => (setPlacing(e.target.checked), setAiming(false), setOrienting(false), setMovingZones(false), setChosen([]))} /> {t.placeMode}
          </label>
        )}
        {placing && !in3d && (
          <>
            <label className="row" title={t.gridHelp}>
              {t.gridLabel}
              <select value={gridStep} onChange={(e) => setGridStep(Number(e.target.value))}>
                {GRID_STEPS.map((s) => (
                  <option key={s} value={s}>
                    {s === 0 ? t.gridFree : s < 1 ? `${Math.round(s * 100)} cm` : `${s} m`}
                  </option>
                ))}
              </select>
            </label>
            <label className="row" title={t.guidesHelp}>
              <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} /> {t.guidesMode}
            </label>
          </>
        )}
        {onZoneMove && !front && !in3d && (
          <label className="row" title={t.moveZonesHelp}>
            <input type="checkbox" checked={movingZones} onChange={(e) => (setMovingZones(e.target.checked), setPlacing(false), setOrienting(false), setAiming(false))} /> {t.moveZones}
          </label>
        )}
        {onOrient && !in3d && (
          <label className="row">
            <input type="checkbox" checked={orienting} onChange={(e) => (setOrienting(e.target.checked), setPlacing(false), setAiming(false), setSelected(null))} /> {t.orientMode}
          </label>
        )}
        {viewSwitch}
        {!in3d && (
        <span className="row zoom">
          <button className="ghost" aria-label={t.zoomOut} title={t.zoomOut} disabled={zoom <= ZOOMS[0]!} onClick={() => zoomTo(ZOOMS[ZOOMS.indexOf(zoom) - 1] ?? 1)}>
            −
          </button>
          <small>×{zoom}</small>
          <button className="ghost" aria-label={t.zoomIn} title={t.zoomIn} disabled={zoom >= ZOOMS[ZOOMS.length - 1]!} onClick={() => zoomTo(ZOOMS[ZOOMS.indexOf(zoom) + 1] ?? zoom)}>
            +
          </button>
        </span>
        )}
        {heads > 0 && !placing && !orienting && !front && !in3d && (
          <label className="row">
            <input type="checkbox" checked={aiming} onChange={(e) => setAiming(e.target.checked)} /> {t.aimMode}
          </label>
        )}
        </div>
      )}
      {placing && !compact && !in3d && (
        <div className="place-panel row">
          {chosen.length > 1 ? (
            <>
              <strong>
                {chosen.length} {t.fixturesChosen}
              </strong>
              <button onClick={() => arrangeChosen("row")} title={front ? t.sameHeightHelp : t.sameRowHelp}>
                {front ? t.sameHeight : t.sameRow}
              </button>
              <button onClick={() => arrangeChosen("column")} title={t.sameColumnHelp}>
                {t.sameColumn}
              </button>
              <button onClick={() => arrangeChosen("spreadX")} title={t.spreadHelp}>
                {t.spreadAcross}
              </button>
              <button onClick={() => arrangeChosen("spreadY")} title={t.spreadHelp}>
                {front ? t.spreadHeight : t.spreadDepth}
              </button>
              <button className="ghost" onClick={() => setChosen([])}>
                {t.unchoose}
              </button>
            </>
          ) : (
            <small className="place-help">{t.placeHelp}</small>
          )}
        </div>
      )}
      {show3d && (
        <Suspense fallback={<p className="hint">…</p>}>
          <Stage3D fixtures={fixtures} zones={zones} colors={colors} beams={beams} noWebgl={t.noWebgl} label={t.view3dLabel} />
        </Suspense>
      )}
      <div className="plan-scroll" ref={scroller} hidden={show3d}>
      <svg
        ref={svg}
        viewBox={`${-pad.left} ${-pad.top} ${VW} ${VH}`}
        className={aiming ? "aiming" : placing ? "placing" : orienting ? "orienting" : movingZones && !front ? "moving-zones" : ""}
        style={zoom > 1 ? { width: `${zoom * 100}%`, maxWidth: "none" } : undefined}
        onClick={aimAt}
        onPointerDown={(e) => {
          // « Placer », pressed on the stage rather than a fixture: a frame to choose those inside
          if (!placing || in3d) return;
          // a finger stays with what it touched (a zone's long press still hears it lift); a mouse is held here
          if (e.pointerType !== "touch") svg.current?.setPointerCapture(e.pointerId);
          const p = eventToStage(e);
          setBand({ from: p, at: p, add: e.ctrlKey || e.metaKey || e.shiftKey });
        }}
        onPointerMove={(e) => {
          if (zoneDrag) return setZoneDrag({ ...zoneDrag, at: eventToStage(e) });
          if (band) return setBand({ ...band, at: eventToStage(e) });
          if (!drag) return turnTo(e);
          const at = eventToStage(e);
          // a few pixels before it moves: a click only chooses
          setDrag({ ...drag, at, moved: drag.moved || Math.hypot(at.x - drag.from.x, at.y - drag.from.y) * pxPerMetre > 3 });
        }}
        onPointerUp={() => (dropZone(), dropDrag(), dropBand(), dropTurn())}
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
        <rect x={-pad.left} y={-pad.top} width={VW} height={VH} fill="#12141a" />
        {front && <line x1={-pad.left} x2={W + pad.right} y1={sy(0)} y2={sy(0)} stroke="#3b4150" />}
        {shown.zones.map((zone) => {
          const z = zoneDrag?.id === zone.id ? { ...zone, polygon: moveZone(zone.polygon, zoneOffset[0]!, zoneOffset[1]!) } : zone;
          const menu = onZoneMenu ? zoneMenu(z.id) : undefined;
          return (
          <g
            key={z.id}
            className={zoneDrag?.id === z.id ? "zone dragged" : "zone"}
            data-zone={z.id}
            {...menu}
            onPointerDown={(e) => {
              if (movingZones && !front && onZoneMove && !placing && !orienting && !aiming) {
                e.stopPropagation();
                svg.current?.setPointerCapture(e.pointerId);
                const p = eventToStage(e);
                setZoneDrag({ id: z.id, from: p, at: p });
                return;
              }
              menu?.onPointerDown(e);
            }}
          >
            <polygon points={z.polygon.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ")} fill={ZONE_FILL[z.type] ?? "#262a33"} stroke={z.protected || z.noAim ? "#e5484d" : "#3b4150"} strokeDasharray={z.protected || z.noAim ? "6 4" : undefined} />
            {z.noAim && <polygon className="no-aim" points={z.polygon.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ")} fill="url(#no-aim)" />}
            <text x={sx(z.polygon.reduce((a, p) => a + p[0], 0) / z.polygon.length)} y={sy(Math.max(...z.polygon.map((p) => p[1]))) + 14} textAnchor="middle" className="zone-name">
              {z.name}
              {z.protected ? ` (${t.protectedZone})` : ""}
              {z.noAim ? ` (${t.noAimZone})` : ""}
            </text>
          </g>
          );
        })}
        {placing && gridStep > 0 && (() => {
          // the magnetic grid, while placing: its step where it reads (8 px apart at least), its metres otherwise
          const step = gridStep * pxPerMetre >= 8 ? gridStep : pxPerMetre >= 8 ? 1 : 0;
          if (!step) return null;
          const along = (lo: number, hi: number) => Array.from({ length: Math.floor(hi / step) - Math.ceil(lo / step) + 1 }, (_, i) => cm((Math.ceil(lo / step) + i) * step));
          const metre = (v: number) => Math.abs(v - Math.round(v)) < 0.001;
          return (
            <g className="plan-grid" aria-hidden>
              {along(layout.minX, layout.maxX).map((x) => (
                <line key={`x${x}`} className={metre(x) ? "metre" : undefined} x1={sx(x)} x2={sx(x)} y1={-pad.top} y2={H + pad.bottom} />
              ))}
              {along(layout.minY, layout.maxY).map((y) => (
                <line key={`y${y}`} className={metre(y) ? "metre" : undefined} x1={-pad.left} x2={W + pad.right} y1={sy(y)} y2={sy(y)} />
              ))}
            </g>
          );
        })()}
        {dragged?.guide.x !== undefined && <line className="plan-guide" x1={sx(dragged.guide.x)} x2={sx(dragged.guide.x)} y1={-pad.top} y2={H + pad.bottom} />}
        {dragged?.guide.y !== undefined && <line className="plan-guide" x1={-pad.left} x2={W + pad.right} y1={sy(dragged.guide.y)} y2={sy(dragged.guide.y)} />}
        {/* light first, under every fixture: a cone where the beam is known, a halo otherwise */}
        {fixtures.map((f) => {
          const p = placeOf(f.id);
          const lit = (colors[f.id] ?? []).filter((c) => c !== "#000000");
          if (!lit.length) return null;
          const beam = cone(f, lit[Math.floor(lit.length / 2)]!);
          if (beam) return beam;
          const w = Math.min(1.2, Math.max(0.3, (colors[f.id]?.length ?? 1) * 0.2)) * scale;
          const h = Math.max(8, Math.min(28, 0.2 * scale));
          return <ellipse key={`halo-${f.id}`} cx={sx(p.x)} cy={sy(p.y)} rx={w * 0.75} ry={h * 1.5} fill={lit[Math.floor(lit.length / 2)]} opacity={0.22} />;
        })}
        {fixtures.map((f) => {
          const p = placeOf(f.id);
          const { cols, w, h, o, angle, halfHeight, halfWidth } = bodyOf(f);
          const cw = w / cols.length;
          const x0 = sx(p.x) - w / 2;
          const y0 = sy(p.y) - h / 2;
          const isSelected = (orienting && selected === f.id) || (placing && chosen.includes(f.id));
          const body = angle ? `rotate(${-angle} ${sx(p.x)} ${sy(p.y)})` : undefined;
          // the beam, projected on the view; what is left points at or away from the viewer
          const d = beam(o);
          const [px, py, toward] = front ? [d.x, -d.z, -d.y] : [d.x, -d.y, d.z];
          const reach = Math.max(w, h) / 2 + 16;
          const showBeam = Boolean(f.orientation) || (orienting && isSelected);
          // its name where it was laid out, following it while dragged; on hover only when there was no room
          const nameAt = names.get(f.id);
          const nameY = nameAt === undefined ? undefined : nameAt + sy(p.y) - sy(layout.pos.get(f.id)!.y);
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
                // Ctrl/⌘ or Shift: one more chosen, or one less
                if (e.ctrlKey || e.metaKey || e.shiftKey) return setChosen(chosen.includes(f.id) ? chosen.filter((id) => id !== f.id) : [...chosen, f.id]);
                const ids = chosen.includes(f.id) ? chosen : [f.id];
                setChosen(ids);
                svg.current?.setPointerCapture(e.pointerId);
                const at = eventToStage(e);
                setDrag({ held: f.id, ids, from: at, at, moved: false });
              }}
            >
              <title>{f.name}</title>
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
                    <g transform={`translate(${sx(p.x) + halfWidth + 10} ${sy(p.y) - halfHeight - 2})`} /* by the body's corner as drawn, a standing bar's too */>
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
              {nameY !== undefined && (
                <text x={sx(p.x)} y={nameY} textAnchor="middle" className="fixture-name" style={{ fontSize: `${nameSize}px`, ...(f.color ? { fill: f.color } : {}) }}>
                  {f.name}
                </text>
              )}
            </g>
          );
        })}
        {band && <rect className="plan-band" x={Math.min(sx(band.from.x), sx(band.at.x))} y={Math.min(sy(band.from.y), sy(band.at.y))} width={Math.abs(sx(band.at.x) - sx(band.from.x))} height={Math.abs(sy(band.at.y) - sy(band.from.y))} />}
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
              {(colors[selectedFixture.id]?.length ?? 1) > 1 && (
                <>
                  <span className="hint">{t.barLabel}</span>
                  {([0, 90] as const).map((r) => {
                    const on = Math.round(selectedFixture.orientation?.roll ?? 0) === r;
                    return (
                      <button key={r} className={on ? "on" : ""} aria-pressed={on} title={t.barHelp} onClick={() => onOrient(selectedFixture, { roll: r })}>
                        {r === 0 ? `━ ${t.barAcross}` : `┃ ${t.barStanding}`}
                      </button>
                    );
                  })}
                </>
              )}
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
export function LiveStage({ onError, shownColors, views = false, initialView }: { onError: (msg: string) => void; shownColors?: Record<string, string[]>; views?: boolean; initialView?: "top" | "front" | "3d" }) {
  const [fixtures, setFixtures] = useState<PlanFixture[]>([]);
  const [zones, setZones] = useState<PlanZone[]>([]);
  useEffect(() => {
    void cmd<PlanFixture[]>("venue.fixture.list").then(setFixtures).catch(() => undefined);
    void cmd<PlanZone[]>("stage.zone.list").then(setZones).catch(() => undefined);
  }, []);
  return <StagePlan fixtures={fixtures} zones={zones} onError={onError} compact views={views} shownColors={shownColors} initialView={initialView} />;
}
