/**
 * Settings that correct or extend what a fixture definition says, in one shape (docs/specs/venue-
 * fixtures-stage.md): set once for a **model** (every fixture of that manufacturer and model follows)
 * and overridable for **one fixture** of the patch. Each part belongs to one feature, which owns its
 * schema here: `wheel` the colour wheel's colour → slot correspondence (T18), `heads` the heads deduced
 * from a definition without <Head> and the accent (halo) one (T21), `tracks` which channels follow the
 * transitions (T5). A missing part means: the definition as it is.
 */
import { z } from "zod";

/** T18 — the colour wheel (owned by the T18 work: replace this placeholder with its schema). */
export const WheelOverridesSchema = z.record(z.string(), z.unknown());
/** T21 — the heads and the accent head (owned by the T21 work: replace this placeholder with its schema). */
export const HeadOverridesSchema = z.record(z.string(), z.unknown());
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

/** The id of a model's overrides: manufacturer and model compared without case or punctuation, as definitions are found. */
export const modelKey = (manufacturer: string, model: string): string => `${manufacturer} ${model}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** What applies to one fixture: the model's overrides, each part replaced as a whole by the fixture's own when it has one. */
export function mergeOverrides(model: FixtureOverrides | undefined, fixture: FixtureOverrides | undefined): FixtureOverrides {
  return { ...(model ?? {}), ...Object.fromEntries(Object.entries(fixture ?? {}).filter(([, v]) => v !== undefined)) };
}
