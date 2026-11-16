/**
 * A stage zone's shape on the plan (docs/specs/venue-fixtures-stage.md, « Zones »): the Lieu page
 * draws zones as rectangles from a width, a depth, a centre X and a front Y, or on the plan as a
 * rectangle, an ellipse or a polygon (T27); these read them back, check them as the server does,
 * find their centre and move a zone of any shape. Pure.
 */

export type Pt = [number, number];

const cm = (v: number) => Math.round(v * 100) / 100;

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

// ---- drawing a zone (T27): mirrors src/plugins/light/venue/stage.ts (the web app shares no code with the server;
// test/plugins/light/zone-shape-parity.test.ts keeps the two equal)

/** Corners of an ellipse stored as a polygon: fine enough at the scale of a stage. */
export const ELLIPSE_POINTS = 32;
/** The smallest surface a zone may have (m²), as the server refuses below it. */
export const MIN_ZONE_AREA = 0.01;

/** Twice the signed area (shoelace): positive counter-clockwise. */
function doubleArea(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j]![0] * poly[i]![1] - poly[i]![0] * poly[j]![1];
  return a;
}

/** Whether (x, y) lies inside a polygon (even-odd rule): pointInPolygon of the server. */
export function pointInPolygon(x: number, y: number, poly: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The mean of a polygon's corners. */
function meanOf(poly: readonly Pt[]): { x: number; y: number } {
  return { x: poly.reduce((s, p) => s + p[0], 0) / poly.length, y: poly.reduce((s, p) => s + p[1], 0) / poly.length };
}

/** How far (x, y) lies from a polygon's outline: positive inside, negative outside. */
function signedDistance(x: number, y: number, poly: readonly Pt[]): number {
  let min = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) min = Math.min(min, edgeDistance2(x, y, poly[j]!, poly[i]!));
  return pointInPolygon(x, y, poly) ? Math.sqrt(min) : -Math.sqrt(min);
}

/** The square of the distance from (x, y) to the segment a-b. */
function edgeDistance2(x: number, y: number, a: Pt, b: Pt): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len)) : 0;
  const [ex, ey] = [x - a[0] - t * dx, y - a[1] - t * dy];
  return ex * ex + ey * ey;
}

/** Whether (x, y) lies inside a polygon at least `depth` (> 0) from its outline: signedDistance ≥ depth, stopping at the first edge too near. */
function deepInside(x: number, y: number, poly: readonly Pt[], depth: number): boolean {
  const limit = depth * depth;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (edgeDistance2(x, y, poly[j]!, poly[i]!) < limit) return false;
  return pointInPolygon(x, y, poly);
}

/** A cell of the search for the pole of inaccessibility: its centre, half its side, its depth and the most it may hold. */
type PoleCell = { x: number; y: number; half: number; d: number; max: number };

/** Puts a cell on a max-heap of cells by `max`. */
function pushCell(heap: PoleCell[], c: PoleCell): void {
  heap.push(c);
  for (let i = heap.length - 1; i > 0; ) {
    const p = (i - 1) >> 1;
    if (heap[p]!.max >= heap[i]!.max) break;
    [heap[p], heap[i]] = [heap[i]!, heap[p]!];
    i = p;
  }
}

/** Takes the cell of largest `max` off a max-heap of cells. */
function popCell(heap: PoleCell[]): PoleCell {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length) {
    heap[0] = last;
    for (let i = 0; ; ) {
      const [l, r] = [2 * i + 1, 2 * i + 2];
      let m = i;
      if (l < heap.length && heap[l]!.max > heap[m]!.max) m = l;
      if (r < heap.length && heap[r]!.max > heap[m]!.max) m = r;
      if (m === i) break;
      [heap[m], heap[i]] = [heap[i]!, heap[m]!];
      i = m;
    }
  }
  return top;
}

/** How many lines across the polygon, each way, seed the search for the pole. */
const POLE_SEED_LINES = 32;

/**
 * The middles of the stretches of horizontal and vertical lines across a polygon that lie inside it (even-odd rule,
 * as pointInPolygon): points surely inside, however thin the polygon, to start the search for the pole from.
 */
