/**
 * The manual calibration tab (T8, lot 6; docs/specs/venue-fixtures-stage.md, « Lyres », calibration manuelle): what
 * its fields read and check before anything reaches the server. Degrees typed with a comma or a point, an arrow press
 * of ± 0.1° (Shift ± 1°), a useful stop checked against the travel as venue.fixture.orient checks it, and whether
 * the position the pad asks lies beyond a stop (the output then holds the head at the stop). Pure.
 */
export type Axis = "pan" | "tilt";
export type Range = [number, number];
export type Stops = Partial<Record<Axis, Range>>;

/** A number typed in a field, « 1,5 » as « 1.5 »; undefined when it is not one. */
export function parseDeg(text: string): number | undefined {
  const s = text.trim().replace(/\s/g, "").replace(",", ".").replace(/^−/, "-");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
}

/** A tenth of a degree: what the fields show and send (the output's own step is finer on a 16-bit head). */
export const roundDeg = (v: number): number => Math.round(v * 10) / 10;

/** One arrow press on a degree field: ± 0.1°, Shift ± 1°; undefined for another key. */
export function nudgeDeg(value: number, key: string, shift: boolean): number | undefined {
  const sign = key === "ArrowUp" ? 1 : key === "ArrowDown" ? -1 : 0;
  if (!sign) return undefined;
  return roundDeg(value + sign * (shift ? 1 : 0.1));
}

/** Why a stop cannot be sent: its ends the wrong way round, or one beyond half the travel (venue.fixture.orient refuses it). */
export type StopProblem = { kind: "order" } | { kind: "outside"; half: number };

export function stopProblem(range: Range, travel: number): StopProblem | undefined {
  if (range[0] > range[1]) return { kind: "order" };
  const half = travel / 2;
  if (Math.abs(range[0]) > half + 1e-9 || Math.abs(range[1]) > half + 1e-9) return { kind: "outside", half };
  return undefined;
}

/** A logical position (0..1) in logical degrees: 0 the centre of the travel, the stops' frame. */
export const logicalDeg = (p: number, travel: number): number => (p - 0.5) * travel;

/**
 * The axes on which a logical position lies beyond its stop (a pad pushed past it: the head stays at the stop), by more
 * than one real step of the output (`step`, degrees: the pad moves on the output's grid, a position at the stop may
 * round a hair beyond it).
 */
export function beyondStops(p: { pan: number; tilt: number }, travel: { pan: number; tilt: number }, stops: Stops | undefined, step: { pan: number; tilt: number }): Axis[] {
  if (!stops) return [];
  return (["pan", "tilt"] as const).filter((axis) => {
    const r = stops[axis];
    if (!r) return false;
    const d = logicalDeg(p[axis], travel[axis]);
    return d < r[0] - step[axis] || d > r[1] + step[axis];
  });
}
