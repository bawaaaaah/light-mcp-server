/**
 * A stage zone's shape on the plan (docs/specs/venue-fixtures-stage.md, « Zones »): the Lieu page
 * draws zones as rectangles from a width, a depth, a centre X and a front Y; these read them back,
 * and move a zone of any shape. Pure.
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
