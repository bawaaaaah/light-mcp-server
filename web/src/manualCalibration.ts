/**
 * The manual calibration tab (T8, lot 6; docs/specs/venue-fixtures-stage.md, « Lyres », calibration manuelle): what
 * its fields read and check before anything reaches the server. Degrees typed with a comma or a point, an arrow press
 * of ± 0.1° (Shift ± 1°) on the hundredth the offsets are stored at, a value read back as it is typed, a useful stop
 * checked against the travel as venue.fixture.orient checks it, whether the position the pad asks lies beyond a stop
 * (the output then holds the head at the stop), and whether the head moved since a measure. Pure.
 */
export type Axis = "pan" | "tilt";
export type Range = [number, number];
export type Stops = Partial<Record<Axis, Range>>;

/** A number typed in a field (degrees, metres), « 1,5 » as « 1.5 », « −2 » as « -2 »; undefined when it is not one. */
export function parseNumber(text: string): number | undefined {
  const s = text.trim().replace(/\s/g, "").replace(",", ".").replace(/^−/, "-");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) {
    return undefined;
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
}
/** A number of degrees typed in a field. */
export const parseDeg = parseNumber;

/**
 * A hundredth of a degree: what the fields show, compare and send (calibration.correct writes offsets to that
 * precision; a field must not round them away when it is left untouched). Never −0.
 */
export const roundDeg = (v: number): number => Math.round(v * 100) / 100 || 0;

/** One arrow press on a degree field: ± 0.1°, Shift ± 1°, from the value as it is (0,25 → 0,35); undefined for another key. */
export function nudgeDeg(value: number, key: string, shift: boolean): number | undefined {
  const sign = key === "ArrowUp" ? 1 : key === "ArrowDown" ? -1 : 0;
  if (!sign) {
    return undefined;
  }
  return roundDeg(value + sign * (shift ? 1 : 0.1));
}

/** Why a stop cannot be sent: its ends the wrong way round, or one beyond half the travel (venue.fixture.orient refuses it). */
export type StopProblem = { kind: "order" } | { kind: "outside"; half: number };

export function stopProblem(range: Range, travel: number): StopProblem | undefined {
  if (range[0] > range[1]) {
    return { kind: "order" };
  }
  return edgeOutside(range[0], travel) ?? edgeOutside(range[1], travel);
}

/** One end of a stop beyond half the travel: said as soon as it is typed, before the other end. */
export function edgeOutside(edge: number, travel: number): StopProblem | undefined {
  const half = travel / 2;
  return Math.abs(edge) > half + 1e-9 ? { kind: "outside", half } : undefined;
}

/** Where a stop sits over the whole travel, in percent of the bar, kept on the bar when the stop lies beyond it. */
export function stopBar(range: Range | undefined, travel: number): { left: number; width: number } {
  if (!range) {
    return { left: 0, width: 100 };
  }
  const at = (d: number) => Math.min(100, Math.max(0, ((d + travel / 2) / travel) * 100));
  const left = at(range[0]);
  return { left, width: Math.max(0, at(range[1]) - left) };
}

/**
 * Whether the head moved since a measure, by more than half a real step of the output on an axis (`p` logical 0..1,
 * `step` degrees; one step moved, on an 8-bit head 1.4°, is a move): the measured gap no longer says where it is,
 * applying it would fold another position.
 */
export function movedSince(at: { pan: number; tilt: number }, now: { pan: number; tilt: number }, travel: { pan: number; tilt: number }, step: { pan: number; tilt: number }): boolean {
  return (["pan", "tilt"] as const).some((axis) => Math.abs(now[axis] - at[axis]) * travel[axis] > step[axis] * 0.5);
}

/** A field's value as it reads back: up to two decimals, no thousands separator (1080, never 1,080), a true minus « − », never −0. */
export function fieldText(v: number, locale: string): string {
  const r = roundDeg(v);
  const text = Math.abs(r).toLocaleString(locale, {
    maximumFractionDigits: 2,
    useGrouping: false,
  });
  return r < 0 ? `−${text}` : text;
}

/** A logical position (0..1) in logical degrees: 0 the centre of the travel, the stops' frame. */
export const logicalDeg = (p: number, travel: number): number => (p - 0.5) * travel;

/**
 * The axes on which a logical position lies beyond its stop (a pad pushed past it: the head stays at the stop), by more
 * than one real step of the output (`step`, degrees: the pad moves on the output's grid, a position at the stop may
 * round a hair beyond it).
 */
export function beyondStops(p: { pan: number; tilt: number }, travel: { pan: number; tilt: number }, stops: Stops | undefined, step: { pan: number; tilt: number }): Axis[] {
  if (!stops) {
    return [];
  }
  return (["pan", "tilt"] as const).filter((axis) => {
    const r = stops[axis];
    if (!r) {
      return false;
    }
    const d = logicalDeg(p[axis], travel[axis]);
    return d < r[0] - step[axis] || d > r[1] + step[axis];
  });
}
