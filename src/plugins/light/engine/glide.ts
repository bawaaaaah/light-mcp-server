/**
 * Fader smoothing (docs/specs/groups-masters.md, « Lissage »): the level sent glides to the level
 * asked instead of jumping. Pure: the caller gives the time, so tests need no clock.
 *
 * Eased glides keep their speed when the target moves mid-glide (a MIDI fader sends a new value
 * every few ms): a curve starting at the current speed and landing at rest, never a new ease in
 * from standstill — which kept the output crawling behind a fader being pushed. Turning back
 * brakes first, then eases towards the new target.
 */
import type { FaderSmoothing } from "../show/model.js";

interface Move {
  from: number;
  to: number;
  /** Where the fader asks to go: `to` itself, or beyond it while braking before turning back. */
  goal: number;
  start: number;
  duration: number;
  curve: FaderSmoothing["curve"];
  /** Speed at the start (level per ms): the speed the output had when the target moved. */
  v0: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Position on a move at `now`: a straight line, or a cubic leaving `from` at `v0` and landing on `to` at rest (smoothstep when v0 = 0). */
function positionOf(m: Move, now: number): number {
  const s = m.duration > 0 ? Math.min(1, Math.max(0, (now - m.start) / m.duration)) : 1;
  if (s >= 1) return m.to;
  if (m.curve === "linear") return m.from + (m.to - m.from) * s;
  const s2 = s * s;
  const s3 = s2 * s;
  return clamp01((2 * s3 - 3 * s2 + 1) * m.from + (s3 - 2 * s2 + s) * m.duration * m.v0 + (3 * s2 - 2 * s3) * m.to);
}

/** Speed on a move at `now` (level per ms); 0 once arrived. */
function speedOf(m: Move, now: number): number {
  if (m.duration <= 0) return 0;
  const s = (now - m.start) / m.duration;
  if (s < 0 || s >= 1) return 0;
  if (m.curve === "linear") return (m.to - m.from) / m.duration;
  return ((6 * s * s - 6 * s) * (m.from - m.to)) / m.duration + (3 * s * s - 4 * s + 1) * m.v0;
}

/**
 * The move from `at`, at speed `v`, to `target`. `msFull` is a full travel's time; `limit` is the
 * goal of the move under way, which a braking output never passes.
 */
function plan(at: number, v: number, target: number, smoothing: FaderSmoothing, now: number, limit: number): Move {
  const msFull = 255 * smoothing.msPerStep;
  const d = target - at;
  const nominal = Math.abs(d) * msFull;
  const base = { start: now, curve: smoothing.curve, goal: target };
  if (smoothing.curve === "linear" || v === 0) return { ...base, from: at, to: target, duration: nominal, v0: 0 };
  if (v * d > 0) {
    // same way: carry on at this speed and slow down onto the target. Landing without passing it
    // asks speed × time ≤ 3 × distance (beyond, the cubic overshoots): a fast output close to its
    // target lands sooner, more firmly
    return { ...base, from: at, to: target, duration: Math.min(nominal, (3 * Math.abs(d)) / Math.abs(v)), v0: v };
  }
  // turning back: brake first, as gently as a full travel's ease would, never past where it was going
  const room = Math.abs(limit - at) * (Math.sign(limit - at) === Math.sign(v) ? 1 : 0);
  const stop = Math.min((v * v * msFull * msFull) / 8, room); // braking over k = 2: distance = speed × time / 2
  if (stop <= 0) return { ...base, from: at, to: target, duration: nominal, v0: 0 };
  return { ...base, from: at, to: clamp01(at + Math.sign(v) * stop), duration: (2 * stop) / Math.abs(v), v0: v };
}

/** Levels gliding towards their targets, by key (`group:<id>`, `fader:<id>`, `gm`). */
export class Glide {
  private readonly moves = new Map<string, Move>();
  private readonly current = new Map<string, number>();

  /** The level to send now for `key`, asked to reach `target`; without smoothing, the target at once. */
  value(key: string, target: number, smoothing: FaderSmoothing | undefined, now: number): number {
    if (!smoothing) {
      this.moves.delete(key);
      this.current.delete(key);
      return target;
    }
    const last = this.current.get(key);
    if (last === undefined) {
      // first sight (start-up, show opened, smoothing just switched on): no glide from nowhere
      this.current.set(key, target);
      return target;
    }
    let move = this.moves.get(key);
    if (move?.goal !== target) {
      // a new target, even mid-glide: from where the output is, at the speed it has, never a jump
      const at = move ? positionOf(move, now) : last;
      const v = move ? speedOf(move, now) : 0;
      if (at === target && v === 0) {
        this.moves.delete(key);
        this.current.set(key, target);
        return target;
      }
      move = plan(at, v, target, smoothing, now, move?.goal ?? at);
      this.moves.set(key, move);
    }
    const level = positionOf(move, now);
    this.current.set(key, level);
    if (now - move.start >= move.duration) {
      // arrived; after a brake, on to the goal from standstill at once (the ghost bar never blinks)
      if (move.to !== move.goal) this.moves.set(key, plan(move.to, 0, move.goal, smoothing, now, move.to));
      else this.moves.delete(key);
    }
    return level;
  }

  /** The keys still gliding at `now`, with the level sent at their last frame (a deleted fader's glide ends on its own). */
  moving(now: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, move] of this.moves) {
      if (now - move.start < move.duration) out[key] = this.current.get(key)!;
      else this.moves.delete(key);
    }
    return out;
  }

  /** Forgets a key (its fader was deleted). */
  forget(key: string): void {
    this.moves.delete(key);
    this.current.delete(key);
  }
}
