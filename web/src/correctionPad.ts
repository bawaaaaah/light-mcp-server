/**
 * The XY pad as a correction pad (T8, manual calibration; decisions Q3 and « précision du pad » of the user): instead of
 * the whole travel, the pad covers ± `half` degrees around a centre (the aim the calibration computes), so a finger moves
 * the head by fractions of a degree. Its precision is the output's: one real step is the travel over 65 535 with a fine
 * channel, over 255 without; without one the pad moves by whole steps and the default span widens to stay useful. Pure.
 */
export type Axis = "pan" | "tilt";
export type Point = { pan: number; tilt: number };

/** The spans offered (± degrees around the centre), ± 10° by default (decision Q3). */
export const CORRECTION_SPANS = [2, 10, 45] as const;
export type CorrectionSpan = (typeof CORRECTION_SPANS)[number];
export const DEFAULT_SPAN: CorrectionSpan = 10;

/** A pad covering ± `half` degrees around `center` (logical 0..1), on a head of this travel and output step. */
export interface PadSpan {
  center: Point;
  /** Half the pad's width and height, degrees (the pad's edge is `center ± half`). */
  half: number;
  /** The head's travel, degrees. */
  travel: Point;
  /** One real step of the output, degrees (venue.fixture.travel `step`). */
  step: Point;
  /** Per axis whether a fine channel drives it: without one the pad moves by whole steps. */
  fine: { pan: boolean; tilt: boolean };
}

/** Fewer steps than this across half the default span: too coarse to aim, the default widens. */
const MIN_STEPS = 10;

/**
 * The span a correction pad opens on: ± 10°, unless one step of an axis is more than a tenth of it (an 8-bit axis on a
 * long travel: 540° / 255 = 2.1° a step), then the widest offered.
 */
export function defaultSpan(step: Point): CorrectionSpan {
  return Math.max(step.pan, step.tilt) * MIN_STEPS > DEFAULT_SPAN ? CORRECTION_SPANS[CORRECTION_SPANS.length - 1]! : DEFAULT_SPAN;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** A logical value brought to the output's grid: whole 8-bit steps without a fine channel, 16-bit ones with it. */
export function quantize(v: number, fine: boolean): number {
  const n = fine ? 65535 : 255;
  return Math.round(clamp01(v) * n) / n;
}

/** A logical value kept on the pad (within `center ± half` degrees) and on the output's grid: where an arrow may take it. */
export function onPad(s: PadSpan, axis: Axis, v: number): number {
  const reach = s.half / s.travel[axis];
  return quantize(Math.max(s.center[axis] - reach, Math.min(s.center[axis] + reach, v)), s.fine[axis]);
}

/** The pad's centre on the output's grid: what « Origine » (Home) sends. */
export function padCenter(s: PadSpan): Point {
  return { pan: quantize(s.center.pan, s.fine.pan), tilt: quantize(s.center.tilt, s.fine.tilt) };
}

/** Pad fraction (0..1 across, 0..1 up) → logical position: the centre at 0.5, the edges at ± `half` degrees. */
export function padToLogical(s: PadSpan, x: number, y: number): Point {
  const at = (axis: Axis, f: number) => quantize(s.center[axis] + ((clamp01(f) - 0.5) * 2 * s.half) / s.travel[axis], s.fine[axis]);
  return { pan: at("pan", x), tilt: at("tilt", y) };
}

/** Logical position → pad fraction (may fall outside 0..1: a head beyond the pad's edge). */
export function logicalToPad(s: PadSpan, p: Point): Point {
  const at = (axis: Axis) => 0.5 + ((p[axis] - s.center[axis]) * s.travel[axis]) / (2 * s.half);
  return { pan: at("pan"), tilt: at("tilt") };
}

/**
 * One arrow press on a correction pad, in logical units: a hundredth of the pad (Shift: a tenth), never less than one
 * real step; `finest` (Alt) one real step. Without a fine channel, whole steps only.
 */
export function arrowStep(s: PadSpan, axis: Axis, { shift = false, finest = false }: { shift?: boolean; finest?: boolean } = {}): number {
  const real = s.step[axis] / s.travel[axis];
  if (finest) return real;
  const wanted = ((2 * s.half) / s.travel[axis]) * (shift ? 0.1 : 0.01);
  return Math.max(real, s.fine[axis] ? wanted : Math.round(wanted / real) * real);
}

/** The offset from the centre, degrees, of a logical position: what the pad shows as the correction asked. */
export function offsetDeg(s: Pick<PadSpan, "center" | "travel">, p: Point): Point {
  return { pan: (p.pan - s.center.pan) * s.travel.pan, tilt: (p.tilt - s.center.tilt) * s.travel.tilt };
}
