/**
 * Placing several fixtures at once (docs/specs/venue-fixtures-stage.md, « Placer la sélection »):
 * evenly spaced along one edge of a zone — the front of the stage, the back, the jardin or cour
 * side, or across its middle — in the order given: from jardin to cour, or from the front to the
 * back. Pure; positions in metres, rounded to 10 cm like a drag on the plan.
 */
export const EDGES = ["front", "back", "houseLeft", "houseRight", "middle"] as const;
export type Edge = (typeof EDGES)[number];

/** Height above its floor a fixture gets from its mount when none is given (metres). */
export function mountHeight(mount?: string): number {
  return mount === "hung" || mount === "truss" || mount === "ceiling" ? 5 : mount === "stand" ? 1.8 : mount === "wall" || mount === "pillar" ? 3 : 0.3;
}

const round = (v: number) => Math.round(v * 10) / 10;

/** `count` points along an edge of the polygon's bounding box, `inset` metres inside it. */
export function arrangeAlong(polygon: [number, number][], edge: Edge, count: number, inset = 0.3): { x: number; y: number }[] {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // a narrow zone keeps its line inside it
  const inX = Math.min(inset, (maxX - minX) / 2);
  const inY = Math.min(inset, (maxY - minY) / 2);
  const along = (from: number, to: number, i: number) => from + ((to - from) * (i + 0.5)) / count;
  return Array.from({ length: count }, (_, i) => {
    switch (edge) {
      case "front":
        return { x: round(along(minX, maxX, i)), y: round(minY + inY) };
      case "back":
        return { x: round(along(minX, maxX, i)), y: round(maxY - inY) };
      case "middle":
        return { x: round(along(minX, maxX, i)), y: round((minY + maxY) / 2) };
      case "houseLeft":
        return { x: round(minX + inX), y: round(along(minY, maxY, i)) };
      case "houseRight":
        return { x: round(maxX - inX), y: round(along(minY, maxY, i)) };
    }
  });
}
