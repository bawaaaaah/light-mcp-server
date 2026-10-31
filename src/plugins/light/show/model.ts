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

/**
 * Raw channels played by a look (docs/specs/engine-effects-timing.md, « Canaux bruts »): DMX values
 * per step for channels outside the canvas — smoke, hazer, a lamp, a fan. Given by offset from the
 * fixture's address (works without a definition); stepped with the look's clock, no fade.
 */
export const LookChannelsSchema = z.object({
  targets: z.array(z.object({ fixture: z.string(), offset: z.number().int().min(0).max(511) })).min(1),
  /** One row per step, one value (0-255) per target. */
  steps: z.array(z.array(z.number().int().min(0).max(255))).min(1),
});
export type LookChannels = z.infer<typeof LookChannelsSchema>;

export const LookSchema = z.object({
  id: z.string(),
  name: z.string(),
  canvas: z.string(),
  technique: TechniqueSchema,
  /** By reference: the technique's colours come from this palette (changing it updates the look). */
  palette: z.string().optional(),
  timing: TimingSchema.prefault({}),
  /** Moving heads: position or Move FX played with the look (docs/specs/engine-effects-timing.md). */
  move: MoveSchema.optional(),
  /** Raw channels (machines, lamps) stepped with the look. */
  channels: LookChannelsSchema.optional(),
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

/**
 * Fader smoothing (docs/specs/groups-masters.md, « Lissage »): the level sent glides to the level
 * asked, `msPerStep` per 1/255 of the travel, at a fixed speed (`linear`) or eased in and out
 * (`ease`). Absent = the level applies at once.
 */
export const FaderSmoothingSchema = z.object({
  curve: z.enum(["linear", "ease"]).default("linear"),
  msPerStep: z.number().min(0.1).max(1000),
});
export type FaderSmoothing = z.infer<typeof FaderSmoothingSchema>;

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
    .prefault({}),
  /** Dynamic members: fixtures whose role / tags match. */
  selector: z.object({ role: z.string().optional(), tags: z.array(z.string()).optional() }).optional(),
  master: z.object({ level: z.number().min(0).max(1).default(1), mute: z.boolean().default(false), smoothing: FaderSmoothingSchema.optional() }).optional(),
  exclusive: z.boolean().default(false),
  /**
   * DCA limits (docs/specs/groups-masters.md): bounds of the effective level. `clamp`: the fader
   * stops at the bounds (position = level); `scale`: the whole travel maps onto min..max (best
   * for a physical MIDI fader). Mute still goes to 0; a flash goes to the max, never beyond.
   */
  limits: z
    .object({
      min: z.number().min(0).max(1).optional(),
      max: z.number().min(0).max(1).optional(),
      mode: z.enum(["clamp", "scale"]).default("clamp"),
    })
    .refine((l) => l.min === undefined || l.max === undefined || l.min <= l.max, { message: "min au-dessus du max" })
    .optional(),
  presets: z.object({ included: z.array(z.string()).default([]), excluded: z.array(z.string()).default([]) }).prefault({}),
  defaultButtonMode: z.enum(["trigger", "latch", "momentary", "toggle"]).optional(),
  /** Playback fader (a QLC+ « Playback » slider): above 0 its DCA starts the looks it doses, at 0 stops them. */
  playback: z.boolean().optional(),
  notes: z.string().optional(),
});
export type Group = z.infer<typeof GroupSchema>;

/**
 * Channel fader (docs/specs/groups-masters.md, « Fader de canaux »): drives raw channels — white,
 * UV, strobe, a machine — like a QLC+ « Level » slider, highest-takes-precedence with the show.
 * Channels are given by offset from the fixture's address, so it works even without a definition.
 * The rules mask still applies after it (UV max, strobe policy…).
 */
export const ChannelFaderSchema = z.object({
  id: z.string(),
  name: z.string(),
  channels: z.array(z.object({ fixture: z.string(), offset: z.number().int().min(0).max(511) })).min(1),
  level: z.number().min(0).max(1).default(0),
  /** The DMX values its travel covers, as a QLC+ level slider's low and high limits (default 0..255). */
  range: z.object({ min: z.number().int().min(0).max(255).default(0), max: z.number().int().min(0).max(255).default(255) }).optional(),
  /** DCA dosing this fader (a QLC+ Submaster in the same frame): its effective level multiplies the fader's. */
  dca: z.string().optional(),
  smoothing: FaderSmoothingSchema.optional(),
  notes: z.string().optional(),
});
export type ChannelFader = z.infer<typeof ChannelFaderSchema>;

/**
 * Snapshot (« instantané »): the whole live state saved ahead, recalled at once — by hand or by
 * « Panic neutre » as the safe state. Objects deleted since are skipped on recall.
 */
export const SnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Looks playing (latched buttons, playbacks, sections). */
  looks: z.array(z.string()).default([]),
  /** DCA levels and mutes, by group id. */
  groups: z.record(z.string(), z.object({ level: z.number().min(0).max(1), mute: z.boolean().default(false) })).prefault({}),
  /** Channel fader levels, by fader id. */
  faders: z.record(z.string(), z.number().min(0).max(1)).prefault({}),
  grandMaster: z.number().min(0).max(1).optional(),
  /** Active rule program; absent = none. */
  program: z.string().optional(),
  blackout: z.boolean().default(false),
  savedAt: z.string().optional(),
  notes: z.string().optional(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const ShowSettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  kind: z.literal("show").default("show"),
  name: z.string().default("Show"),
  venue: z.string().default("default"),
  /** Look recalled by « Panic neutre » when no safe snapshot is set; none → Blackout. */
  safeLook: z.string().optional(),
  /** Snapshot recalled by « Panic neutre » (the whole state: looks, DCA, faders…); wins over safeLook. */
  safeSnapshot: z.string().optional(),
  grandMaster: z.number().min(0).max(1).default(1),
  grandMasterSmoothing: FaderSmoothingSchema.optional(),
  defaultButtonMode: z.enum(["trigger", "latch", "momentary", "toggle"]).default("trigger"),
  /** Several looks on the same fixture: the last one started covers the others (« last »), or each colour keeps its highest value (« highest »: they add up). */
  looksMerge: z.enum(["last", "highest"]).default("last"),
  /** AI clients may touch up the service live (live.adjust): off until someone at the desk switches it on. */
  liveAi: z.boolean().default(false),
});
export type ShowSettings = z.infer<typeof ShowSettingsSchema>;
