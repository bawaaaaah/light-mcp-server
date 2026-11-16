/**
 * A stage zone's shape on the plan (docs/specs/venue-fixtures-stage.md, « Zones »): the Lieu page
 * draws zones as rectangles from a width, a depth, a centre X and a front Y, or on the plan as a
 * rectangle, an ellipse or a polygon (T27); these read them back, check them as the server does,
 * find their centre and move a zone of any shape. Pure; the geometry is src/plugins/light/venue/zone-geometry.ts.
 */

import { cm, isSimplePolygon, MIN_ZONE_AREA, pointInPolygon, polygonArea, zoneCentre, type Pt } from "../../src/plugins/light/venue/zone-geometry.js";

// the geometry itself (surface, centre, simple outline, ellipse) is the server's, shared: the plan draws, checks and
// centres a zone exactly as stage.zone.put and position.aim will
export { ellipsePolygon, pointInPolygon, zoneCentre, type Pt } from "../../src/plugins/light/venue/zone-geometry.js";

/** A rectangle as the Lieu page makes it: its front edge at y, centred on x. */
export function rectPolygon(width: number, depth: number, x: number, y: number): Pt[] {
  return [
    [cm(x - width / 2), cm(y)],
    [cm(x + width / 2), cm(y)],
    [cm(x + width / 2), cm(y + depth)],
    [cm(x - width / 2), cm(y + depth)],
  ];
}

/** The width, depth, centre X and front Y of a zone drawn as a rectangle; undefined for another shape. */
export function zoneRect(polygon: readonly Pt[]): { width: number; depth: number; x: number; y: number } | undefined {
  if (polygon.length !== 4) return undefined;
  const xs = [...new Set(polygon.map((p) => p[0]))];
  const ys = [...new Set(polygon.map((p) => p[1]))];
  if (xs.length !== 2 || ys.length !== 2) return undefined;
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  return { width: cm(x1 - x0), depth: cm(y1 - y0), x: cm((x0 + x1) / 2), y: cm(y0) };
}

/** A zone moved by dx, dy (metres), its corners kept to the centimetre. */
export function moveZone(polygon: readonly Pt[], dx: number, dy: number): Pt[] {
  return polygon.map(([x, y]) => [cm(x + dx), cm(y + dy)]);
}

/** Whether a polygon can be a zone: simple, and of MIN_ZONE_AREA at least (what stage.zone.put accepts). */
export function validZone(poly: readonly Pt[]): boolean {
  return isSimplePolygon(poly) && polygonArea(poly) >= MIN_ZONE_AREA;
}

/** The upright box between two corners dragged on the plan, to the centimetre: Shift (`square`) keeps it square, from the first corner. */
export function boxFromDrag(from: { x: number; y: number }, to: { x: number; y: number }, square = false): { x0: number; y0: number; x1: number; y1: number } {
  let [dx, dy] = [to.x - from.x, to.y - from.y];
  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    [dx, dy] = [Math.sign(dx || 1) * side, Math.sign(dy || 1) * side];
  }
  const [xa, xb, ya, yb] = [cm(from.x), cm(from.x + dx), cm(from.y), cm(from.y + dy)];
  return { x0: Math.min(xa, xb), y0: Math.min(ya, yb), x1: Math.max(xa, xb), y1: Math.max(ya, yb) };
}

/** A rectangle dragged from one corner to the other, in the order rectPolygon gives (front left first). */
export function rectFromDrag(from: { x: number; y: number }, to: { x: number; y: number }, square = false): Pt[] {
  const { x0, y0, x1, y1 } = boxFromDrag(from, to, square);
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** An ellipse dragged by its bounding box (Shift: a circle): its centre and half-axes, to the centimetre. */
export function ellipseFromDrag(from: { x: number; y: number }, to: { x: number; y: number }, circle = false): { cx: number; cy: number; rx: number; ry: number } {
  const { x0, y0, x1, y1 } = boxFromDrag(from, to, circle);
  return { cx: cm((x0 + x1) / 2), cy: cm((y0 + y1) / 2), rx: cm((x1 - x0) / 2), ry: cm((y1 - y0) / 2) };
}

/** How a zone was drawn (T27; ZoneOutlineSchema of the server): to edit it again in its own terms. */
export type ZoneOutline = { kind: "rect" } | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; rotation?: number } | { kind: "polygon" };

