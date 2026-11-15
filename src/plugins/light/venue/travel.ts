/**
 * A moving head's travel and the precision of its output (T8; docs/specs/venue-fixtures-stage.md, « Lyres »,
 * calibration manuelle): one step of an axis is its travel over 255 without a fine channel, over 65 535 with one. A
 * definition may give the fine channels in one DMX mode only: the modes that would add them are named, so that the
 * interface can offer to change mode (T6). Pure.
 */
import type { FixtureDefinition, FixtureMode } from "./qxf-import.js";
import type { TravelOverrides } from "./overrides.js";

export type Axis = "pan" | "tilt";
type TravelKey = "panMax" | "tiltMax";
const TRAVEL_KEYS = ["panMax", "tiltMax"] as const;
const FALLBACK: Record<TravelKey, number> = { panMax: 540, tiltMax: 270 };

/** Where the travel of an axis comes from: the fixture's own correction, its model's, or the definition (its mode's, else its own). */
export type TravelSource = "fixture" | "model" | "definition";

/**
 * The travel that applies, axis by axis (decision E3 of the user): the fixture's own correction, else the mode's own
 * travel (a model's correction leaves a mode that declares its own alone: the maker wrote it for that mode), else the
 * model's correction, else the definition's, else 540°/270°.
 */
export function travelOf(def: FixtureDefinition, mode: FixtureMode, model: TravelOverrides | undefined, own: TravelOverrides | undefined): Record<TravelKey, number> & { applies: Record<TravelKey, TravelSource> } {
  const one = (k: TravelKey): [number, TravelSource] => {
    const fixture = own?.[k];
    if (fixture !== undefined) return [fixture, "fixture"];
    const ofMode = mode[k];
    if (ofMode !== undefined) return [ofMode, "definition"];
    const ofModel = model?.[k];
    if (ofModel !== undefined) return [ofModel, "model"];
    return [def[k] ?? FALLBACK[k], "definition"];
  };
  const [panMax, panFrom] = one("panMax");
  const [tiltMax, tiltFrom] = one("tiltMax");
  return { panMax, tiltMax, applies: { panMax: panFrom, tiltMax: tiltFrom } };
}

/** The modes of a definition a model's travel correction does not affect (decision E3): those declaring their own travel on an axis it corrects. */
export function modesKeepingTravel(def: FixtureDefinition, model: TravelOverrides | undefined): string[] {
  if (!model) return [];
  return def.modes.filter((m) => TRAVEL_KEYS.some((k) => model[k] !== undefined && m[k] !== undefined)).map((m) => m.name);
}

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
