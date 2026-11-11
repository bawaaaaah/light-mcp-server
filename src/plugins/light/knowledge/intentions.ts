/**
 * Intentions made by the user (T15, docs/specs/presets-songs-notes.md « Base de connaissances
 * couleur »): moods of the colour knowledge base created, touched up or hidden from the interface.
 * They live in two places, chosen when one is created:
 *   - the show (collection `intentions` of the show folder): travels with its .lightshow archives
 *     and backups;
 *   - the personal library (data/private/intentions): shared by every show of this machine. A
 *     show's archive carries a copy of the personal (and private file) intentions it uses, as
 *     intentions of the show (`embeddedIntentions`).
 * Precedence, key by key, the most specific wins: shipped (generic.json) < private file
 * (data/private/knowledge.json) < personal library < show. A show entry whose key exists below
 * is a touch-up of it for this show; a hidden one masks it for this show.
 * Pure: the commands pass the layers.
 */
import { z } from "zod";
import { ID_RE } from "../data/store.js";
import { EnergySchema, flattenLayers, normalizeMood, type Knowledge, type KnowledgeLayers, type Mood } from "./knowledge.js";

export const MAX_INTENTION_COLORS = 6;
export const MAX_LABEL = 80;
export const MAX_FAMILY = 40;
export const MAX_NOTES = 2000;
const HexSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "#rrggbb")
  .transform((c) => c.toLowerCase());

export const IntentionSchema = z.object({
  /** The key (normalizeMood), what `song.mood` and the `ambiance:` tags name: never changes once created. */
  id: z
    .string()
    .regex(ID_RE)
    .refine((id) => normalizeMood(id) === id, { message: "not an intention key (normalizeMood)" }),
  /** As people read it, accents included; free to change. */
  label: z.string().max(MAX_LABEL).default(""),
  /** 1 to 6 colours, the first one leading. */
  colors: z.array(HexSchema).min(1).max(MAX_INTENTION_COLORS),
  energy: EnergySchema.default("dynamique"),
  family: z.string().max(MAX_FAMILY).default(""),
  notes: z.string().max(MAX_NOTES).optional(),
  /** Masks the intention of the same key below it (shipped or personal), for this show only. */
  hidden: z.boolean().optional(),
});
export type Intention = z.infer<typeof IntentionSchema>;

/** Where an intention comes from. `private`: the hand-edited data/private/knowledge.json (read only here). */
export type IntentionOrigin = "generic" | "private" | "personal" | "show";

export interface IntentionEntry extends Mood {
  id: string;
  origin: IntentionOrigin;
  /** For a show or personal entry: the one below it that it replaces (or masks). */
  over?: Exclude<IntentionOrigin, "show">;
  hidden: boolean;
}

const moodOf = (i: Intention): Mood => ({ label: i.label || i.id, colors: i.colors, energy: i.energy, family: i.family, ...(i.notes ? { notes: i.notes } : {}) });

/**
 * Every intention by key, after the layers are stacked: the visible ones and the hidden ones (to be
 * shown back), each with where it comes from and what it replaces. A key that came down to nothing
 * (no letter nor digit) is left out: no word could name it.
 */
export function stackIntentions(layers: KnowledgeLayers, personal: readonly Intention[], show: readonly Intention[]): Map<string, IntentionEntry> {
  const entries = new Map<string, IntentionEntry>();
  const lay = (origin: IntentionOrigin, key: string, mood: Mood, hidden = false) => {
    if (!key) return;
    const below = entries.get(key)?.origin;
    entries.set(key, { ...mood, id: key, origin, hidden, ...(below && below !== "show" ? { over: below } : {}) });
  };
  for (const [k, m] of Object.entries(layers.generic.moods)) lay("generic", normalizeMood(k), m);
  for (const [k, m] of Object.entries(layers.private?.moods ?? {})) lay("private", normalizeMood(k), m);
  for (const i of personal) if (!i.hidden) lay("personal", normalizeMood(i.id), moodOf(i));
  for (const i of show) {
    const key = normalizeMood(i.id);
    // a mask without anything to mask means nothing
    if (i.hidden && !entries.has(key)) continue;
    lay("show", key, moodOf(i), Boolean(i.hidden));
  }
  return entries;
}

/** The knowledge base the proposals read: the visible intentions only. */
export function mergeKnowledge(layers: KnowledgeLayers, personal: readonly Intention[], show: readonly Intention[]): Knowledge {
  const moods: Record<string, Mood> = {};
  for (const e of stackIntentions(layers, personal, show).values()) {
    if (e.hidden) continue;
    const { id: _id, origin: _o, over: _v, hidden: _h, ...mood } = e;
    moods[e.id] = mood;
  }
  return { ...flattenLayers(layers), moods };
}

/** Whether a word (a `song.mood` entry, an `ambiance:` tag) names this key; the empty key is named by nothing. */
export const namesIntention = (word: string, key: string): boolean => key !== "" && normalizeMood(word) === key;

/**
 * What a show's archive adds to its folder (T15, decision of 2026-11-11): the personal and private
 * file intentions it uses (`used`: keys named by its songs and looks), copied as intentions of the
 * show, so that they come back as such on a restore — elsewhere too. The show's own and the shipped
 * ones are left alone (the first are in the folder, the second ship everywhere); an entry the
 * schema refuses (a hand-edited colour that is not #rrggbb) is left out.
 */
export function embeddedIntentions(stack: ReadonlyMap<string, IntentionEntry>, used: Iterable<string>): Intention[] {
  const out: Intention[] = [];
  for (const key of new Set(used)) {
    const e = stack.get(key);
    if (!e || e.hidden || (e.origin !== "personal" && e.origin !== "private")) continue;
    const parsed = IntentionSchema.safeParse({ id: key, label: e.label ?? key, colors: e.colors, energy: e.energy, family: e.family, ...(e.notes ? { notes: e.notes } : {}) });
    if (parsed.success) out.push(parsed.data);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
