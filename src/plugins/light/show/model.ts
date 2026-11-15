/**
 * Show content schemas (docs/specs/presets-songs-notes.md, groups-masters.md).
 */
import { z } from "zod";
import { TechniqueSchema } from "../engine/techniques.js";
import { TimingSchema } from "../engine/player.js";
import { MoveFadeSchema, MoveSchema, DEFAULT_MOVE_FADE, RestPositionSchema } from "../engine/move.js";
import { normalizeFolder } from "./folders.js";
import { MotionLockSchema, MotionLockStateSchema } from "./motion-lock.js";
import { say } from "../../../core/lang.js";

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

/** A point of the stage, in metres (venue/stage.ts frame: X stage left → right, Y front → upstage, Z up). */
export const StagePointSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });

/**
 * Target (« cible », T24; docs/specs/venue-fixtures-stage.md, « Cible »): a 3D point that moving heads follow. Its heads
 * are a list, a group, or both (their union). Engaged by hand, it claims them at the motion layer's target layer (above
 * the looks, below the manual layer); a look's `move.at.target` follows it without engaging it. The point, `engaged`
 * and `engagedAt` are live state (written by target.set / target.engage without a backup); the rest is design.
 */
export const TargetSchema = z.object({
  id: z.string(),
  name: z.string(),
  fixtures: z.array(z.string()).default([]),
  group: z.string().optional(),
  /** Bounded to `bounds` (the stage volume by default) on every write. */
  point: StagePointSchema,
  engaged: z.boolean().default(false),
  /** When it was last engaged (ms since the epoch, strictly increasing): between two targets on one head, the last engaged wins, restart included. */
  engagedAt: z.number().int().optional(),
  /** The box the point moves in; absent: the stage volume (venue/target-aim.ts `stageBounds`). */
  bounds: z
    .object({ min: StagePointSchema, max: StagePointSchema })
    .refine((b) => b.min.x <= b.max.x && b.min.y <= b.max.y && b.min.z <= b.max.z, { message: "min au-dessus du max" })
    .optional(),
  /** The point glides to where it is asked (Glide, per axis across the bounds); absent: it moves at once. */
  smoothing: FaderSmoothingSchema.optional(),
  /** How the heads take over to the target when it is engaged (as `look.move.fade`); absent: the show's `moveFade`. */
  fade: MoveFadeSchema.optional(),
  color: z.string().optional(),
  notes: z.string().optional(),
});
export type Target = z.infer<typeof TargetSchema>;

/** A logical pan/tilt (0..1 of the travel, 0.5 = centre), as a named position stores it per head. */
export const PresetValueSchema = z.object({ pan: z.number().min(0).max(1), tilt: z.number().min(0).max(1) });

/**
 * Named position (« position nommée », T32; docs/specs/venue-fixtures-stage.md, « Positions nommées »): where moving
 * heads go, saved under a name, recalled by hand (a manual gesture of the motion layer) or followed by a look
 * (`move.at.position`), both read at render: a position readjusted moves what follows it. One of two kinds, never both
 * (decision Q3 of 2026-11-11): **pan/tilt** per covered head (`values`; the heads it covers, one, several or all,
 * decision Q1), or a **3D point** of the stage (`point`) every placed head aims at. `basis` is the fingerprint of
 * what gave each head's pan/tilt its meaning when saved (position, mount, orientation, travel, definition):
 * one that changed makes the position stale for that head, said and never corrected silently (decision Q4).
 */
