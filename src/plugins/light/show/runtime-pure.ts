/**
 * Pure helpers of the show runtime (show/runtime.ts, show/motion-controller.ts): no state, no clock, no I/O.
 */
import type { Look } from "./model.js";

/** The tempo the show plays at (the engine's clock). */
export interface TempoSource {
  /** `bpm`: the tempo a glide given in beats is timed at (the motion layer); 120 when the source gives none. */
  state(): { beats: number; bpm?: number };
}

/** A value rendered with its object keys sorted: two looks saved with a `map` in another key order are the same look. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** What a look plays, without what only names or files it (name, tags — its folder —, notes): renaming or filing a look changes nothing on stage. */
export function played(look: Look): string {
  const { name: _name, tags: _tags, notes: _notes, ...rest } = look;
  return canonical(rest);
}

/** Stable small seed from a string, so a random-order look plays the same way every time. */
export function seedOf(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** How far a stopped look is into its exit fade at `now`, 0..1: at 1 it neither paints nor moves a head any more. */
export const exitProgress = (r: { stopTime: number; exitFade: number }, now: number): number => Math.min(1, Math.max(0, (now - r.stopTime) / 1000) / r.exitFade);