function insideMiddles(poly: readonly Pt[], minX: number, minY: number, w: number, h: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const axis of [0, 1] as const) {
    const [from, span] = axis === 0 ? [minY, h] : [minX, w];
    for (let k = 0; k < POLE_SEED_LINES; k++) {
      const at = from + ((k + 0.5) * span) / POLE_SEED_LINES;
      const cuts: number[] = [];
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [a, b] = [poly[i]!, poly[j]!];
        // along a horizontal line (axis 0) the edge is cut at an X; along a vertical one, at a Y
        const [ua, va, ub, vb] = axis === 0 ? [a[1], a[0], b[1], b[0]] : [a[0], a[1], b[0], b[1]];
        if (ua > at !== ub > at) cuts.push(va + ((at - ua) * (vb - va)) / (ub - ua));
      }
      cuts.sort((p, q) => p - q);
      for (let m = 0; m + 1 < cuts.length; m += 2) {
        const mid = (cuts[m]! + cuts[m + 1]!) / 2;
        out.push(axis === 0 ? { x: mid, y: at } : { x: at, y: mid });
      }
    }
  }
  return out;
}

/** The most cells the search for the pole splits: a bound on its time for an outline of many thin teeth. */
const POLE_MAX_SPLITS = 500;

/**
 * The point inside a polygon farthest from its outline (its « pole of inaccessibility », as polylabel finds it: cells
 * of the bounding box split, the most promising first, while one may still hold a farther point), to `precision` metres
 * or after POLE_MAX_SPLITS splits; rounded to the centimetre, unless rounding would put it outside (a zone thinner
 * than a few centimetres).
 */
export function poleOfInaccessibility(poly: readonly Pt[], precision = 0.01): { x: number; y: number } {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const [w, h] = [maxX - minX, maxY - minY];
  // the first cells: as wide as the polygon is thin, never more than 64 along its length
  const size = Math.max(Math.min(w, h), Math.max(w, h) / 64);
  if (!(size > 0)) return meanOf(poly);
  const cell = (x: number, y: number, half: number): PoleCell => {
    const d = signedDistance(x, y, poly);
    return { x, y, half, d, max: d + half * Math.SQRT2 };
  };
  const heap: PoleCell[] = [];
  for (let x = minX; x < maxX; x += size) for (let y = minY; y < maxY; y += size) pushCell(heap, cell(x + size / 2, y + size / 2, size / 2));
  let best = cell(minX + w / 2, minY + h / 2, 0);
  for (const p of insideMiddles(poly, minX, minY, w, h)) {
    const c = cell(p.x, p.y, 0);
    if (c.d > best.d) best = c;
  }
  for (let splits = 0; heap.length && splits < POLE_MAX_SPLITS; splits++) {
    // the cell that may hold the farthest point: once even it cannot beat the best by `precision`, none can
    const c = popCell(heap);
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) break;
    const half = c.half / 2;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) pushCell(heap, cell(c.x + sx * half, c.y + sy * half, half));
  }
  const rounded = { x: cm(best.x), y: cm(best.y) };
  return best.d > 0 && !pointInPolygon(rounded.x, rounded.y, poly) ? { x: best.x, y: best.y } : rounded;
}

/**
 * A zone's centre, the point it is aimed at by default (T27, decisions Z1 and Z2): the centre of its surface (centroid)
 * when it lies inside; for a concave zone whose centroid falls outside (a U, a thin L), the point inside nearest it,
 * well away from the edges (`centreInside`); for an outline that crosses itself (an old zone, stored before the check)
 * or a centroid outside its box, the mean of its corners.
 */
export function zoneCentre(poly: readonly Pt[]): { x: number; y: number } {
  const c = centroid(poly);
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  if (!isSimplePolygon(poly) || c.x < Math.min(...xs) || c.x > Math.max(...xs) || c.y < Math.min(...ys) || c.y > Math.max(...ys)) return meanOf(poly);
  return pointInPolygon(c.x, c.y, poly) ? c : centreInside(poly, c);
}

/**
 * The point inside a polygon nearest its centroid `c` while at least half as deep as its deepest point (the pole of
 * inaccessibility): the middle of a U's bar, not one of its corners. On a grid of 200 steps along its length.
 */
