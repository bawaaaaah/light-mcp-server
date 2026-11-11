/**
 * Intentions made by the user (T15, docs/specs/presets-songs-notes.md « Base de connaissances
 * couleur »): moods of the colour knowledge base created, touched up or hidden from the interface.
 * They live in two places, chosen when one is created:
 *   - the show (collection `intentions` of the show folder): travels with its .lightshow archives
 *     and backups;
 *   - the personal library (data/private/intentions): shared by every show of this machine. A
 *     show's archive carries a copy of the personal (and private file) intentions it uses, as
 *     intentions of the show (`embeddedIntentions`).
 * Precedence, id by id, the most specific wins: shipped (generic.json) < private file
 * (data/private/knowledge.json) < personal library < show. A show entry whose id exists below
 * is a touch-up of it for this show; a hidden one masks it for this show.
 *
 * Ids (T15b, decision of 2026-11-12): a new intention gets a generated id (`i-<base36>`,
 * `newIntentionId`); those made before keep their key (normalizeMood of their label) as id, and the
 * private file's are its keywords' keys. The label is free to change; `aliases` keep former labels.
 * Songs (`mood`) and looks (`ambiance:` tags) name an intention by id, or by name for words typed
 * before or elsewhere: `resolveIntention` reads both, the id first; several intentions may share a
 * label, a name then going to the most specific layer (show > personal > private file > shipped).
 * Pure: the commands pass the layers.
 */
import { z } from "zod";
import { ID_RE } from "../data/store.js";
import { EnergySchema, flattenLayers, normalizeMood, type Knowledge, type KnowledgeLayers, type Mood } from "./knowledge.js";

export const MAX_INTENTION_COLORS = 6;
export const MAX_LABEL = 80;
export const MAX_FAMILY = 40;
export const MAX_NOTES = 2000;
/** Former labels kept by an intention renamed (T15b): a word typed before still finds it. */
export const MAX_ALIASES = 20;
const HexSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "#rrggbb")
  .transform((c) => c.toLowerCase());

