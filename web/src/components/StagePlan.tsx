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
 * no moving head may point into is hatched. « Dessiner une zone » (T27): a rectangle or an ellipse dragged by its box,
 * a polygon corner by corner, with the mouse, a finger or the keyboard (arrows move a cursor, Space puts a corner), on
 * the magnetic grid; the page then asks the zone's name and settings. An aiming zone is outlined in its colour with a
 * reticle on its aiming point; in « Viser », a click in it aims at that point (the exact point with Alt / Option).
 */
import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { stream } from "../ws";
import { useDomainEvents } from "../hooks/useTopic";
import { useContextMenu } from "./menu";
import { aimSpot, cachedZoneCentre, ellipseFromDrag, ellipsePolygon, movedZone, rectFromDrag, reshapedZone, validZone, zoneAt, type Pt, type ZoneHandle, type ZoneOutline } from "../zone-shape";
import { arrange, dragOffset, inFrame, placeLabels, textWidth, type Arrange, type P } from "../plan-tools";
import { pointerToDrawing, stageFrame, stageLayout } from "../stage-frame";
import { metresText } from "../target-status";
import { textOn } from "../color";
import { useStored } from "../hooks/useStored";
import { FixturePanel } from "./FixturePanel";

/** The 3D view, loaded when first opened: three.js stays out of the rest of the interface. */
const Stage3D = lazy(() => import("./Stage3D"));

export interface PlanFixture {
  id: string;
  name: string;
  role?: string;
  mount?: string;
  position?: { x: number; y: number; z: number };
  /** Pan or tilt channels in its definition (venue.fixture.list): the invert switches live on these only. */
  movable?: boolean;
  /** yaw: 0 audience, 90 cour, 180 upstage, −90 jardin; pitch: −90 floor … 90 ceiling (venue/orientation.ts).
   *  invertPan/invertTilt: a head whose pan or tilt runs the other way round (venue.fixture.orient). */
  orientation?: { yaw: number; pitch?: number; roll?: number; invertPan?: boolean; invertTilt?: boolean };
  /** The named facing the orientation matches (venue.fixture.list). */
  facing?: Facing;
  /** Marker colour (venue.fixture.mark): the name is written in it. */
  color?: string;
  /** Not installed for the open show: dark, no DMX, dimmed on the plan. */
  absent?: boolean;
}
export type Facing = "audience" | "upstage" | "houseLeft" | "houseRight" | "ceiling" | "floor";
export type OrientChange = { facing?: Facing; yaw?: number; pitch?: number; turn?: number; roll?: number; invertPan?: boolean; invertTilt?: boolean };
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
/** A 3D target (T24) drawn on the plan: a reticle in its colour, its height beside it (dashed while not engaged). */
export interface PlanTarget {
  id: string;
  name: string;
  point: { x: number; y: number; z: number };
  color?: string;
  engaged: boolean;
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
  /** An aiming zone (T27): the moving heads can be sent to it, at `height` above its floor, at `point` (else its centre). */
  aim?: { height: number; point?: Pt; color?: string };
  /** How it was drawn (T27), listed only while it still describes the polygon. */
  outline?: ZoneOutline;
}
/** A zone drawn on the plan (T27), before it has a name. */
export interface DrawnZone {
  polygon: Pt[];
  outline: ZoneOutline;
}
type DrawTool = "rect" | "ellipse" | "polygon";
const DRAW_TOOLS: DrawTool[] = ["rect", "ellipse", "polygon"];
/** An aiming zone's colour when it has none of its own: a CSS token (styles.css). */
export const AIM_COLOR = "var(--aim-color)";

const ZONE_FILL: Record<string, string> = { stage: "#2a2f3b", riser: "#343b4a", floor: "#22262f", audience: "#1b2a22", wall: "#3a2f2a", pillar: "#3a2f2a", backdrop: "#30283a" };

/** Default height of a fixture placed for the first time, from its mount (metres). */
const defaultHeight = (mount?: string) => (mount === "hung" || mount === "truss" || mount === "ceiling" ? 5 : mount === "stand" ? 1.8 : mount === "wall" || mount === "pillar" ? 3 : 0.3);

