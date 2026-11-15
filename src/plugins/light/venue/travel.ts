/**
 * A moving head's travel and the precision of its output (T8; docs/specs/venue-fixtures-stage.md, « Lyres »,
 * calibration manuelle): one step of an axis is its travel over 255 without a fine channel, over 65 535 with one. A
 * definition may give the fine channels in one DMX mode only: the modes that would add them are named, so that the
 * interface can offer to change mode (T6). Pure.
 */
import type { FixtureDefinition, FixtureMode } from "./qxf-import.js";

export type Axis = "pan" | "tilt";

/** Per axis, whether the mode drives it at all and whether with its fine channel. */
export function axesOf(def: FixtureDefinition, mode: FixtureMode): Record<Axis, { coarse: boolean; fine: boolean }> {
  const has = (axis: Axis, fine: boolean) => mode.channels.some((n) => def.channels.get(n)?.attribute === axis && Boolean(def.channels.get(n)?.fine) === fine);
  return { pan: { coarse: has("pan", false), fine: has("pan", true) }, tilt: { coarse: has("tilt", false), fine: has("tilt", true) } };
}

/** One step of the output on an axis, in degrees. */
export const stepDeg = (travel: number, fine: boolean): number => travel / (fine ? 65535 : 255);

/**
 * The other modes of the definition that drive with a fine channel an axis `mode` drives without one: a head patched in
 * a coarse mode whose model has a 16-bit one. Empty when the mode is already as fine as the definition allows.
 */
export function finerModes(def: FixtureDefinition, mode: FixtureMode): string[] {
  const now = axesOf(def, mode);
  const lacking = (["pan", "tilt"] as const).filter((a) => now[a].coarse && !now[a].fine);
  if (!lacking.length) return [];
  return def.modes.filter((m) => m.name !== mode.name && lacking.some((a) => axesOf(def, m)[a].fine)).map((m) => m.name);
}
