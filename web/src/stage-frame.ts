/**
 * The frame of a top view of the stage (docs/specs/venue-fixtures-stage.md, « Live preview 2D »): which part of the
 * stage the drawing shows, and how metres turn into the drawing's units and back. Pure, so that the live plan, the
 * target pad (T24), the aiming zones (T27) and the looks by zone (T28) frame the stage the same way.
 *
 * Stage frame: metres, X stage left → right seen from the audience, Y front → upstage. The drawing has the audience at
 * the bottom: upstage is up.
 */

/** A point on the stage seen from above, metres. */
export interface StageXY {
  x: number;
  y: number;
}

/** What the frame reads of a fixture: where it stands, if it is placed. */
export interface FramedFixture {
  id: string;
  position?: { x: number; y: number } | undefined;
}

/** What the frame reads of a zone: its outline. */
export interface FramedZone {
  polygon: [number, number][];
}

export interface StageLayout {
  /** The part of the stage drawn, margins included (metres). */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Where each fixture is drawn: its position, or its place on the row of the unplaced ones in front. */
  pos: Map<string, StageXY>;
  /** How many fixtures have no stage position. */
  unplaced: number;
}

/**
 * What to draw: the zones and the placed fixtures, with a margin (0.8 m; 0.3 m around the row alone); the fixtures with
 * no stage position go on a row in front of the stage (at least 3 m wide, 1.2 m per fixture), 0.8 m before its front.
 */
export function stageLayout(fixtures: readonly FramedFixture[], zones: readonly FramedZone[]): StageLayout {
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
  const pos = new Map<string, StageXY>();
  for (const f of fixtures) if (f.position) pos.set(f.id, { x: f.position.x, y: f.position.y });
  unplaced.forEach((f, i) => pos.set(f.id, { x: -rowHalf + (2 * rowHalf * (i + 0.5)) / unplaced.length, y: rowY }));
  return { minX: minX - m, maxX: maxX + m, minY: minY - m, maxY: maxY + m, pos, unplaced: unplaced.length };
}

export interface StageFrame {
  /** Drawing units per metre. */
  scale: number;
  /** The drawing's height for its width `W` (at least `minHeight`). */
  H: number;
  /** Metres → drawing units. */
  sx: (x: number) => number;
  sy: (y: number) => number;
  /** Drawing units → metres: the inverse of sx, sy. */
  toStage: (px: number, py: number) => StageXY;
}

/** The frame of a layout drawn `W` units wide: the scale fits its width, the height follows (upstage at the top). */
export function stageFrame(layout: Pick<StageLayout, "minX" | "maxX" | "minY" | "maxY">, W: number, minHeight = 160): StageFrame {
  const scale = W / (layout.maxX - layout.minX);
  const H = Math.max(minHeight, (layout.maxY - layout.minY) * scale);
  return {
    scale,
    H,
    sx: (x) => (x - layout.minX) * scale,
    sy: (y) => H - (y - layout.minY) * scale,
    toStage: (px, py) => ({ x: px / scale + layout.minX, y: (H - py) / scale + layout.minY }),
  };
}

/**
 * Where a pointer event falls in the drawing's units: the drawing is shown in `rect` (its box on screen), its viewBox
 * `VW` × `VH` starting `pad` before the stage's origin (room left for the names).
 */
export function pointerToDrawing(e: { clientX: number; clientY: number }, rect: { left: number; top: number; width: number; height: number }, VW: number, VH: number, pad: { left: number; top: number }): { px: number; py: number } {
  return { px: ((e.clientX - rect.left) / rect.width) * VW - pad.left, py: ((e.clientY - rect.top) / rect.height) * VH - pad.top };
}

/**
 * The box a drawing `VW` × `VH` really takes inside `rect` when it is fitted whole and centred (an SVG with
 * preserveAspectRatio « xMidYMid meet »: the target pad, T24): what pointerToDrawing needs as its rect.
 */
export function fittedBox(rect: { left: number; top: number; width: number; height: number }, VW: number, VH: number): { left: number; top: number; width: number; height: number } {
  const k = Math.min(rect.width / VW, rect.height / VH);
  const [width, height] = [VW * k, VH * k];
  return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
}
