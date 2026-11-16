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

/** The surface of a polygon, m² (its corners in either order). */
export function polygonArea(poly: readonly Pt[]): number {
  return Math.abs(doubleArea(poly)) / 2;
}

/** The centre of a polygon's surface (shoelace centroid); the mean of its corners when it has no surface. */
export function centroid(poly: readonly Pt[]): { x: number; y: number } {
  const a = doubleArea(poly);
  if (Math.abs(a) < 1e-9) return { x: poly.reduce((s, p) => s + p[0], 0) / poly.length, y: poly.reduce((s, p) => s + p[1], 0) / poly.length };
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