export const IntentionSchema = z.object({
  /**
   * What `song.mood` and the `ambiance:` tags name, never changed once created: generated for a new one
   * (`i-<base36>`, T15b), the key of its label (normalizeMood) for one made before.
   */
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
  /** Former labels (T15b): a song or a look naming it by one of them still finds it. */
  aliases: z.array(z.string().max(MAX_LABEL)).max(MAX_ALIASES).optional(),
  /** Masks the intention of the same id below it (shipped or personal), for this show only. */
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

const moodOf = (i: Intention): Mood => ({ label: i.label || i.id, colors: i.colors, energy: i.energy, family: i.family, ...(i.notes ? { notes: i.notes } : {}), ...(i.aliases?.length ? { aliases: i.aliases } : {}) });

/**
 * A new intention's id (T15b): `i-` then the time and four random characters in base 36, as the
 * proposals' ids are made. A valid collection id and its own key (normalizeMood leaves it as it is).
 * The time and the randomness are injectable.
 */
export function newIntentionId(now: number, random: () => number = Math.random): string {
  const tail = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `i-${Math.max(0, Math.floor(now)).toString(36)}-${tail}`;
}

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
 * file intentions it uses (`used`: ids its songs and looks name, `refKey`), copied as intentions of the
 * show, so that they come back as such on a restore — elsewhere too. The show's own and the shipped
 * ones are left alone (the first are in the folder, the second ship everywhere); an entry the
 * schema refuses (a hand-edited colour that is not #rrggbb, a label too long) is left out and named
 * in `refused`, with why (show.lint says it will not travel).
 */
export function embeddedIntentions(stack: ReadonlyMap<string, IntentionEntry>, used: Iterable<string>): { intentions: Intention[]; refused: { id: string; label: string; why: string }[] } {
  const intentions: Intention[] = [];
  const refused: { id: string; label: string; why: string }[] = [];
  for (const key of new Set(used)) {
    const e = stack.get(key);
    if (!e || e.hidden || (e.origin !== "personal" && e.origin !== "private")) continue;
    const parsed = IntentionSchema.safeParse({ id: key, label: e.label ?? key, colors: e.colors, energy: e.energy, family: e.family, ...(e.notes ? { notes: e.notes } : {}), ...(e.aliases?.length ? { aliases: e.aliases } : {}) });
    if (parsed.success) intentions.push(parsed.data);
    else refused.push({ id: key, label: e.label ?? key, why: parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") });
  }
  return { intentions: intentions.sort((a, b) => a.id.localeCompare(b.id)), refused };
}

/** The tag prefix by which a look names an intention. */
export const AMBIANCE = "ambiance:";

/** The layers in the order a name looks them up (T15b): the most specific first. */
const LAYER_RANK: Record<IntentionOrigin, number> = { show: 0, personal: 1, private: 2, generic: 3 };

/** What a reference names (T15b): the intention, how it was found, and every one that answered. */
export interface ResolvedIntention {
  entry: IntentionEntry;
  /** `id`: the reference is its id (or its key, typed with case, accents, spaces); `label` or `alias`: by a name. */
  by: "id" | "label" | "alias";
  /** Every intention the name fits, best first (one for an id): more than one is an ambiguous name. */
  candidates: IntentionEntry[];
}

/** The names an intention answers to (T15b), as keys: its label, then its former labels. */
export const namesOf = (e: Pick<IntentionEntry, "id" | "label" | "aliases">): { label: string; aliases: string[] } => ({
  label: normalizeMood(e.label || e.id),
  aliases: (e.aliases ?? []).map(normalizeMood).filter(Boolean),
});

/**
 * The one way a word of a song's mood or a look's `ambiance:` tag finds its intention (T15b):
 * first as an id (the word itself, or its key: « Joie » is `joie`, what songs wrote before ids were
 * generated); else by name, the labels before the former labels (aliases), the visible before the
 * masked, then by layer, the most specific first (show > personal library > private file > shipped:
 * decision of 2026-11-12, several intentions may share a label), then by id for a stable answer.
 * Undefined for a word nothing answers to (a free word stays a word).
 */
export function resolveIntention(stack: ReadonlyMap<string, IntentionEntry>, ref: string): ResolvedIntention | undefined {
  const key = normalizeMood(ref);
  if (!key) return undefined;
  const byId = stack.get(ref) ?? stack.get(key);
  if (byId) return { entry: byId, by: "id", candidates: [byId] };
  const labels: IntentionEntry[] = [];
  const aliases: IntentionEntry[] = [];
  for (const e of stack.values()) {
    const names = namesOf(e);
    if (names.label === key) labels.push(e);
    else if (names.aliases.includes(key)) aliases.push(e);
  }
  const best = (a: IntentionEntry, b: IntentionEntry) => Number(a.hidden) - Number(b.hidden) || LAYER_RANK[a.origin] - LAYER_RANK[b.origin] || a.id.localeCompare(b.id);
  const candidates = [...labels.sort(best), ...aliases.sort(best)];
  return candidates.length ? { entry: candidates[0]!, by: labels.length ? "label" : "alias", candidates } : undefined;
}

/** A word as the id it names (T15b), or its key when nothing answers: what every use is counted by. */
export const refKey =
  (stack: ReadonlyMap<string, IntentionEntry>) =>
  (word: string): string =>
    resolveIntention(stack, word)?.entry.id ?? normalizeMood(word);

/**
 * The id a word written by name should become (T15b, migration): only a name that one visible
 * intention, and one only, answers to (by label or former label). An id, an ambiguous name, a masked
 * one or a free word stay as they are (show.lint says the ambiguous ones).
 */
export function migratedRef(stack: ReadonlyMap<string, IntentionEntry>, word: string): string | undefined {
  const r = resolveIntention(stack, word);
  if (!r || r.by === "id") return undefined;
  const visible = r.candidates.filter((e) => !e.hidden);
  return visible.length === 1 && r.candidates.length === 1 ? visible[0]!.id : undefined;
}

/** A song's mood with its names turned into ids where that is unambiguous (`changed` when one was). */
export function migrateMood(stack: ReadonlyMap<string, IntentionEntry>, mood: readonly string[]): { mood: string[]; changed: boolean } {
  let changed = false;
  const out = mood.map((w) => {
    const id = migratedRef(stack, w);
    if (id === undefined) return w;
    changed = true;
    return id;
  });
  return { mood: out, changed };
}

/** A look's tags with the names of its `ambiance:` tags turned into ids where that is unambiguous. */
export function migrateTags(stack: ReadonlyMap<string, IntentionEntry>, tags: readonly string[]): { tags: string[]; changed: boolean } {
  let changed = false;
  const out = tags.map((t) => {
    if (!t.startsWith(AMBIANCE)) return t;
    const id = migratedRef(stack, t.slice(AMBIANCE.length));
    if (id === undefined) return t;
    changed = true;
    return `${AMBIANCE}${id}`;
  });
  return { tags: out, changed };
}

/** What a word is shown as (T15b): the label of the intention it names, the word itself otherwise. */
export const labelOfRef = (stack: ReadonlyMap<string, IntentionEntry>, word: string): string => {
  const e = resolveIntention(stack, word)?.entry;
  return e ? e.label || e.id : word;
};

/**
 * The labels several visible intentions share (T15b): allowed (decision of 2026-11-12), said by
 * show.lint because a word naming that label goes to only one of them. By key of the label.
 */
export function duplicateLabels(stack: ReadonlyMap<string, IntentionEntry>): { key: string; entries: IntentionEntry[] }[] {
  const by = new Map<string, IntentionEntry[]>();
  for (const e of stack.values()) {
    if (e.hidden) continue;
    const key = namesOf(e).label;
    if (key) by.set(key, [...(by.get(key) ?? []), e]);
  }
  return [...by]
    .filter(([, list]) => list.length > 1)
    .map(([key, entries]) => ({ key, entries: entries.sort((a, b) => LAYER_RANK[a.origin] - LAYER_RANK[b.origin] || a.id.localeCompare(b.id)) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