function centreInside(poly: readonly Pt[], c: { x: number; y: number }): { x: number; y: number } {
  const pole = poleOfInaccessibility(poly);
  const deep = signedDistance(pole.x, pole.y, poly) / 2;
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
  const step = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) / 200;
  const poleGap = Math.hypot(pole.x - c.x, pole.y - c.y);
  if (!(step > 0 && deep > 0)) return pole;
  const [maxX, maxY] = [Math.max(...xs), Math.max(...ys)];
  // the grid points nearer `c` than the pole, nearest first (ties in grid order): the first deep enough is the answer,
  // so the distance to the outline, the costly part, is measured on a few points only
  const near: { x: number; y: number; gap: number; k: number }[] = [];
  for (let i = 0; minX + i * step <= maxX; i++) {
    for (let j = 0; minY + j * step <= maxY; j++) {
      const [x, y] = [cm(minX + i * step), cm(minY + j * step)];
      const gap = Math.hypot(x - c.x, y - c.y);
      if (gap < poleGap) near.push({ x, y, gap, k: near.length });
    }
  }
  near.sort((a, b) => a.gap - b.gap || a.k - b.k);
  const found = near.find((p) => deepInside(p.x, p.y, poly, deep));
  return found ? { x: found.x, y: found.y } : pole;
}

/** The surface of a polygon, m² (its corners in either order). */
export function polygonArea(poly: readonly Pt[]): number {
  return Math.abs(doubleArea(poly)) / 2;
}

/** The centre of a polygon's surface (shoelace centroid); the mean of its corners when it has no surface. */
export function centroid(poly: readonly Pt[]): { x: number; y: number } {
  const a = doubleArea(poly);
  if (Math.abs(a) < 1e-9) return meanOf(poly);
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xj, yj] = poly[j]!;
    const [xi, yi] = poly[i]!;
    const k = xj * yi - xi * yj;
    cx += (xj + xi) * k;
    cy += (yj + yi) * k;
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** An ellipse as a polygon of `n` corners to the centimetre, from its centre, half-axes and turn (degrees, counter-clockwise). */
export function ellipsePolygon(cx: number, cy: number, rx: number, ry: number, rotation = 0, n = ELLIPSE_POINTS): Pt[] {
  const turn = (rotation * Math.PI) / 180;
  const [c, s] = [Math.cos(turn), Math.sin(turn)];
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    const [x, y] = [rx * Math.cos(a), ry * Math.sin(a)];
    return [cm(cx + x * c - y * s), cm(cy + x * s + y * c)] as Pt;
  });
}

/** Orientation of the turn a → b → c: 1 counter-clockwise, −1 clockwise, 0 aligned. */
function turnOf(a: Pt, b: Pt, c: Pt): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.abs(v) < 1e-12 ? 0 : Math.sign(v);
}
/** Whether p, aligned with a and b, lies on the segment between them. */
const onSegment = (a: Pt, b: Pt, p: Pt) =>
  Math.min(a[0], b[0]) - 1e-9 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-9;
/** Whether two segments cross or touch. */
function segmentsMeet(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const [o1, o2, o3, o4] = [turnOf(a, b, c), turnOf(a, b, d), turnOf(c, d, a), turnOf(c, d, b)];
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  return (o1 === 0 && onSegment(a, b, c)) || (o2 === 0 && onSegment(a, b, d)) || (o3 === 0 && onSegment(c, d, a)) || (o4 === 0 && onSegment(c, d, b));
}

/**
 * Whether a polygon is simple: at least three corners, no corner twice in a row, no two edges crossing or touching
 * except two neighbours at their shared corner, and no edge folded back over the next one.
 */
export function isSimplePolygon(poly: readonly Pt[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const [a, b] = [poly[i]!, poly[(i + 1) % n]!];
    if (a[0] === b[0] && a[1] === b[1]) return false;
    // folded back: the next edge goes back along this one
    const c = poly[(i + 2) % n]!;
    if (turnOf(a, b, c) === 0 && (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > 0) return false;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // the last edge and the first share the first corner
      if (segmentsMeet(a, b, poly[j]!, poly[(j + 1) % n]!)) return false;
    }
  }
  return true;
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
