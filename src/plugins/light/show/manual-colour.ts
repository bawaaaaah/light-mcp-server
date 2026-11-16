/**
 * The manual colour layer (T41, decisions of the user of 2026-11-16; docs/specs/presets-songs-notes.md, « Appliquer une
 * couleur »): a colour applied by hand to fixtures sits above the looks and REPLACES the colour they paint there, at
 * the brightness they paint it (the look, its faders and the DCAs keep the light: an unpainted head stays dark). It
 * is the colour a look painting it would give (decision C4: every emitter its value names, the white LED of a
 * `+wNN` included), and it comes in and goes out with a fade from whatever showed before. A colour wheel never sees a
 * mixed hue: it switches at mid-fade (decision B1 of the review), as it does in a crossfade. Pure: the runtime keeps
 * one entry per fixture and applies it to every head colour the looks paint on that fixture.
 */
import { ease, mixColor } from "../engine/player.js";
import { hexToColor } from "../engine/techniques.js";
import type { Color } from "../venue/venue.js";

/** Default length of the fade into and out of a manual colour. */
export const MANUAL_COLOUR_FADE_MS = 1000;
/** Fades still running under a newer one: older ones are collapsed past this depth (rapid presses). */
const MAX_DEPTH = 4;
/** The emitters a colour may set: the ones it does not name go to 0 (replaced, not mixed with the look). */
const EMITTERS = ["red", "green", "blue", "white", "amber", "uv"] as const;

/** One fixture's manual colour: where it goes (`to`; null: back to the looks), from what showed before (`prev`). */
export interface ManualColour {
  /** The colour asked, as a look's colour reads it (0..1 per emitter); null: released, fading back to the looks. */
  to: Color | null;
  hex: string | null;
  t0: number;
  ms: number;
  /** What showed when it was asked (another manual colour on its way, or the looks themselves when absent). */
  prev?: ManualColour;
}

/** A colour applied by hand, read as a look reads its colours (`#rrggbb`, with a white LED part `+wNN` or not). */
export const manualColourOf = (hex: string): Color => hexToColor(hex);

/** The brightness a colour carries: its strongest component. */
export const levelOf = (c: Color): number => Math.max(0, ...Object.values(c).map((v) => v ?? 0));

/** `c` brought to the brightness `level` (its hue kept); black stays black. */
const atLevel = (c: Color, level: number): Color => {
  const top = levelOf(c);
  if (top <= 0) return c;
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, ((v ?? 0) * level) / top])) as Color;
};

/**
 * The colour `to` at the brightness of `c`, every emitter it names (red, green, blue and its white LED part), the other
 * emitters of the fixture (amber, UV, a white it does not name) at 0: replaced. The venue renders it as it renders a
 * look's colour, a colour wheel included. Its brightness is normalised: a dim preset gives the same colour as a bright one.
 */
export function recolour(c: Color, to: Color): Color {
  const out = Object.fromEntries(EMITTERS.map((k) => [k, to[k] ?? 0])) as Color;
  if (levelOf(to) <= 0) return Object.fromEntries(EMITTERS.map((k) => [k, 0])) as Color;
  return atLevel(out, levelOf(c));
}

/** How far a fade has gone at `now` (eased, 1 once over or with no length). */
const progress = (m: ManualColour, now: number): number => (m.ms <= 0 ? 1 : ease(Math.min(1, Math.max(0, (now - m.t0) / m.ms))));

/**
 * What a head the looks paint `c` shows under the manual colour `m` at `now`: a mix through the fade, kept at the look's
 * brightness all along (no dip at mid-fade, decision M3 of the review).
 */
export function underManual(m: ManualColour, c: Color, now: number): Color {
  const before = m.prev ? underManual(m.prev, c, now) : c;
  const after = m.to ? recolour(c, m.to) : c;
  const t = progress(m, now);
  if (t >= 1) return after;
  if (t <= 0) return before;
  return atLevel(mixColor(before, after, t), levelOf(c));
}

/** The hue a colour wheel is asked for under `m`: never a mix, the old one until mid-fade, the new one after (B1). */
export function hueUnderManual(m: ManualColour, c: Color, now: number): Color {
  const before = m.prev ? hueUnderManual(m.prev, c, now) : c;
  const after = m.to ? recolour(c, m.to) : c;
  return progress(m, now) < 0.5 ? before : after;
}

/** A new manual colour (or a release, `to` null) over what the fixture has now: its fade starts from there. */
export function nextManual(prev: ManualColour | undefined, to: Color | null, hex: string | null, now: number, ms: number): ManualColour {
  const kept = prev && settled(prev, now) && prev.to === null ? undefined : prev && trimmed(prev, now, MAX_DEPTH - 1);
  return { to, hex, t0: now, ms: Math.max(0, ms), ...(kept ? { prev: kept } : {}) };
}

/** Whether a fade is over (nothing below it still shows). */
export const settled = (m: ManualColour, now: number): boolean => progress(m, now) >= 1;

/** The entry without the fades that no longer show (over), and never deeper than `depth`. */
export function trimmed(m: ManualColour, now: number, depth = MAX_DEPTH): ManualColour {
  if (settled(m, now) || !m.prev || depth <= 1) {
    // over, or too many presses in a row: the oldest one jumps to where it was going
    const { prev: _gone, ...rest } = m;
    return rest;
  }
  return { ...m, prev: trimmed(m.prev, now, depth - 1) };
}

/** Whether nothing is left to show: released and its fade back over. */
export const gone = (m: ManualColour, now: number): boolean => m.to === null && settled(m, now);