export const PositionPresetSchema = z
  .object({
    id: z.string(),
    name: z.string().min(1),
    /** Pan/tilt per covered head (fixture id). */
    values: z.record(z.string(), PresetValueSchema).default({}),
    /** Or a point of the stage (metres): each placed head aims at it (aimNear, from where it is). */
    point: StagePointSchema.optional(),
    /** A pan/tilt position aimed at a point when saved: what a stale head is recomputed from (decision Q4, « la recalculer »). */
    aim: StagePointSchema.optional(),
    /**
     * The covered heads whose pan/tilt come from `aim` (aimed at it when saved, or recomputed from it): only those are
     * recomputed. Absent with an `aim`: every covered head (as saved before it existed).
     */
    aimed: z.array(z.string()).optional(),
    /** Per covered head: the fingerprint of its geometry when its pan/tilt was saved (show/position-presets.ts basisOf). */
    basis: z.record(z.string(), z.string()).default({}),
    color: z.string().optional(),
    tags: z.array(z.string()).default([]),
    notes: z.string().optional(),
  })
  .refine((p) => (Object.keys(p.values).length > 0) !== (p.point !== undefined), { error: () => say("pan/tilt par lyre (values) ou un point (point) : l'un des deux, pas les deux", "pan/tilt per head (values) or a point (point): one of the two, not both") })
  .refine((p) => p.aim === undefined || p.point === undefined, { error: () => say("aim ne va qu'avec une position pan/tilt", "aim only goes with a pan/tilt position") })
  .refine((p) => p.aimed === undefined || (p.aim !== undefined && p.aimed.every((h) => Object.hasOwn(p.values, h))), { error: () => say("aimed : des lyres couvertes, et seulement avec aim", "aimed: covered heads, and only with aim") });
export type PositionPreset = z.infer<typeof PositionPresetSchema>;

/** What a snapshot keeps of a target (T24, decision Q4 of 2026-11-11): its point and whether it is engaged. */
export const SnapshotTargetSchema = z.object({ point: StagePointSchema, engaged: z.boolean(), engagedAt: z.number().int().optional() });

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
  /** « Figer les lyres » (T26): the lock levels when it was saved, put back exactly on recall (decision Q3); absent (an older snapshot): the lock is left as it is. */
  motionLock: MotionLockStateSchema.optional(),
  /** Targets (T24): point and engagement by target id, put back on recall (the targets it does not list are disengaged); absent (an older snapshot): the targets are left as they are. */
  targets: z.record(z.string(), SnapshotTargetSchema).optional(),
  savedAt: z.string().optional(),
  notes: z.string().optional(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const ShowSettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  kind: z.literal("show").default("show"),
  name: z.string().default("Show"),
  venue: z.string().default("default"),
  /** Fixtures of the venue that are not installed for this show: kept in the patch, but dark, silent on DMX and ignored by the address check. */
  absentFixtures: z.array(z.string()).default([]),
  /** Folders named ahead for this show: they exist even before a look carries them (the rest come from the looks' dossier: tags). */
  // read normalised like the looks' folder tags (« A / B » is « A/B »), deduped, an empty name dropped
  folders: z
    .array(z.string())
    .default([])
    .transform((list) => [...new Set(list.map(normalizeFolder).filter(Boolean))]),
  /** Look recalled by « Panic neutre » when no safe snapshot is set; none → Blackout. */
  safeLook: z.string().optional(),
  /** Snapshot recalled by « Panic neutre » (the whole state: looks, DCA, faders…); wins over safeLook. */
  safeSnapshot: z.string().optional(),
  /** Snapshot recalled when the application starts (unless a recent crash-resume state wins) and when this show is opened. */
  startupSnapshot: z.string().optional(),
  grandMaster: z.number().min(0).max(1).default(1),
  grandMasterSmoothing: FaderSmoothingSchema.optional(),
  defaultButtonMode: z.enum(["trigger", "latch", "momentary", "toggle"]).default("trigger"),
  /** Several looks on the same fixture: the last one started covers the others (« last »), or each colour keeps its highest value (« highest »: they add up). */
  looksMerge: z.enum(["last", "highest"]).default("last"),
  /** AI clients may touch up the service live (live.adjust): off until someone at the desk switches it on. */
  liveAi: z.boolean().default(false),
  /** Default glide of a head to a new position (beats at the current tempo, or seconds); a look's `move.fade` overrides it. 0 = cut. */
  moveFade: MoveFadeSchema.default(DEFAULT_MOVE_FADE),
  /** Rest position per moving head (fixture id → normalised pan/tilt): where a head nobody moves returns to. Absent: the centre. */
  restPositions: z.record(z.string(), RestPositionSchema).default({}),
  /** « Figer les lyres » (T26, show/motion-lock.ts): global and per-head lock levels, and where each locked head was frozen. Absent: nothing locked. */
  motionLock: MotionLockSchema.optional(),
});
export type ShowSettings = z.infer<typeof ShowSettingsSchema>;
