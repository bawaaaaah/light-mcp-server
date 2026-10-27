/**
 * Fader smoothing (docs/specs/groups-masters.md, « Lissage »): the level sent glides to the level
 * asked instead of jumping. Pure: the caller gives the time, so tests need no clock.
 */
import type { FaderSmoothing } from "../show/model.js";
import { ease } from "./player.js";

interface Move {
  from: number;
  to: number;
  start: number;
  duration: number;
  curve: FaderSmoothing["curve"];
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
    const at = this.current.get(key);
    if (at === undefined) {
      // first sight (start-up, show opened, smoothing just switched on): no glide from nowhere
      this.current.set(key, target);
      return target;
    }
    let move = this.moves.get(key);
    if (move?.to !== target) {
      if (at === target) {
        this.moves.delete(key);
        return target;
      }
      // a new target, even mid-glide: start again from where the output is, never jump
      move = { from: at, to: target, start: now, duration: Math.abs(target - at) * 255 * smoothing.msPerStep, curve: smoothing.curve };
      this.moves.set(key, move);
    }
    const t = move.duration > 0 ? Math.min(1, Math.max(0, (now - move.start) / move.duration)) : 1;
    const level = t >= 1 ? move.to : move.from + (move.to - move.from) * (move.curve === "ease" ? ease(t) : t);
    this.current.set(key, level);
    if (t >= 1) this.moves.delete(key);
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
