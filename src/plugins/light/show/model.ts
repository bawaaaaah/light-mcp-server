/**
 * Show content schemas (docs/specs/presets-songs-notes.md, groups-masters.md).
 */
import { z } from "zod";
import { TechniqueSchema } from "../engine/techniques.js";
import { TimingSchema } from "../engine/player.js";
import { MoveSchema } from "../engine/move.js";

export const PaletteSchema = z.object({
  id: z.string(),
  name: z.string(),
  colors: z.array(z.string()).min(1).max(20),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type Palette = z.infer<typeof PaletteSchema>;

export const LookSchema = z.object({
  id: z.string(),
  name: z.string(),
  canvas: z.string(),
  technique: TechniqueSchema,
  /** By reference: the technique's colours come from this palette (changing it updates the look). */
  palette: z.string().optional(),
  timing: TimingSchema.default({}),
  /** Moving heads: position or Move FX played with the look (docs/specs/engine-effects-timing.md). */
  move: MoveSchema.optional(),
  /** Mirrored composition (paint the left half, fold it); default: the canvas topology. */
  mirror: z.boolean().optional(),
  /** Section safety flags (docs/specs/rules-limits.md). */
  manualOnly: z.boolean().default(false),
  noCut: z.boolean().default(false),
  danger: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type Look = z.infer<typeof LookSchema>;

/** Unified group (docs/specs/groups-masters.md). */
export const GroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().optional(),
  members: z
    .object({
      fixtures: z.array(z.string()).default([]),
      looks: z.array(z.string()).default([]),
      groups: z.array(z.string()).default([]),
    })
    .default({}),
  /** Dynamic members: fixtures whose role / tags match. */
  selector: z.object({ role: z.string().optional(), tags: z.array(z.string()).optional() }).optional(),
  master: z.object({ level: z.number().min(0).max(1).default(1), mute: z.boolean().default(false) }).optional(),
  exclusive: z.boolean().default(false),
  limits: z.object({ max: z.number().min(0).max(1).optional() }).optional(),
  presets: z.object({ included: z.array(z.string()).default([]), excluded: z.array(z.string()).default([]) }).default({}),
  defaultButtonMode: z.enum(["trigger", "latch", "momentary"]).optional(),
  notes: z.string().optional(),
});
export type Group = z.infer<typeof GroupSchema>;

export const ShowSettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  kind: z.literal("show").default("show"),
  name: z.string().default("Show"),
  venue: z.string().default("default"),
  /** Look recalled by « Panic neutre »; none → Blackout. */
  safeLook: z.string().optional(),
  grandMaster: z.number().min(0).max(1).default(1),
  defaultButtonMode: z.enum(["trigger", "latch", "momentary"]).default("trigger"),
});
export type ShowSettings = z.infer<typeof ShowSettingsSchema>;
