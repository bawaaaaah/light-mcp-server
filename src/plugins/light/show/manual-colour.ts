/**
 * The manual colour layer (T41, decision of the user of 2026-11-16; docs/specs/presets-songs-notes.md, « Appliquer une
 * couleur »): a colour applied by hand to fixtures sits above the looks and REPLACES the colour they paint there, at
 * the brightness they paint it (the look, its faders and the DCAs keep the light: an unpainted head stays dark). It
 * comes in and goes out with a fade, from whatever showed before. Pure: the runtime keeps one entry per fixture and
 * applies it to every head colour the looks paint on that fixture, the wheel's hues included.
 */
import { ease, mixColor } from "../engine/player.js";
import type { Color } from "../venue/venue.js";

/** Default length of the fade into and out of a manual colour. */
export const MANUAL_COLOUR_FADE_MS = 1000;
/** Fades still running under a newer one: older ones are collapsed past this depth (rapid presses). */
const MAX_DEPTH = 4;

/** One fixture's manual colour: where it goes (`to`; null: back to the looks), from what showed before (`prev`). */
export interface ManualColour {
  /** The colour asked, its hue at full (`#rrggbb` read 0..1); null: released, fading back to the looks. */
  to: Color | null;
  hex: string | null;
  t0: number;
  ms: number;
  /** What showed when it was asked (another manual colour on its way, or the looks themselves when absent). */
  prev?: ManualColour;
}

/** The brightness a colour carries: its strongest component. */
const level = (c: Color): number => Math.max(0, ...Object.values(c).map((v) => v ?? 0));

/**
 * The hue `to` at the brightness of `c`: red, green and blue only, as a look painting that `#rrggbb` gives (the other
 * emitters of the fixture, white, amber, UV, go to 0: replaced; the venue renders it as it renders a look's colour,
 * a colour wheel included). The hue is normalised: a dim preset gives the same colour as a bright one.
 */
export function recolour(c: Color, to: Color): Color {
  const top = level(to);
  if (top <= 0) return { red: 0, green: 0, blue: 0 };
  const k = level(c) / top;
  return { red: (to.red ?? 0) * k, green: (to.green ?? 0) * k, blue: (to.blue ?? 0) * k };
}

/** How far a fade has gone at `now` (eased, 1 once over or with no length). */
const progress = (m: ManualColour, now: number): number => (m.ms <= 0 ? 1 : ease(Math.min(1, Math.max(0, (now - m.t0) / m.ms))));

/** What a head the looks paint `c` shows under the manual colour `m` at `now`. */
export function underManual(m: ManualColour, c: Color, now: number): Color {
  const before = m.prev ? underManual(m.prev, c, now) : c;
  const after = m.to ? recolour(c, m.to) : c;
  const t = progress(m, now);
  return t >= 1 ? after : t <= 0 ? before : mixColor(before, after, t);
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
  if (settled(m, now) || !m.prev) {
    const { prev: _gone, ...rest } = m;
    return rest;
  }
  if (depth <= 1) {
    // too many presses in a row: the oldest one jumps to where it was going
    const { prev: _gone, ...rest } = m;
    return rest;
  }
  return { ...m, prev: trimmed(m.prev, now, depth - 1) };
}

/** Whether nothing is left to show: released and its fade back over. */
export const gone = (m: ManualColour, now: number): boolean => m.to === null && settled(m, now);
