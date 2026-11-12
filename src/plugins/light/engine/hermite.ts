/**
 * A cubic leaving `from` at speed `v0` and landing on `to` at rest after `duration` (smoothstep when
 * v0 = 0): the velocity-continuous ease shared by fader smoothing (glide.ts) and the motion layer
 * (motion.ts). Pure: the caller gives the time. Units are the caller's (level or travel per ms).
 */
export interface Hermite {
  from: number;
  to: number;
  start: number;
  duration: number;
  /** Speed at the start, per ms. */
  v0: number;
}

/** Progress 0..1 on the curve at `now`: 1 once arrived or without a duration. */
export function hermiteProgress(m: Pick<Hermite, "start" | "duration">, now: number): number {
  return m.duration > 0 ? Math.min(1, Math.max(0, (now - m.start) / m.duration)) : 1;
}

/** Position on the curve at `now`, unclamped (the caller bounds it). */
export function hermiteAt(m: Hermite, now: number): number {
  const s = hermiteProgress(m, now);
  if (s >= 1) return m.to;
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * m.from + (s3 - 2 * s2 + s) * m.duration * m.v0 + (3 * s2 - 2 * s3) * m.to;
}

/** Speed on the curve at `now` (per ms); 0 before it starts and once arrived. */
export function hermiteSpeed(m: Hermite, now: number): number {
  if (m.duration <= 0) return 0;
  const s = (now - m.start) / m.duration;
  if (s < 0 || s >= 1) return 0;
  return ((6 * s * s - 6 * s) * (m.from - m.to)) / m.duration + (3 * s * s - 4 * s + 1) * m.v0;
}

/**
 * The largest starting speed (per ms) a curve of `duration` over `gap` takes without passing its
 * target: speed × time ≤ 3 × distance, beyond that the cubic overshoots.
 */
export const maxStartSpeed = (gap: number, duration: number): number => (duration > 0 ? (3 * Math.abs(gap)) / duration : 0);