export function StagePlan({
  fixtures,
  zones,
  onError,
  onMove,
  onOrient,
  onSelect,
  compact = false,
  views = false,
  shownColors,
  initialView = "top",
  onZoneMenu,
  onFixtureMenu,
  onZoneMove,
  onZoneDraw,
  pending,
  beamsShown = true,
  controls,
  collapsed = false,
  height,
  targets = [],
}: {
  fixtures: PlanFixture[];
  zones: PlanZone[];
  onError: (msg: string) => void;
  /** « Placer »: fixtures moved (one dragged, or several at once), their new positions. */
  onMove?: (moves: { fixture: PlanFixture; position: Vec }[]) => void;
  onOrient?: (fixture: PlanFixture, change: OrientChange) => void;
  /** A fixture held on the plan (selected), or none: the page follows it (calibration, panel). */
  onSelect?: (id: string | null) => void;
  compact?: boolean;
  /** Compact, but with the top / face / 3D switch (the Live's stage, a look's preview). */
  views?: boolean;
  /** Colours to show instead of the live output (a look's preview): fixture → its heads. */
  shownColors?: Record<string, string[]>;
  /** The view it opens on. */
  initialView?: "top" | "front" | "3d";
  /** Right-click (or a long press) on a zone: its menu, at that point. */
  onZoneMenu?: (zone: PlanZone, at: { x: number; y: number; before?: number }) => void;
  /** Right-click (a long press, or Shift+F10 on a focused fixture) on a fixture: its menu, at that point (the patch's fixture menu). */
  onFixtureMenu?: (fixture: PlanFixture, at: { x: number; y: number }) => void;
  /** « Déplacer les zones »: a zone dragged on the plan, moved (its corners, its placed aiming point, its drawn ellipse). */
  onZoneMove?: (zone: PlanZone, moved: PlanZone) => void;
  /**
   * « Dessiner une zone » (T27): a shape closed on the plan, and where on screen, beside it (the page asks its name and
   * settings); `reopen` puts a polygon back open on the plan, to fix it (the form cancelled).
   */
  onZoneDraw?: (shape: DrawnZone, at: { x: number; y: number; before?: number }, reopen: () => void) => void;
  /** The shape drawn while the page asks its name: drawn dashed with its centre, and the plan ignores pointers meanwhile. */
  pending?: DrawnZone | null;
  /** Beams drawn (cones, the arrows of where fixtures point); off, a lit fixture only glows. */
  beamsShown?: boolean;
  /** With the views: more switches before them (the Live's stage: fold it, its beams). */
  controls?: ReactNode;
  /** Folded: only the row of the views stays, the drawing is left out. */
  collapsed?: boolean;
  /** A height chosen for the drawing (px), which fits inside; none: from its width. */
  height?: number;
  /** 3D targets to draw (the venue's plan, T24): at their point seen from above, or at their height from the front. */
  targets?: PlanTarget[];
}): ReactElement {
  const t = useT();
  const [liveColors, setColors] = useState<Record<string, string[]>>({});
  const [liveStrobe, setStrobe] = useState<Record<string, number | null>>({});
  const [liveBeams, setBeams] = useState<Record<string, Vec & { angle?: number; to: Vec }>>({});
  // a preview shows its own colours, without the live output's strobe and beams
  const colors = shownColors ?? liveColors;
  const strobe = shownColors ? {} : liveStrobe;
  const beams = shownColors || !beamsShown ? {} : liveBeams;
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
  /** A handle moved by the keyboard: the position the plan drew and the one sent from it, until the plan draws it (T27). */
  const keyedHandle = useRef<{ key: string; drawn: P; sent: P } | null>(null);
  /** « Déplacer les zones » (T27, lot Z4): a polygon's corner (`index`) or a zone's aiming point (`aim`) held, where it is now. */
  // `from`: where the pointer went down; `moved`: once it went a few pixels from there (a click alone writes nothing)
  const [handleDrag, setHandleDrag] = useState<{ id: string; handle: ZoneHandle; at: P; from: P; moved: boolean } | null>(null);
  /** Why a reshaped zone was refused (its edges cross): said by the plan's tools. */
  const [moveError, setMoveError] = useState("");
  /** « Dessiner une zone » (T27): the shape being drawn, or none. */
  const [drawTool, setDrawTool] = useState<DrawTool | null>(null);
  /** A rectangle or an ellipse: its box, from the first corner (Shift: square). */
  const [shapeDrag, setShapeDrag] = useState<{ from: P; at: P; square: boolean } | null>(null);
  /** A polygon: the corners put so far. */
  const [corners, setCorners] = useState<P[]>([]);
  /** Where the next corner would go (the pointer, or the keyboard's cursor), on the grid. */
  const [cursor, setCursor] = useState<P | null>(null);
  /** Why the shape just closed cannot be a zone: said by the drawing tools, not at the top of the page. */
  const [drawError, setDrawError] = useState("");
  /** « Point exact » (T27, decision Z3): in « Viser », a click in an aiming zone aims at the point clicked, as Alt does. */
  const [exact, setExact] = useState(false);
  /** The cursor was moved by the keyboard: said aloud (never as the mouse moves). */
  const [cursorKeyed, setCursorKeyed] = useState(false);
  const drawHelp = useId();
  const zoneMenu = useContextMenu<string>((at, id) => {
    const z = zones.find((x) => x.id === id);
    if (!z) return;
    // a finger: the menu opens beside the zone (its top right), not over it under the finger
    const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    onZoneMenu?.(z, coarse && !front ? besideZone(z.polygon) : at);
  });
  const fixtureMenu = useContextMenu<string>((at, id) => {
    const f = fixtures.find((x) => x.id === id);
    if (f) onFixtureMenu?.(f, at);
  });
  const [orienting, setOrienting] = useState(false);
  /**
   * The selected fixture, held outside the modes: a click on a fixture selects it (in « Orienter » it
   * starts a turn too), the control panel below the plan lets it go (Escape too, while orienting). Survives leaving a mode.
   */
  const [selected, setSelected] = useState<string | null>(null);
  /** A held fixture, echoed to the page (the calibration box follows it). */
  const select = useCallback(
    (id: string | null) => {
      setSelected(id);
      onSelect?.(id);
    },
    [onSelect],
  );
  /** Heading while dragging around the selected fixture, saved on release. */
  const [turning, setTurning] = useState<number | null>(null);
  const [view, setView] = useState<"top" | "front" | "3d">(initialView);
  const front = view === "front";
  const in3d = view === "3d";
  /** « Dessiner une zone » is on: seen from above, on a plan that can create zones. */
  const drawing = drawTool !== null && onZoneDraw !== undefined && view === "top";
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
  /** The moving heads (position.list): whether « Viser » shows, and a held selection is only narrowed to one. */
  const [heads, setHeads] = useState<string[]>([]);
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
  const readHeads = useCallback(() => {
    void cmd<{ id: string }[]>("position.list").then((h) => setHeads(h.map((x) => x.id))).catch(() => undefined);
  }, []);
  useEffect(readHeads, [readHeads, fixtures]);
  // the heads move from elsewhere too (another screen, MIDI, an aim, a Panic): read again
  useDomainEvents(["motion", "positions", "settings", "show"], readHeads);

  // Frame: zones and placed fixtures, with a margin; unplaced fixtures go on a row in front (stage-frame.ts).
  // the targets (T24) are framed too (D2): a target outside the zones widens the plan instead of being cut at its edge;
  // from the front, at their height. The fixtures with no position keep their row in front.
  const targetSpots = targets.map((tg) => (front ? { x: tg.point.x, y: tg.point.z } : { x: tg.point.x, y: tg.point.y }));
  const targetKey = targetSpots.map((p) => `${p.x},${p.y}`).join(";");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the targets' places, not the list's identity (read again after every command)
  const layout = useMemo(() => stageLayout(shown.fixtures, shown.zones, targetSpots), [shown, targetKey]);

  const W = 800;
  // upstage at the top, audience at the bottom
  const { scale, H, sx, sy, toStage } = stageFrame(layout, W);

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
  // targets (T24): where they are on this view (from the front, at their height), their reticle's size, their label
  const targetRing = Math.max(7, Math.min(16, 0.2 * scale));
  const drawnTargets = targets.map((tg, i) => ({ ...tg, at: targetSpots[i]!, label: `${tg.name} · ${metresText(tg.point.z, t.decimalMark)} m` }));
  // names under their fixture, else above, never over another; where they stand still (not dragged); the targets' after
  const names = placeLabels(
    [
      ...fixtures.map((f) => {
        const p = layout.pos.get(f.id)!;
        const { halfHeight } = bodyOf(f);
        return { id: f.id, x: sx(p.x), below: sy(p.y) + halfHeight + nameSize * 1.3, above: sy(p.y) - halfHeight - nameSize * 0.5, width: textWidth(f.name, nameSize) };
      }),
      ...drawnTargets.map((tg) => ({ id: `target:${tg.id}`, x: sx(tg.at.x), below: sy(tg.at.y) + targetRing + nameSize * 1.1, above: sy(tg.at.y) - targetRing - nameSize * 0.4, width: textWidth(tg.label, nameSize) })),
    ],
    nameSize,
  );
  // room for the names past the edges of the stage
  const pad = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const [id, y] of names) {
    // a fixture's name, or a target's label (its point widened the frame, its label gets room as a name does)
    const f = fixtures.find((fx) => fx.id === id);
    const tg = f ? undefined : drawnTargets.find((d) => `target:${d.id}` === id);
    if (!f && !tg) continue;
    const [x, half] = f ? [sx(layout.pos.get(id)!.x), textWidth(f.name, nameSize) / 2 + 2] : [sx(tg!.at.x), textWidth(tg!.label, nameSize) / 2 + 2];
    pad.left = Math.max(pad.left, half - x);
    pad.right = Math.max(pad.right, x + half - W);
    pad.top = Math.max(pad.top, nameSize - y);
    pad.bottom = Math.max(pad.bottom, y + nameSize * 0.4 - H);
  }
  const [VW, VH] = [W + pad.left + pad.right, H + pad.top + pad.bottom];
  /** Screen pixels per metre. */
  const pxPerMetre = (scale * drawnWidth) / VW;
  // zone names: readable at any zoom (12 px on screen at least), inside the zone at its top, else at its bottom, never
  // one over another (stacked zones); the rest on hover (their title)
  const zoneNameSize = Math.min(16, (12 * W) / drawnWidth);
  const zoneNames = placeLabels(
    shown.zones.map((z) => {
      const xs = z.polygon.map((p) => p[0]);
      const ys = z.polygon.map((p) => p[1]);
      const label = `${z.name}${z.protected ? ` (${t.protectedZone})` : ""}${z.noAim ? ` (${t.noAimZone})` : ""}`;
      return { id: z.id, x: sx((Math.min(...xs) + Math.max(...xs)) / 2), below: sy(Math.max(...ys)) + zoneNameSize * 1.4, above: sy(Math.min(...ys)) - zoneNameSize * 0.35, width: textWidth(label, zoneNameSize) };
    }),
    zoneNameSize,
  );

  const eventToStage = (e: { clientX: number; clientY: number }) => {
    const { px, py } = pointerToDrawing(e, svg.current!.getBoundingClientRect(), VW, VH, pad);
    return toStage(px, py);
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
    if (z && onZoneMove && (dx || dy)) onZoneMove(z, movedZone(z, dx, dy));
  };
  /** A handle let go, or nudged by a key: the zone reshaped is written when the server would take it, else said. */
  const commitHandle = (z: PlanZone, handle: ZoneHandle, p: P) => {
    const next = reshapedZone(z, handle, onGrid(onPlan(p)));
    if (JSON.stringify(next) === JSON.stringify(z)) return;
    if (handle !== "aim" && !validZone(next.polygon)) return setMoveError(t.zoneDraw.invalid);
    setMoveError("");
    onZoneMove?.(z, next);
  };
  const dropHandle = () => {
    if (!handleDrag) return;
    setHandleDrag(null);
    if (!handleDrag.moved) return;
    const z = zones.find((x) => x.id === handleDrag.id);
    if (z) commitHandle(z, handleDrag.handle, handleDrag.at);
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
    const framed = fixtures.filter((f) => inFrame(layout.pos.get(f.id)!, band.from, band.at)).map((f) => f.id);
    setChosen(band.add ? [...new Set([...chosen, ...framed])] : framed);
  };
  // keyboard, while placing: the arrows nudge the chosen fixtures by a grid step (×10 with Shift), Escape lets them go
  useEffect(() => {
    if (!placing || !chosen.length || !onMove) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.defaultPrevented || el?.getAttribute("role") === "slider") return; // a pad or a fader already took the key
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
      if (e.defaultPrevented || el?.getAttribute("role") === "slider") return; // a pad or a fader already took the key
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        onOrient(selectedFixture, { turn: e.key === "ArrowLeft" ? 15 : -15 });
      } else if (e.key === "Escape") select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [orienting, selectedFixture, onOrient, select]);
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
    const project = (v: Vec) => [sx(v.x), sy(front ? v.z : v.y)] as const;
    const [ox, oy] = project(f.position);
    const [ex, ey] = project(end);
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

  // ---- « Dessiner une zone » (T27)
  /** Drawing units per screen pixel: marks keep their size on screen at any zoom. */
  const unit = VW / drawnWidth;
  /** A zone's handles (lot Z4), px on screen: a finger's size on a touch screen. */
  const handleRadius = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches ? 14 : 7;
  /** A point of the plan on the magnetic grid (to the centimetre when free). */
  const onGrid = (p: P): P => {
    const step = gridStep || 0.01;
    return { x: cm(Math.round(p.x / step) * step), y: cm(Math.round(p.y / step) * step) };
  };
  /** The tool chosen, or none (leaving the mode): what was being drawn is dropped, the other modes are left. */
  const chooseTool = (tool: DrawTool | null) => {
    setShapeDrag(null);
    setCorners([]);
    setDrawError("");
    if (!tool) setCursor(null);
    setDrawTool(tool);
    if (!tool) return;
    setPlacing(false);
    setAiming(false);
    setOrienting(false);
    setMovingZones(false);
    setChosen([]);
  };
  const resetDraw = () => (setShapeDrag(null), setCorners([]), setDrawError(""));
  /** A point kept on the plan (the keyboard's cursor never leaves it). */
  const onPlan = (p: P): P => ({ x: Math.min(layout.maxX, Math.max(layout.minX, p.x)), y: Math.min(layout.maxY, Math.max(layout.minY, p.y)) });
  /** The rectangle or the ellipse a box gives, as corners. */
  const boxShape = (d: { from: P; at: P; square: boolean }): Pt[] => {
    if (drawTool !== "ellipse") return rectFromDrag(d.from, d.at, d.square);
    const e = ellipseFromDrag(d.from, d.at, d.square);
    return ellipsePolygon(e.cx, e.cy, e.rx, e.ry);
  };
  /** Where a point of the plan is on screen: the form opens there. */
  const screenOf = (p: P) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: r.left + ((sx(p.x) + pad.left) / VW) * r.width, y: r.top + ((sy(p.y) + pad.top) / VH) * r.height };
  };
  /** Where a menu or a form opens so as not to hide a zone: at its top right on screen. */
  const besideZone = (polygon: readonly Pt[]) => {
    const at = screenOf({ x: Math.max(...polygon.map((p) => p[0])), y: Math.max(...polygon.map((p) => p[1])) });
    // with no room on its right, the menu goes on its left
    const left = screenOf({ x: Math.min(...polygon.map((p) => p[0])), y: 0 }).x;
    return { x: at.x + 12, y: at.y, before: left - 12 };
  };
  /** A shape closed: handed to the page when the server would take it, else said by the tools (and a polygon stays open). */
  const finishShape = (polygon: Pt[], outline: ZoneOutline) => {
    if (!validZone(polygon)) return setDrawError(t.zoneDraw.invalid);
    const kept = corners;
    resetDraw();
    setCursor(null);
    const reopen = outline.kind === "polygon" ? () => (setDrawTool("polygon"), setCorners(kept)) : () => undefined;
    // the form opens beside the shape, so it does not hide it where there is room
    onZoneDraw?.({ polygon, outline }, besideZone(polygon), reopen);
  };
  const finishBox = (d: { from: P; at: P; square: boolean }) => {
    setShapeDrag(null);
    if (drawTool === "ellipse") {
      const e = ellipseFromDrag(d.from, d.at, d.square);
      return finishShape(ellipsePolygon(e.cx, e.cy, e.rx, e.ry), { kind: "ellipse", ...e });
    }
    finishShape(rectFromDrag(d.from, d.at, d.square), { kind: "rect" });
  };
  const closePolygon = () => {
    if (corners.length >= 3) finishShape(corners.map((c) => [c.x, c.y]), { kind: "polygon" });
  };
  /** A polygon's corner: on the first one (a finger gets more room), the polygon closes; on the last one (a double-click's second click), nothing. */
  const addCorner = (p: P, touch = false) => {
    const [first, last] = [corners[0], corners[corners.length - 1]];
    if (first && corners.length >= 3 && Math.hypot(p.x - first.x, p.y - first.y) * pxPerMetre <= (touch ? 24 : 12)) return closePolygon();
    if (last && Math.hypot(p.x - last.x, p.y - last.y) * pxPerMetre < 4) return;
    setDrawError("");
    setCorners([...corners, p]);
  };
  // while the page asks the name of a shape just drawn, the plan takes no pointer: a double-click's second click, a
  // stray tap, would start another shape under the form
  const drawDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (pending || (e.pointerType === "mouse" && e.button !== 0)) return;
    svg.current?.focus({ preventScroll: true });
    const p = onGrid(eventToStage(e));
    // a finger has no hover: no cursor left behind where it lifted
    if (e.pointerType !== "touch") setCursor(p);
    if (drawTool === "polygon") return;
    svg.current?.setPointerCapture(e.pointerId);
    setShapeDrag({ from: p, at: p, square: e.shiftKey });
  };
  const drawMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (pending) return;
    const p = onGrid(eventToStage(e));
    setCursorKeyed(false);
    if (e.pointerType !== "touch") setCursor(p);
    if (shapeDrag) setShapeDrag({ ...shapeDrag, at: p, square: e.shiftKey });
  };
  const drawUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (pending || (e.pointerType === "mouse" && e.button !== 0)) return;
    const p = onGrid(eventToStage(e));
    if (drawTool === "polygon") return addCorner(p, e.pointerType === "touch");
    if (!shapeDrag) return;
    // a press without a drag draws nothing
    if (Math.hypot(p.x - shapeDrag.from.x, p.y - shapeDrag.from.y) * pxPerMetre < 4) return setShapeDrag(null);
    finishBox({ ...shapeDrag, at: p, square: e.shiftKey });
  };
  // a tool chosen: the plan takes the focus, so the keys draw at once (the mode's switch would eat Space)
  useEffect(() => {
    if (drawTool) svg.current?.focus({ preventScroll: true });
  }, [drawTool]);
  // keyboard, while drawing: the arrows move the cursor by a grid step (×10 with Shift, which also keeps a box square),
  // Space puts a corner, Enter closes a polygon, Backspace takes its last corner back — while the plan has the focus
  // only (Enter and Space on a link or a summary stay theirs); Escape, wherever the focus is outside a field, drops the
  // shape (and, with none, leaves the mode). Nothing while the page asks a drawn shape's name (its form has the keys).
  useEffect(() => {
    if (!drawing || pending) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.defaultPrevented || el?.getAttribute("role") === "slider") return;
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable || el.closest('[role="dialog"]'))) return;
      if (e.key === "Escape") {
        e.preventDefault();
        return corners.length || shapeDrag ? resetDraw() : chooseTool(null);
      }
      if (document.activeElement !== svg.current) return;
      if (e.key === "Backspace" && drawTool === "polygon" && corners.length) {
        e.preventDefault();
        return setCorners(corners.slice(0, -1));
      }
      if (e.key === "Enter" && drawTool === "polygon" && corners.length >= 3) {
        e.preventDefault();
        return closePolygon();
      }
      const d = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] } as Record<string, [number, number]>)[e.key];
      if (!d && e.key !== " ") return;
      e.preventDefault();
      setCursorKeyed(true);
      // the cursor shows first, in the middle of the part of the plan in view (a zoomed plan scrolls)
      if (!cursor) return setCursor(onGrid(onPlan(visibleMiddle())));
      if (d) {
        const step = (gridStep || 0.1) * (e.shiftKey ? 10 : 1);
        const next = onGrid(onPlan({ x: cursor.x + d[0] * step, y: cursor.y + d[1] * step }));
        setCursor(next);
        // Shift keeps the box square (a circle), as with the mouse
        if (shapeDrag) setShapeDrag({ ...shapeDrag, at: next, square: e.shiftKey });
        return;
      }
      if (drawTool === "polygon") return addCorner(cursor);
      if (!shapeDrag) return setShapeDrag({ from: cursor, at: cursor, square: false });
      if (Math.hypot(cursor.x - shapeDrag.from.x, cursor.y - shapeDrag.from.y) > 0) finishBox({ ...shapeDrag, at: cursor });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** The middle of the part of the plan in view (the window and the zoomed plan's frame), in metres. */
  const visibleMiddle = (): P => {
    const r = svg.current!.getBoundingClientRect();
    const frame = scroller.current?.getBoundingClientRect() ?? r;
    const [left, right] = [Math.max(r.left, frame.left, 0), Math.min(r.right, frame.right, window.innerWidth)];
    const [top, bottom] = [Math.max(r.top, frame.top, 0), Math.min(r.bottom, frame.bottom, window.innerHeight)];
    return right > left && bottom > top ? eventToStage({ clientX: (left + right) / 2, clientY: (top + bottom) / 2 }) : { x: (layout.minX + layout.maxX) / 2, y: (layout.minY + layout.maxY) / 2 };
  };

  const aimAt = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!aiming || placing || orienting || drawing || front || !svg.current) return;
    const p = eventToStage(e);
    // the zone on top where it was clicked (the one drawn last); an aiming one gives its aiming point (decision Q3 of
    // T27), not an aiming zone hidden under another; Alt / Option or « Point exact »: the exact point clicked, at the
    // zone's aiming height above its floor
    const zone = zoneAt(zones, p);
    const aimZone = zone?.aim ? zone : undefined;
    // a selected moving head turns to the point alone; without a selection, all of them do
    const only = selected && heads.includes(selected) ? [selected] : undefined;
    const where = aimZone && !e.altKey && !exact ? { zone: aimZone.id } : { point: { x: p.x, y: p.y, z: (zone?.floorHeight ?? 0) + (zone?.aim?.height ?? 1.5) } };
    void cmd<{ results: { fixture: string; error?: string }[] }>("position.aim", { ...where, ...(only ? { fixtures: only } : {}) })
      .then((res) => {
        const errors = res.results.filter((x) => x.error).map((x) => `${x.fixture}${t.colon} ${x.error}`);
        if (errors.length) onError(errors.join(" · "));
      })
      .catch((err: Error) => onError(err.message));
  };

  const viewSwitch = (
    <span className="row view-switch">
      <button className={view === "top" ? "ghost on" : "ghost"} aria-pressed={view === "top"} onClick={() => setView("top")}>
        {t.viewTop}
      </button>
      <button className={front ? "ghost on" : "ghost"} aria-pressed={front} onClick={() => (setView("front"), setAiming(false), chooseTool(null))}>
        {t.viewFront}
      </button>
      <button className={in3d ? "ghost on" : "ghost"} aria-pressed={in3d} title={t.view3dHelp} onClick={() => (setView("3d"), setAiming(false), setPlacing(false), setOrienting(false), chooseTool(null))}>
        {t.view3d}
      </button>
    </span>
  );
  /** The 3D view is drawn by the full plan, or a compact one with its views. */
  const show3d = in3d && (!compact || views);
  return (
    <div className={compact ? "stage-plan compact" : "stage-plan"}>
      {compact && views && (
        <div className="row view-row">
          {controls}
          {viewSwitch}
        </div>
      )}
      {!compact && (
        <div className="row">
        <small className="hint">
          {front ? t.audienceFacing : `${t.audience} ↓`}{layout.unplaced ? ` · ${layout.unplaced} ${t.unplaced}` : ""}
        </small>
        {onMove && !in3d && (
          <label className="row">
            <input type="checkbox" checked={placing} onChange={(e) => (setPlacing(e.target.checked), setAiming(false), setOrienting(false), setMovingZones(false), chooseTool(null), setChosen([]))} /> {t.placeMode}
          </label>
        )}
        {(placing || drawing) && !in3d && (
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
            {placing && (
              <label className="row" title={t.guidesHelp}>
                <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} /> {t.guidesMode}
              </label>
            )}
          </>
        )}
        {onZoneMove && !front && !in3d && (
          <label className="row" title={t.moveZonesHelp}>
            <input type="checkbox" checked={movingZones} onChange={(e) => (setMovingZones(e.target.checked), setMoveError(""), setPlacing(false), setOrienting(false), setAiming(false), chooseTool(null))} /> {t.moveZones}
          </label>
        )}
        {onZoneDraw && !front && !in3d && (
          <label className="row" title={t.zoneDraw.toggleHelp}>
            <input type="checkbox" checked={drawing} onChange={(e) => chooseTool(e.target.checked ? "rect" : null)} /> {t.zoneDraw.toggle}
          </label>
        )}
        {onOrient && !in3d && (
          <label className="row">
            <input type="checkbox" checked={orienting} onChange={(e) => (setOrienting(e.target.checked), setPlacing(false), setAiming(false), chooseTool(null))} /> {t.orientMode}
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
        {heads.length > 0 && !placing && !orienting && !drawing && !front && !in3d && (
          <label className="row">
            <input type="checkbox" checked={aiming} onChange={(e) => setAiming(e.target.checked)} /> {t.aimMode}
          </label>
        )}
        {/* « Point exact » (decision Z3): Alt / Option + click, for a finger or anyone without the key */}
        {aiming && heads.length > 0 && !placing && !orienting && !drawing && !front && !in3d && zones.some((z) => z.aim) && (
          <button type="button" className={exact ? "exact-toggle on" : "exact-toggle"} aria-pressed={exact} title={t.zoneAim.exactHelp} onClick={() => setExact(!exact)}>
            {t.zoneAim.exact}
          </button>
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
      {drawing && drawTool && !compact && (
        <div className="place-panel draw-panel row">
          <span className="row draw-tools" role="group" aria-label={t.zoneDraw.toolsLabel}>
            {DRAW_TOOLS.map((tool) => (
              <button key={tool} className={drawTool === tool ? "on" : ""} aria-pressed={drawTool === tool} onClick={() => chooseTool(tool)}>
                {t.zoneDraw.tools[tool]}
              </button>
            ))}
          </span>
          {/* always there, disabled until they can act: the plan never moves under the finger putting a corner */}
          {drawTool === "polygon" && (
            <>
              <small aria-live="polite">{t.zoneDraw.corners(corners.length)}</small>
              <button className="primary" disabled={corners.length < 3} onClick={closePolygon}>
                {t.zoneDraw.finish}
              </button>
              <button disabled={!corners.length} onClick={() => setCorners(corners.slice(0, -1))}>
                {t.zoneDraw.undo}
              </button>
            </>
          )}
          <button className="ghost" disabled={!corners.length && !shapeDrag} onClick={resetDraw}>
            {t.zoneDraw.cancel}
          </button>
          <small className="place-help" id={drawHelp}>
            {t.zoneDraw.help[drawTool]} <span className="keyboard-help">{t.zoneDraw.keys[drawTool]}</span> {t.zoneDraw.escape}
          </small>
          {/* the keyboard's cursor, said as it moves */}
          <span className="sr-only" aria-live="polite">
            {cursor && cursorKeyed ? t.zoneDraw.cursorAt.replace("{x}", () => metresText(cursor.x, t.decimalMark)).replace("{y}", () => metresText(cursor.y, t.decimalMark)) : ""}
          </span>
          {/* a shape refused (crossed, too small): said here, by the plan, where the eye is */}
          <p className="error draw-error" role="alert" hidden={!drawError}>
            {drawError}
          </p>
        </div>
      )}
      {movingZones && moveError && (
        <p className="error move-error" role="alert">
          {moveError}
        </p>
      )}
      {aiming && !compact && zones.some((z) => z.aim) && (
        <small className="hint aim-zone-hint">
          <span className="pointer-only">{t.zoneAim.aimHint}</span>
          <span className="touch-only">{t.zoneAim.aimHintTouch}</span>
        </small>
      )}
      {show3d && !collapsed && (
        <Suspense fallback={<p className="hint">…</p>}>
          <Stage3D fixtures={fixtures} zones={zones} colors={colors} beams={beams} noWebgl={t.noWebgl} label={t.view3dLabel} height={height} />
        </Suspense>
      )}
      <div className="plan-scroll" ref={scroller} hidden={show3d || collapsed}>
      <svg
        ref={svg}
        viewBox={`${-pad.left} ${-pad.top} ${VW} ${VH}`}
        className={drawing ? (pending ? "drawing pending" : "drawing") : aiming ? "aiming" : placing ? "placing" : orienting ? "orienting" : movingZones && !front ? "moving-zones" : ""}
        style={zoom > 1 ? { width: `${zoom * 100}%`, maxWidth: "none" } : height ? { height, maxHeight: "none" } : undefined}
        onClick={aimAt}
        onDoubleClick={drawing && drawTool === "polygon" && !pending ? closePolygon : undefined}
        onContextMenu={drawing ? (e) => e.preventDefault() : undefined}
        onPointerCancel={() => {
          setShapeDrag(null);
          setHandleDrag(null);
          setZoneDrag(null);
        }}
        onPointerDown={(e) => {
          if (drawing) return drawDown(e);
          // « Placer », pressed on the stage rather than a fixture: a frame to choose those inside
          if (!placing || in3d) return;
          // a finger stays with what it touched (a zone's long press still hears it lift); a mouse is held here
          if (e.pointerType !== "touch") svg.current?.setPointerCapture(e.pointerId);
          const p = eventToStage(e);
          setBand({ from: p, at: p, add: e.ctrlKey || e.metaKey || e.shiftKey });
        }}
        onPointerMove={(e) => {
          if (drawing) return drawMove(e);
          if (handleDrag) {
            const p = eventToStage(e);
            // a few pixels before it moves, as a fixture: a click on a handle changes nothing
            const moved = handleDrag.moved || Math.hypot(p.x - handleDrag.from.x, p.y - handleDrag.from.y) * pxPerMetre > 3;
            return setHandleDrag({ ...handleDrag, at: moved ? onGrid(p) : handleDrag.at, moved });
          }
          if (zoneDrag) return setZoneDrag({ ...zoneDrag, at: eventToStage(e) });
          if (band) return setBand({ ...band, at: eventToStage(e) });
          if (!drag) return turnTo(e);
          const at = eventToStage(e);
          // a few pixels before it moves: a click only chooses
          setDrag({ ...drag, at, moved: drag.moved || Math.hypot(at.x - drag.from.x, at.y - drag.from.y) * pxPerMetre > 3 });
        }}
        onPointerUp={(e) => (drawing ? drawUp(e) : (dropHandle(), dropZone(), dropDrag(), dropBand(), dropTurn()))}
        role="group"
        aria-label={t.stagePreview}
        tabIndex={drawing ? 0 : undefined}
        aria-describedby={drawing ? drawHelp : undefined}
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
          const z = zoneDrag?.id === zone.id ? movedZone(zone, zoneOffset[0]!, zoneOffset[1]!) : handleDrag?.id === zone.id && handleDrag.moved ? reshapedZone(zone, handleDrag.handle, handleDrag.at) : zone;
          // no menu while drawing: a long press must not open one under the finger putting a corner
          const menu = onZoneMenu && !drawing ? zoneMenu(z.id) : undefined;
          const aimColor = z.aim ? (z.aim.color ?? AIM_COLOR) : undefined;
          // a dark colour of its own gets a light halo: it stays visible on the dark plan
          const halo = z.aim?.color !== undefined && textOn(z.aim.color) === "#ffffff";
          const points = z.polygon.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ");
          const nameY = zoneNames.get(z.id);
          const label = `${z.name}${z.protected ? ` (${t.protectedZone})` : ""}${z.noAim ? ` (${t.noAimZone})` : ""}`;
          const xs = z.polygon.map((p) => p[0]);
          return (
          <g
            key={z.id}
            className={zoneDrag?.id === z.id ? "zone dragged" : "zone"}
            data-zone={z.id}
            {...menu}
            // reachable by the keyboard (decision U3): Shift+F10, the menu key, Enter or Space open its menu, as a fixture's
            {...(menu && !front
              ? {
                  tabIndex: 0,
                  role: "button",
                  "aria-label": t.zoneAim.zoneOnPlan.replace("{name}", () => z.name),
                  onKeyDown: (e: ReactKeyboardEvent<SVGGElement>) => {
                    if (e.target !== e.currentTarget || !((e.shiftKey && e.key === "F10") || e.key === "ContextMenu" || e.key === "Enter" || e.key === " ")) return;
                    e.preventDefault();
                    onZoneMenu?.(zone, besideZone(zone.polygon));
                  },
                }
              : {})}
            onPointerDown={(e) => {
              if (drawing) return; // the plan draws: the corner goes where the zone is
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
            <title>{label}</title>
            {halo && <polygon className="zone-halo" points={points} fill="none" />}
            <polygon
              points={points}
              fill={ZONE_FILL[z.type] ?? "#262a33"}
              stroke={z.protected || z.noAim ? "#e5484d" : aimColor ? undefined : "#3b4150"}
              style={aimColor && !z.protected && !z.noAim ? { stroke: aimColor } : undefined}
              strokeWidth={aimColor && !z.protected && !z.noAim ? 2 : 1}
              strokeDasharray={z.protected || z.noAim ? "6 4" : undefined}
            />
            {z.noAim && <polygon className="no-aim" points={points} fill="url(#no-aim)" />}
            {nameY !== undefined && (
              <text x={sx((Math.min(...xs) + Math.max(...xs)) / 2)} y={nameY} textAnchor="middle" className="zone-name" style={{ fontSize: `${zoneNameSize}px` }}>
                {label}
              </text>
            )}
            {aimColor && !front && (() => {
              // its aiming point: a small reticle in its colour (T27)
              const at = aimSpot(z);
              const r = 6 * unit;
              return (
                <g className={halo ? "zone-aim halo" : "zone-aim"} data-aim={z.id} role="img" aria-label={t.zoneAim.onPlan.replace("{name}", () => z.name)} transform={`translate(${sx(at.x)} ${sy(at.y)})`} style={{ stroke: aimColor }}>
                  <circle r={r} />
                  <line x1={-r * 1.8} x2={-r * 0.4} y1={0} y2={0} />
                  <line x1={r * 0.4} x2={r * 1.8} y1={0} y2={0} />
                  <line y1={-r * 1.8} y2={-r * 0.4} x1={0} x2={0} />
                  <line y1={r * 0.4} y2={r * 1.8} x1={0} x2={0} />
                </g>
              );
            })()}
          </g>
          );
        })}
        {movingZones && onZoneMove && !front && !in3d &&
          shown.zones.map((zone) => {
            // « Déplacer les zones » (lot Z4): a dot on each corner (not an ellipse's: its menu edits it) and its aiming
            // point, dragged by the mouse or a finger, or moved by the arrows once focused
            const z = handleDrag?.id === zone.id && handleDrag.moved ? reshapedZone(zone, handleDrag.handle, handleDrag.at) : zone;
            const handles: { handle: ZoneHandle; at: P; label: string }[] = [
              ...(z.outline?.kind === "ellipse" ? [] : z.polygon.map(([x, y], i) => ({ handle: i, at: { x, y }, label: t.zoneAim.vertexHandle.replace("{n}", String(i + 1)).replace("{name}", () => z.name) }))),
              ...(z.aim ? [{ handle: "aim" as const, at: aimSpot(z), label: t.zoneAim.aimHandle.replace("{name}", () => z.name) }] : []),
            ];
            return (
              <g key={`handles-${z.id}`} className="zone-handles" data-handles={z.id}>
                {handles.map(({ handle, at, label }) => (
                  <circle
                    key={String(handle)}
                    className={handle === "aim" ? "zone-handle aim" : "zone-handle"}
                    data-handle={handle}
                    cx={sx(at.x)}
                    cy={sy(at.y)}
                    r={handleRadius * unit}
                    tabIndex={0}
                    role="button"
                    aria-label={label}
                    onPointerDown={(e) => {
                      if (e.pointerType === "mouse" && e.button !== 0) return;
                      e.stopPropagation();
                      svg.current?.setPointerCapture(e.pointerId);
                      setHandleDrag({ id: zone.id, handle, at, from: eventToStage(e), moved: false });
                    }}
                    onKeyDown={(e) => {
                      const d = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] } as Record<string, [number, number]>)[e.key];
                      if (!d) return;
                      e.preventDefault();
                      const step = (gridStep || 0.01) * (e.shiftKey ? 10 : 1);
                      // from the last position sent while the plan still draws the one before it: two quick presses
                      // (or a held key) each take their step instead of both starting from the same drawn position
                      const key = `${zone.id}:${handle}`;
                      const last = keyedHandle.current;
                      const from = last && last.key === key && last.drawn.x === at.x && last.drawn.y === at.y ? last.sent : at;
                      const next = { x: from.x + d[0] * step, y: from.y + d[1] * step };
                      keyedHandle.current = { key, drawn: at, sent: next };
                      commitHandle(zone, handle, next);
                    }}
                  />
                ))}
              </g>
            );
          })}
        {(placing || drawing) && gridStep > 0 && (() => {
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
          if (f.absent) return null;
          const p = placeOf(f.id);
          const lit = (colors[f.id] ?? []).filter((c) => c !== "#000000");
          if (!lit.length) return null;
          const lightCone = cone(f, lit[Math.floor(lit.length / 2)]!);
          if (lightCone) return lightCone;
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
          // the selection holds in every mode; the « Placer » choice is drawn the same way
          const isSelected = selected === f.id || (placing && chosen.includes(f.id));
          const body = angle ? `rotate(${-angle} ${sx(p.x)} ${sy(p.y)})` : undefined;
          // the beam, projected on the view; what is left points at or away from the viewer
          const d = beam(o);
          const [px, py, toward] = front ? [d.x, -d.z, -d.y] : [d.x, -d.y, d.z];
          const reach = Math.max(w, h) / 2 + 16;
          // an absent fixture casts no light, but the one being oriented keeps its arrow
          const showBeam = (!f.absent && beamsShown && Boolean(f.orientation)) || isSelected;
          // its name where it was laid out, following it while dragged; on hover only when there was no room
          const nameAt = names.get(f.id);
          const nameY = nameAt === undefined ? undefined : nameAt + sy(p.y) - sy(layout.pos.get(f.id)!.y);
          // its menu: right-click, a long press or Shift+F10 once focused, all three outside the place and orient modes (a drag must not open it)
          const menu = onFixtureMenu && !drawing ? fixtureMenu(f.id) : undefined;
          return (
            <g
              key={f.id}
              className={[isSelected ? "fixture selected" : "fixture", f.absent ? "absent" : ""].filter(Boolean).join(" ")}
              data-fixture={f.id}
              role={menu ? "button" : "img"}
              aria-label={f.name}
              {...(menu
                ? {
                    ...menu,
                    tabIndex: 0,
                    // a button that selects it: pressed while it is the selected one
                    "aria-pressed": isSelected,
                    // no menu while a mode is on (as the long press and Shift+F10): a right-click there does nothing, the browser's menu stays shut too
                    onContextMenu: (e: ReactMouseEvent) => (orienting || placing ? e.preventDefault() : menu.onContextMenu(e)),
                    onKeyDown: (e: ReactKeyboardEvent<SVGGElement>) => {
                      // Enter and Space do what a click does: select it (one more chosen, or one less, while placing)
                      if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        if (placing) setChosen(chosen.includes(f.id) ? chosen.filter((id) => id !== f.id) : [...chosen, f.id]);
                        else select(f.id);
                        return;
                      }
                      if (!((e.shiftKey && e.key === "F10") || e.key === "ContextMenu")) return;
                      e.preventDefault();
                      if (orienting || placing) return; // no menu while a mode is on, as the right-click
                      const r = e.currentTarget.getBoundingClientRect();
                      onFixtureMenu?.(f, { x: r.right, y: r.bottom });
                    },
                  }
                : {})}
              onPointerDown={(e) => {
                if (drawing) return; // the plan draws: a corner may go on a fixture
                if (!orienting && !placing) menu?.onPointerDown(e);
                if (orienting) {
                  e.stopPropagation();
                  select(f.id);
                  if (!front) {
                    svg.current?.setPointerCapture(e.pointerId);
                    setTurning(f.orientation?.yaw ?? 0);
                  }
                  return;
                }
                if (placing) {
                  // Ctrl/⌘ or Shift: one more chosen, or one less
                  if (e.ctrlKey || e.metaKey || e.shiftKey) {
                    e.stopPropagation();
                    return setChosen(chosen.includes(f.id) ? chosen.filter((id) => id !== f.id) : [...chosen, f.id]);
                  }
                  e.stopPropagation();
                  const ids = chosen.includes(f.id) ? chosen : [f.id];
                  setChosen(ids);
                  svg.current?.setPointerCapture(e.pointerId);
                  const at = eventToStage(e);
                  setDrag({ held: f.id, ids, from: at, at, moved: false });
                  return;
                }
                // no mode on: a click holds the fixture for its panel (an aiming click selects instead of aiming)
                e.stopPropagation();
                select(f.id);
              }}
            >
              <title>{f.name}</title>
              <g transform={body}>
                {cols.map((c, i) => (
                  <rect key={i} x={x0 + i * cw} y={y0} width={i < cols.length - 1 ? cw + 0.6 : cw} height={h} fill={c} />
                ))}
                <rect className="bar-outline" x={x0} y={y0} width={w} height={h} fill="none" pointerEvents="none" stroke="#4a5060" strokeWidth={0.5} />
                {isSelected && <rect className="selection" x={x0 - 4} y={y0 - 4} width={w + 8} height={h + 8} fill="none" />}
                {f.id in strobe && !f.absent && cols.some((c) => c !== "#000000") && <rect className="strobe-outline" x={x0 - 3} y={y0 - 3} width={w + 6} height={h + 6} fill="none" />}
              </g>
              {showBeam && (
                <g className="beam">
                  <title>{f.facing ? `${t.facingLabel}${t.colon} ${t.facings[f.facing]}` : `${t.heading} ${Math.round(o?.yaw ?? 0)}° · ${t.pitchLabel} ${Math.round(o?.pitch ?? 0)}°`}</title>
                  {Math.hypot(px, py) >= 0.35 && <line x1={sx(p.x)} y1={sy(p.y)} x2={sx(p.x) + px * reach} y2={sy(p.y) + py * reach} markerEnd="url(#beam-head)" />}
                  {Math.abs(toward) > 0.7 && (
                    <g transform={`translate(${sx(p.x) + halfWidth + 10} ${sy(p.y) - halfHeight - 2})`} /* by the body's corner as drawn, a standing bar's too */>
                      <circle r={6} fill="#12141a" />
                      {toward > 0 ? <circle r={1.8} className="dot" /> : <path d="M -3.5 -3.5 L 3.5 3.5 M -3.5 3.5 L 3.5 -3.5" />}
                    </g>
                  )}
                </g>
              )}
              {f.id in strobe && !f.absent && cols.some((c) => c !== "#000000") && (
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
        {!in3d &&
          drawnTargets.map((tg) => {
            const [x, y] = [sx(tg.at.x), sy(tg.at.y)];
            const labelY = names.get(`target:${tg.id}`);
            const r = targetRing;
            return (
              <g key={`target-${tg.id}`} data-target={tg.id} role="img" aria-label={t.targets.onPlan.replace("{name}", () => tg.name).replace("{z}", () => metresText(tg.point.z, t.decimalMark))} style={tg.color ? ({ "--target-color": tg.color } as React.CSSProperties) : undefined}>
                <g className={tg.engaged ? "plan-target" : "plan-target idle"} transform={`translate(${x} ${y})`}>
                  <circle r={r} />
                  <line x1={-r * 1.6} x2={-r * 0.45} y1={0} y2={0} />
                  <line x1={r * 0.45} x2={r * 1.6} y1={0} y2={0} />
                  <line y1={-r * 1.6} y2={-r * 0.45} x1={0} x2={0} />
                  <line y1={r * 0.45} y2={r * 1.6} x1={0} x2={0} />
                  <circle r={2} className="plan-target-dot" />
                </g>
                {labelY !== undefined && (
                  <text className="plan-target-label" x={x} y={labelY} textAnchor="middle" style={{ fontSize: `${nameSize}px` }}>
                    {tg.label}
                  </text>
                )}
              </g>
            );
          })}
        {pending && !front && (() => {
          // the shape drawn, waiting for its name: still on the plan, dashed, its centre marked
          const c = cachedZoneCentre(pending.polygon);
          const r = 6 * unit;
          return (
            <g className="draw-preview pending" aria-hidden pointerEvents="none">
              <polygon className="draw-shape" points={pending.polygon.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ")} />
              <g className="draw-centre" transform={`translate(${sx(c.x)} ${sy(c.y)})`}>
                <circle r={r} />
                <line x1={-r * 1.8} x2={r * 1.8} y1={0} y2={0} />
                <line y1={-r * 1.8} y2={r * 1.8} x1={0} x2={0} />
              </g>
            </g>
          );
        })()}
        {drawing && !pending && (
          <g className="draw-preview" aria-hidden pointerEvents="none">
            {shapeDrag && <polygon className="draw-shape" points={boxShape(shapeDrag).map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ")} />}
            {corners.length > 0 && <polyline className="draw-shape" points={[...corners, ...(cursor ? [cursor] : [])].map((c) => `${sx(c.x)},${sy(c.y)}`).join(" ")} />}
            {corners.map((c, i) => (
              <circle key={i} className={i === 0 && corners.length >= 3 ? "draw-corner first" : "draw-corner"} cx={sx(c.x)} cy={sy(c.y)} r={i === 0 && corners.length >= 3 ? 12 * unit : 4 * unit} />
            ))}
            {cursor && (
              <g className="draw-cursor" transform={`translate(${sx(cursor.x)} ${sy(cursor.y)})`}>
                <line x1={-10 * unit} x2={10 * unit} y1={0} y2={0} />
                <line y1={-10 * unit} y2={10 * unit} x1={0} x2={0} />
              </g>
            )}
          </g>
        )}
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
              {selectedFixture.movable && (
                <>
                  <button className={(selectedFixture.orientation?.invertPan ?? false) ? "on" : ""} aria-pressed={Boolean(selectedFixture.orientation?.invertPan)} title={t.invertAxisHelp} onClick={() => onOrient(selectedFixture, { invertPan: !(selectedFixture.orientation?.invertPan ?? false) })}>
                    {t.invertPanLabel}
                  </button>
                  <button className={(selectedFixture.orientation?.invertTilt ?? false) ? "on" : ""} aria-pressed={Boolean(selectedFixture.orientation?.invertTilt)} title={t.invertAxisHelp} onClick={() => onOrient(selectedFixture, { invertTilt: !(selectedFixture.orientation?.invertTilt ?? false) })}>
                    {t.invertTiltLabel}
                  </button>
                </>
              )}
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
      {/* A fixture held on the plan (any mode or none) is controlled in full below: it moves, and the channels of its light are faders. */}
      {selectedFixture && onOrient && !compact && <FixturePanel key={selectedFixture.id} fixture={selectedFixture} onError={onError} onClose={() => select(null)} />}
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

/** Self-loading live preview, for a dashboard widget. */
export function LiveStage({
  onError,
  shownColors,
  views = false,
  initialView,
  beamsShown,
  controls,
  collapsed,
  height,
}: {
  onError: (msg: string) => void;
  shownColors?: Record<string, string[]>;
  views?: boolean;
  initialView?: "top" | "front" | "3d";
  beamsShown?: boolean;
  controls?: ReactNode;
  collapsed?: boolean;
  height?: number;
}): ReactElement {
  const [fixtures, setFixtures] = useState<PlanFixture[]>([]);
  const [zones, setZones] = useState<PlanZone[]>([]);
  useEffect(() => {
    void cmd<PlanFixture[]>("venue.fixture.list").then(setFixtures).catch(() => undefined);
    void cmd<PlanZone[]>("stage.zone.list").then(setZones).catch(() => undefined);
  }, []);
  return <StagePlan fixtures={fixtures} zones={zones} onError={onError} compact views={views} shownColors={shownColors} initialView={initialView} beamsShown={beamsShown} controls={controls} collapsed={collapsed} height={height} />;
}
