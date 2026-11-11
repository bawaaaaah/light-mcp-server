/**
 * Screen rendering of light colours (previews, storyboards): pure.
 */
import type { Color } from "../venue/venue.js";

/** A light colour as screen red, green and blue (white and amber added, UV as a violet tint), not clamped: a sum may pass 1. */
export function lightRgb(c: Color): [number, number, number] {
  const w = (c.white ?? 0) + (c.warmWhite ?? 0) + (c.coldWhite ?? 0);
  const r = (c.red ?? 0) + w + (c.amber ?? 0) + (c.magenta ?? 0) + (c.yellow ?? 0) + 0.4 * (c.uv ?? 0);
  const g = (c.green ?? 0) + w + 0.75 * (c.amber ?? 0) + (c.cyan ?? 0) + (c.yellow ?? 0) + (c.lime ?? 0);
  const b = (c.blue ?? 0) + w + (c.cyan ?? 0) + (c.magenta ?? 0) + 0.8 * (c.uv ?? 0);
  return [r, g, b];
}

/** Screen colour of a light colour (white and amber added, UV as a violet tint). */
export function displayHex(c: Color): string {
  return "#" + lightRgb(c).map((v) => Math.round(Math.min(1, v) * 255).toString(16).padStart(2, "0")).join("");
}
