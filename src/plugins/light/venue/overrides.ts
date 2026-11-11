/**
 * Settings that correct or extend what a fixture definition says, in one shape (docs/specs/venue-
 * fixtures-stage.md): set once for a **model** (every fixture of that manufacturer and model follows)
 * and overridable for **one fixture** of the patch. Each part belongs to one feature, which owns its
 * schema here: `wheel` the colour wheel's colour → slot correspondence (T18), `heads` the heads deduced
 * from a definition without <Head> and the accent (halo) one (T21), `tracks` which channels follow the
 * transitions (T5). A missing part means: the definition as it is.
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
  /** Per slot, keyed by its range's first value ("16"). */
  slots: z.record(z.string().regex(/^\d{1,3}$/), WheelSlotOverrideSchema).optional(),
  /** Split slots (two colours) may be chosen when a look asks those two colours of the fixture (default true). */
  doubles: z.boolean().optional(),
  /** When the slot changes during a crossfade: « mid » at mid-fade (default), « black » with the dimmer through black at that moment. */
  change: z.enum(["mid", "black"]).optional(),
});
export type WheelOverrides = z.infer<typeof WheelOverridesSchema>;
/**
 * T21 — the accent heads of a fixture (venue/heads.ts): a halo, a ring, a back light, found by their channel names
 * unless `accent` lists them (channel names of the definition; [] = no accent, every head is a full one). `follow`
 * false: an accent head the looks do not paint stays dark instead of taking the colour of the others.
 */
export const HeadOverridesSchema = z.object({
  accent: z.array(z.string()).optional(),
  follow: z.boolean().optional(),
});
export type HeadOverrides = z.infer<typeof HeadOverridesSchema>;
/** T5 — the channels that follow transitions (owned by the T5 work, later). */
export const TrackOverridesSchema = z.record(z.string(), z.unknown());

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
  const [m, n] = [normaliseName(manufacturer), normaliseName(model)];
  if (!m || !n) throw new Error(say(`nom de modèle sans lettre ni chiffre : « ${manufacturer} » « ${model} »`, `model name without a letter or digit: “${manufacturer}” “${model}”`));
  return `${m}_${n}`;
};

/** What applies to one fixture: the model's overrides, each part replaced as a whole by the fixture's own when it has one. */
export function mergeOverrides(model: FixtureOverrides | undefined, fixture: FixtureOverrides | undefined): FixtureOverrides {
  return { ...(model ?? {}), ...Object.fromEntries(Object.entries(fixture ?? {}).filter(([, v]) => v !== undefined)) };
}