/** A zone moved by dx, dy (metres): its corners, its placed aiming point and a drawn ellipse's centre go with it. */
export function movedZone<Z extends { polygon: Pt[]; aim?: { height: number; point?: Pt } | undefined; outline?: ZoneOutline | undefined }>(zone: Z, dx: number, dy: number): Z {
  const { aim, outline } = zone;
  return {
    ...zone,
    polygon: moveZone(zone.polygon, dx, dy),
    ...(aim?.point ? { aim: { ...aim, point: [cm(aim.point[0] + dx), cm(aim.point[1] + dy)] as Pt } } : {}),
    ...(outline?.kind === "ellipse" ? { outline: { ...outline, cx: cm(outline.cx + dx), cy: cm(outline.cy + dy) } } : {}),
  };
}

/** Each polygon's centre, once found: the plan draws its zones at every render, and a concave zone's centre is a search. */
const centres = new WeakMap<readonly Pt[], { x: number; y: number }>();

/** zoneCentre, kept per polygon (a polygon is never changed in place: a zone moved or reshaped gets a new one). */
export function cachedZoneCentre(poly: readonly Pt[]): { x: number; y: number } {
  let c = centres.get(poly);
  if (!c) centres.set(poly, (c = zoneCentre(poly)));
  return c;
}

/** The aiming point of a zone, X/Y (zoneAimPoint of the server): its placed point, else its centre (`zoneCentre`). */
export function aimSpot(zone: { polygon: readonly Pt[]; aim?: { point?: Pt } | undefined }): { x: number; y: number } {
  return zone.aim?.point ? { x: zone.aim.point[0], y: zone.aim.point[1] } : cachedZoneCentre(zone.polygon);
}

/**
 * The zone drawn on top at a stage point (the last of the list: the plan and the target pad draw them in that order):
 * only it decides what a click does, an aiming zone hidden under another is not aimed at (T27).
 */
export function zoneAt<Z extends { polygon: readonly Pt[] }>(zones: readonly Z[], p: { x: number; y: number }): Z | undefined {
  for (let i = zones.length - 1; i >= 0; i--) if (pointInPolygon(p.x, p.y, zones[i]!.polygon)) return zones[i];
  return undefined;
}

/** What can be dragged on a zone besides the zone (lot Z4): one of its corners, or its aiming point. */
export type ZoneHandle = number | "aim";

/**
 * A zone with a handle moved to `p` (lot Z4), to the centimetre: its aiming point placed there; a rectangle's corner moves
 * with the opposite corner held (it stays an upright rectangle); any other polygon's corner moves alone. An ellipse has
 * no corners to drag (its menu edits its axes).
 */
export function reshapedZone<Z extends { polygon: Pt[]; aim?: { height: number; point?: Pt } | undefined; outline?: ZoneOutline | undefined }>(zone: Z, handle: ZoneHandle, p: { x: number; y: number }): Z {
  const at: Pt = [cm(p.x), cm(p.y)];
  if (handle === "aim") return zone.aim ? { ...zone, aim: { ...zone.aim, point: at } } : zone;
  // a rectangle drawn as one, or made on the Lieu page (no outline, upright)
  if (zone.outline?.kind === "rect" || (zone.outline === undefined && zoneRect(zone.polygon))) {
    // the corners keep their order, whichever it is, so the handle held stays the corner moved: the opposite one is
    // held, and each neighbour keeps the side it shares with the moved corner (its X or its Y)
    const [ox, oy] = zone.polygon[(handle + 2) % 4]!;
    const [hx] = zone.polygon[handle]!;
    const sideOf = (i: number): Pt => (zone.polygon[i]![0] === hx ? [at[0], oy] : [ox, at[1]]);
    const polygon = [0, 1, 2, 3].map((i): Pt => (i === handle ? at : i === (handle + 2) % 4 ? [ox, oy] : sideOf(i)));
    return { ...zone, polygon };
  }
  return { ...zone, polygon: zone.polygon.map((c, i) => (i === handle ? at : c)) };
}
