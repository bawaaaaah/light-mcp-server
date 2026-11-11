/**
 * OKLab (Björn Ottosson, 2020): a perceptual colour space where a straight distance reads as people see
 * the difference — pinks, oranges and warm whites part better than in RGB. Pure; shared by whatever
 * compares light colours (the colour wheel's slot choice, venue/color-wheel.ts, by `tintDistance`).
 */

/** A colour in OKLab: lightness L (0 black .. 1 white), then the a (green → red) and b (blue → yellow) axes. */
export type Lab = readonly [number, number, number];

const linear = (u: number): number => (u > 0.04045 ? ((u + 0.055) / 1.055) ** 2.4 : u / 12.92);

/** An sRGB colour (components 0..1, as on screen) in OKLab. */
export function oklab([r, g, b]: readonly [number, number, number]): Lab {
  const [lr, lg, lb] = [linear(Math.max(0, r)), linear(Math.max(0, g)), linear(Math.max(0, b))];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** The distance between two OKLab colours (about 0.02 is barely seen, 0.3 and more is another colour). */
export const oklabDistance = (x: Lab, y: Lab): number => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);

/** How coloured an OKLab colour is: 0 on the grey axis (white, grey, black). */
export const chroma = (x: Lab): number => Math.hypot(x[1], x[2]);

/** An answer more saturated than the colour asked: the difference of saturation counts this much beside one of hue (`tintDistance`). */
export const SATURATION_WEIGHT = 0.4;
/** A difference of lightness counts this much in `tintDistance`: the level of a light goes to its dimmer. */
export const LIGHTNESS_WEIGHT = 0.25;

/**
 * How far the tint of `answer` (a filter, a slot) is from the tint `asked`, for lights whose level is set apart
 * (a dimmer carries it). Both are brought to one lightness (a and b over L: a deep violet and a light one are
 * the same tint) and the lightness left counts little (`LIGHTNESS_WEIGHT`). An answer **more** saturated than
 * what was asked, in the same hue, is near (`SATURATION_WEIGHT`): a pale pink is a pink before it is a warm
 * white. An answer **less** saturated counts in full: a deep orange is not a pale one, a tint is not a white.
 * Not symmetric: the order of the arguments matters.
 */
export function tintDistance(asked: Lab, answer: Lab): number {
  const [lx, ly] = [Math.max(asked[0], 1e-6), Math.max(answer[0], 1e-6)];
  const [ax, bx, ay, by] = [asked[1] / lx, asked[2] / lx, answer[1] / ly, answer[2] / ly];
  const saturation = Math.hypot(ay, by) - Math.hypot(ax, bx);
  // the chord between the two tints is their saturation difference and their hue difference, at right angles
  const hue2 = Math.max(0, (ax - ay) ** 2 + (bx - by) ** 2 - saturation ** 2);
  const weight = saturation > 0 ? SATURATION_WEIGHT : 1;
  return Math.sqrt((LIGHTNESS_WEIGHT * (asked[0] - answer[0])) ** 2 + (weight * saturation) ** 2 + hue2);
}
