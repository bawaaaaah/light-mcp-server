/**
 * Settings that correct or extend what a fixture definition says, in one shape (docs/specs/venue-
 * fixtures-stage.md): set once for a **model** (every fixture of that manufacturer and model follows)
 * and overridable for **one fixture** of the patch. Each part belongs to one feature, which owns its
 * schema here: `wheel` the colour wheel's colour → slot correspondence (T18), `heads` the heads deduced
 * from a definition without <Head> and the accent (halo) one (T21), `tracks` which channels follow the
 * transitions (T5). A missing part means: the definition as it is. A fixture's own part replaces its
 * model's as a whole (mergeOverrides), except `heads` (`accent`, `follow`) and `tracks` (`fade`; `enabled` is
 * the fixture's only), merged field by field.
 */
import { z } from "zod";
import { say } from "../../../core/lang.js";
import { normaliseName } from "./qxf-import.js";

const HexSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** T18 — one slot of the colour wheel, named by the first DMX value of its range (its `min`). */
export const WheelSlotOverrideSchema = z.object({
  /** The slot's real colour, when the definition gives a wrong one (or none): chosen and shown by it. */
  color: HexSchema.optional(),
  /** Colours this slot answers to, beside its own: an asked colour nearest one of these lands on it (« this red goes to the orange slot »). */
  answers: z.array(HexSchema).max(16).optional(),
  /** Never chosen from a painted colour (a damaged filter, a slot to keep for raw channels). */
  off: z.boolean().optional(),
});
export type WheelSlotOverride = z.infer<typeof WheelSlotOverrideSchema>;

/** T18 — the colour wheel's colour → slot correspondence (venue/color-wheel.ts). Each field missing: the default. */
export const WheelOverridesSchema = z.object({
  /** Per slot, keyed by its range's first DMX value ("16": 0 to 255, no leading zero). */
  slots: z.record(z.string().regex(/^(0|[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])$/), WheelSlotOverrideSchema).optional(),
  /** Split slots (two colours) may be chosen when a look asks those two colours of the fixture (default true). */
  doubles: z.boolean().optional(),
  /** When the slot changes during a crossfade: « mid » at mid-fade (default), « black » with the dimmer through black at that moment. */
  change: z.enum(["mid", "black"]).optional(),
  /** « black » only: how long the wheel takes to turn from one slot to another, in ms — the dimmer stays at 0 that long after a change (default `WHEEL_CHANGE_MS`, color-wheel.ts). */
  changeMs: z.number().int().min(0).max(5000).optional(),
});
export type WheelOverrides = z.infer<typeof WheelOverridesSchema>;
/**
 * T21 — the accent heads of a fixture (venue/heads.ts): a halo (an unnumbered ring, a backlight), found by their
 * channel names unless `accent` lists them (channel names of the definition, whole heads; a mode with none of them
 * keeps the detection by name; [] = no accent, every head is a full one). `follow` false: an accent head stays dark
 * unless a look paints it, instead of taking the colour of the other heads or of a whole-fixture colour.
 */
export const HeadOverridesSchema = z.object({
  accent: z.array(z.string()).optional(),
  follow: z.boolean().optional(),
});
export type HeadOverrides = z.infer<typeof HeadOverridesSchema>;
/**
 * T5 — the channels that follow the transitions (venue/tracks.ts, docs/specs/engine-effects-timing.md, « Pistes
 * fondables »). `enabled` is read on the fixture only: its channels then follow `fade` (absent or false: the engine
 * as before, to the byte). `fade`: the channels that fade, by their name in the definition (the same in every mode;
 * a fine channel follows its coarse one); every other channel jumps (at mid-fade in a crossfade).
 */
export const TrackOverridesSchema = z
  .object({
    enabled: z.boolean().optional(),
    fade: z.array(z.string().min(1)).max(128).optional(),
  })
  .strict();
export type TrackOverrides = z.infer<typeof TrackOverridesSchema>;

export const FixtureOverridesSchema = z.object({
  wheel: WheelOverridesSchema.optional(),
  heads: HeadOverridesSchema.optional(),
  tracks: TrackOverridesSchema.optional(),
});
export type FixtureOverrides = z.infer<typeof FixtureOverridesSchema>;

/** A model's overrides, stored in the venue (collection « models »), keyed by `modelKey`. */
export const ModelOverridesSchema = z.object({
  id: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  overrides: FixtureOverridesSchema.default({}),
});
export type ModelOverrides = z.infer<typeof ModelOverridesSchema>;

/**
 * The id of a model's overrides: manufacturer and model each normalised as definitions are found
 * (qxf-import.ts normaliseName: accents, case, spaces and punctuation dropped), apart, so that
 * (« A », « B C ») and (« A B », « C ») stay two models. A name without a letter or digit would key
 * every such model alike: refused.
 */
export const modelKey = (manufacturer: string, model: string): string => {
  const key = modelKeyOrUndefined(manufacturer, model);
  if (!key) throw new Error(say(`nom de modèle sans lettre ni chiffre : « ${manufacturer} » « ${model} »`, `model name without a letter or digit: “${manufacturer}” “${model}”`));
  return key;
};

/** A model's key (`modelKey`), or undefined when one of its names has no letter or digit: such a model has no overrides. */
export const modelKeyOrUndefined = (manufacturer: string, model: string): string | undefined => {
  const [m, n] = [normaliseName(manufacturer), normaliseName(model)];
  return m && n ? `${m}_${n}` : undefined;
};

/**
 * What applies to one fixture: the model's overrides, each part replaced as a whole by the fixture's own when it has
 * one, except `heads`, merged field by field (the fixture's `accent` or `follow` over the model's): a fixture that
 * only keeps its halo dark still has the model's accent. `wheel` stays whole (one slot table). `tracks` is merged
 * field by field too, but `enabled` comes from the fixture only (a model's, from an archive written by hand, is
 * ignored): the fixture's `fade` list, else its model's.
 */
export function mergeOverrides(model: FixtureOverrides | undefined, fixture: FixtureOverrides | undefined): FixtureOverrides {
  const merged: FixtureOverrides = { ...(model ?? {}), ...Object.fromEntries(Object.entries(fixture ?? {}).filter(([, v]) => v !== undefined)) };
  if (model?.heads && fixture?.heads) merged.heads = { ...model.heads, ...Object.fromEntries(Object.entries(fixture.heads).filter(([, v]) => v !== undefined)) };
  const fade = fixture?.tracks?.fade ?? model?.tracks?.fade;
  const enabled = fixture?.tracks?.enabled;
  if (fade || enabled !== undefined) merged.tracks = { ...(enabled !== undefined ? { enabled } : {}), ...(fade ? { fade } : {}) };
  else delete merged.tracks;
  return merged;
}
