/**
 * Intentions managed from the Show page (T15, docs/specs/presets-songs-notes.md « Base de
 * connaissances couleur »): the list `knowledge.get` gives (visible and masked ones, with their
 * origin and what uses them), the draft of the editor and its checks, and what each row offers.
 * Pure: the component calls the commands.
 */
import { searchBy } from "./search-text.js";

export type IntentionOrigin = "generic" | "private" | "personal" | "show";
export type Energy = "pose" | "dynamique" | "survolte";
export type Scope = "show" | "personal";
export const MAX_COLORS = 6;
export const ENERGIES: readonly Energy[] = ["pose", "dynamique", "survolte"];

/** One mood as `knowledge.get` sends it (an older server sends neither origin nor usedBy). */
export interface KnowledgeMood {
  label?: string;
  colors: string[];
  energy?: Energy;
  family?: string;
  notes?: string;
  /** Former labels (T15b): a word naming one of them still finds it. */
  aliases?: string[];
  origin?: IntentionOrigin;
  over?: IntentionOrigin;
  usedBy?: string[];
}
export interface KnowledgeIntentions {
  moods: Record<string, KnowledgeMood>;
  hidden?: (KnowledgeMood & { id: string })[];
}

export interface IntentionRow {
  key: string;
  label: string;
  colors: string[];
  energy: Energy;
  family: string;
  notes: string;
  origin: IntentionOrigin;
  /** What a show or personal intention replaces (a touch-up), or what a mask hides. */
  over?: IntentionOrigin;
  hidden: boolean;
  usedBy: string[];
  aliases: string[];
}

/**
 * The key of a label, exactly as the server makes it (`normalizeMood`, knowledge.ts): ligatures spelt
 * out, no accents nor case, every run of separators one « - ». « Lever de rideau » →
 * « lever-de-rideau », « Cœur » → « coeur »; a label without letters nor digits has the empty key.
 */
export const intentionKey = (label: string): string =>
  label
    .replace(/œ/gi, "oe")
    .replace(/æ/gi, "ae")
    .replace(/ß/g, "ss")
    .replace(/ø/gi, "o")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const rowOf = (key: string, m: KnowledgeMood, hidden: boolean): IntentionRow => ({
  key,
  label: m.label || key,
  colors: m.colors,
  energy: m.energy ?? "dynamique",
  family: m.family ?? "",
  notes: m.notes ?? "",
  origin: m.origin ?? "generic",
  ...(m.over ? { over: m.over } : {}),
  hidden,
  usedBy: m.usedBy ?? [],
  aliases: m.aliases ?? [],
});

const byLabel = (a: IntentionRow, b: IntentionRow) => a.label.localeCompare(b.label, "fr", { sensitivity: "base" });

/** The personal library as `intention.library` sends it: its rows, `usedBy` holding the shows that name each. */
export function libraryRows(entries: readonly (KnowledgeMood & { id: string; shows?: string[] })[]): IntentionRow[] {
  return entries.map((e) => ({ ...rowOf(e.id, { ...e, origin: "personal" }, false), usedBy: e.shows ?? [] })).sort(byLabel);
}

/** Every intention, the show's masks included (to be shown back), by label. */
export function intentionsOf(kb: KnowledgeIntentions | null | undefined): IntentionRow[] {
  if (!kb) return [];
  return [...Object.entries(kb.moods).map(([k, m]) => rowOf(k, m, false)), ...(kb.hidden ?? []).map((m) => rowOf(m.id, m, true))].sort(byLabel);
}

/** Search by label, key, family or origin word, without case or accents. */
export const searchIntentions = (list: readonly IntentionRow[], query: string, originWord: (o: IntentionOrigin) => string): IntentionRow[] =>
  searchBy(list, query, (r) => [r.label, r.key, r.family, originWord(r.origin)]);

/** The families in use, for the editor's suggestions. */
export const familiesOf = (list: readonly IntentionRow[]): string[] => [...new Set(list.map((r) => r.family).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));

/** « #ABC », « abc », « #AABBCC » → « #aabbcc »; anything else undefined. */
export function normalizeHex(text: string): string | undefined {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!m) return undefined;
  const h = m[1]!.toLowerCase();
  return `#${h.length === 3 ? [...h].map((c) => c + c).join("") : h}`;
}

export interface IntentionDraft {
  /** Set when editing (the id never follows the label); absent for a new one, whose id the server generates (T15b). */
  id?: string;
  label: string;
  colors: string[];
  energy: Energy;
  family: string;
  notes: string;
  scope: Scope;
}

export const newDraft = (scope: Scope = "show"): IntentionDraft => ({ label: "", colors: ["#ffb000"], energy: "pose", family: "", notes: "", scope });

/** A row opened in the editor: its own place for a show or personal one, the show for a touch-up of a shipped or private one. */
export const draftOf = (row: IntentionRow): IntentionDraft => ({
  id: row.key,
  label: row.label,
  colors: [...row.colors],
  energy: row.energy,
  family: row.family,
  notes: row.notes,
  scope: row.origin === "personal" ? "personal" : "show",
});

export const MAX_LABEL = 80;

export type DraftProblem = "label" | "long" | "colors";

/**
 * What stops a draft from being saved: a label without a letter or a digit, one too long, colours.
 * Its place is never « taken » (T15b): a new intention gets a new id, a label may be shared.
 */
export function draftProblems(d: IntentionDraft): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (!intentionKey(d.label)) problems.push("label");
  else if (d.label.length > MAX_LABEL) problems.push("long");
  if (d.colors.length < 1 || d.colors.length > MAX_COLORS || d.colors.some((c) => !normalizeHex(c))) problems.push("colors");
  return problems;
}

/**
 * The other intentions the show sees that have the draft's label (T15b): allowed, said before it is
 * saved (a word naming that label goes to only one of them).
 */
export const duplicatesOf = (d: IntentionDraft, list: readonly IntentionRow[]): IntentionRow[] => {
  const key = intentionKey(d.label);
  return key ? list.filter((r) => !r.hidden && r.key !== d.id && intentionKey(r.label) === key) : [];
};

/**
 * What a draft replaces (T15b): only an existing intention written to another place under its own id
 * (a touch-up for the show of a shipped, private or personal one, or one added to the library over a
 * shipped or private one), said with the origin it replaces. A new intention replaces nothing.
 */
export function replacedBy(d: IntentionDraft, list: readonly IntentionRow[]): IntentionRow | undefined {
  if (d.id === undefined) return undefined;
  const row = list.find((r) => r.key === d.id && !r.hidden);
  if (!row) return undefined;
  const below = row.origin === d.scope ? row.over : row.origin;
  if (!below || below === "show" || (d.scope === "personal" && below === "personal")) return undefined;
  return { ...row, origin: below };
}

/** Fills the « {name} » marks of a text. */
export const fill = (text: string, values: Record<string, string | number>): string => text.replace(/\{(\w+)\}/g, (m, k: string) => String(values[k] ?? m));

/** One or several of something, as the language says it (`{n}` in the text). */
export const plural = (n: number, one: string, many: string): string => fill(n === 1 ? one : many, { n });

export interface PutArgs {
  scope: Scope;
  intention: { id?: string; label: string; colors: string[]; energy: Energy; family: string; notes?: string };
}

/** The arguments of `intention.put` for a draft. */
export const putArgs = (d: IntentionDraft): PutArgs => ({
  scope: d.scope,
  intention: { ...(d.id !== undefined ? { id: d.id } : {}), label: d.label.trim(), colors: d.colors.map((c) => normalizeHex(c) ?? c), energy: d.energy, family: d.family.trim(), ...(d.notes.trim() ? { notes: d.notes.trim() } : {}) },
});

/** Moves a colour one place (`by` −1 up, +1 down); the first one leads. */
export function moveColor<T>(colors: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (to < 0 || to >= colors.length) return [...colors];
  const next = [...colors];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

export const removeColor = <T>(colors: readonly T[], index: number): T[] => (colors.length <= 1 ? [...colors] : colors.filter((_, k) => k !== index));

/** A new colour after the others (white, or the last one again would be invisible): up to six. */
export const addColor = (colors: readonly string[]): string[] => (colors.length >= MAX_COLORS ? [...colors] : [...colors, colors.includes("#ffffff") ? "#000000" : "#ffffff"]);

export type RowAction = "edit" | "touchUp" | "copyToShow" | "toLibrary" | "revert" | "delete" | "hide" | "restore";

/**
 * What a row offers. A show or personal intention is edited in its place; a shipped or private one
 * is touched up for the show (the shipped base is not the user's to change). A personal or private
 * one can be copied into the show, so that it travels with its archives. Removing a touch-up gives
 * the one below back (revert), removing a shipped or private one masks it for the show (hide), a
 * mask is taken back (restore). One of the show can go to the personal library (toLibrary), for every
 * show of the machine. In the library section (`library`), a row is the library's own: edited or deleted.
 */
export function actionsOf(row: IntentionRow, library = false): RowAction[] {
  if (library) return ["edit", row.over ? "revert" : "delete"];
  if (row.hidden) return ["restore"];
  if (row.origin === "show") return ["edit", "toLibrary", row.over ? "revert" : "delete"];
  if (row.origin === "personal") return ["edit", "copyToShow", row.over ? "revert" : "delete"];
  if (row.origin === "private") return ["touchUp", "copyToShow", "hide"];
  return ["touchUp", "hide"];
}

/** The layers in the order a name looks them up (T15b): the most specific first. */
export const ORIGIN_RANK: Record<IntentionOrigin, number> = { show: 0, personal: 1, private: 2, generic: 3 };

/** What a word names here (T15b), as the server reads it (`resolveIntention`). */
export interface ResolvedWord {
  id: string;
  label: string;
  /** Where it comes from; a masked one says what it masks. */
  origin: IntentionOrigin;
  hidden: boolean;
  by: "id" | "label" | "alias";
  /** How many intentions answer to it (more than one: an ambiguous name). */
  candidates: number;
}

/**
 * The intention a word (a song's mood, a look's `ambiance:` tag) names, exactly as the server finds it
 * (knowledge/intentions.ts `resolveIntention`): its id (or its key, typed with case and accents), else
 * a label before a former label, the visible before the masked, the show > personal > private file >
 * shipped. Undefined for a word nothing answers to (a free word).
 */
export function resolveWord(kb: KnowledgeIntentions | null | undefined, word: string): ResolvedWord | undefined {
  if (!kb) return undefined;
  const key = intentionKey(word);
  if (!key) return undefined;
  type Entry = { id: string; m: KnowledgeMood; hidden: boolean };
  const all: Entry[] = [...Object.entries(kb.moods).map(([id, m]) => ({ id, m, hidden: false })), ...(kb.hidden ?? []).map((h) => ({ id: h.id, m: h, hidden: true }))];
  const out = (e: Entry, by: ResolvedWord["by"], candidates: number): ResolvedWord => ({ id: e.id, label: e.m.label || e.id, origin: (e.hidden ? e.m.over : e.m.origin) ?? "generic", hidden: e.hidden, by, candidates });
  const byId = all.find((e) => e.id === word) ?? all.find((e) => e.id === key);
  if (byId) return out(byId, "id", 1);
  const origin = (e: Entry): IntentionOrigin => e.m.origin ?? "generic";
  const best = (a: Entry, b: Entry) => Number(a.hidden) - Number(b.hidden) || ORIGIN_RANK[origin(a)] - ORIGIN_RANK[origin(b)] || a.id.localeCompare(b.id);
  const labels = all.filter((e) => intentionKey(e.m.label || e.id) === key).sort(best);
  const aliases = all.filter((e) => intentionKey(e.m.label || e.id) !== key && (e.m.aliases ?? []).some((a) => intentionKey(a) === key)).sort(best);
  const first = labels[0] ?? aliases[0];
  return first ? out(first, labels.length ? "label" : "alias", labels.length + aliases.length) : undefined;
}

/** What a word is shown as (T15b): the label of the intention it names, the word itself otherwise. */
export const wordLabel = (kb: KnowledgeIntentions | null | undefined, word: string): string => resolveWord(kb, word)?.label ?? word;

const AMBIANCE = "ambiance:";

/** A look's tags as people read them (T15b): an `ambiance:` tag by its intention's label. */
export const tagsShown = (kb: KnowledgeIntentions | null | undefined, tags: readonly string[]): string[] => tags.map((t) => (t.startsWith(AMBIANCE) ? `${AMBIANCE}${wordLabel(kb, t.slice(AMBIANCE.length))}` : t));

/**
 * Tags typed in the look editor back as they are stored (T15b): an `ambiance:` tag shown by its label
 * (`tagsShown`) gets back the id it had, so that a label shared with another intention never moves
 * the link; a new one is sent as typed (the server stores it by id when one intention only answers).
 */
export function tagsTyped(kb: KnowledgeIntentions | null | undefined, typed: readonly string[], before: readonly string[]): string[] {
  const back = new Map<string, string>();
  for (const t of before) if (t.startsWith(AMBIANCE)) back.set(intentionKey(wordLabel(kb, t.slice(AMBIANCE.length))), t);
  return typed.map((t) => (t.startsWith(AMBIANCE) ? (back.get(intentionKey(t.slice(AMBIANCE.length))) ?? t) : t));
}

/** What each word (a song's mood, a look's `ambiance:` tag) names here: its label and where it comes from, or unknown. */
export function originsOf(kb: KnowledgeIntentions, words: readonly string[]): { word: string; label: string; origin: IntentionOrigin | "unknown"; hidden: boolean }[] {
  return [...new Set(words)].map((word) => {
    const r = resolveWord(kb, word);
    return r ? { word, label: r.label, origin: r.origin, hidden: r.hidden } : { word, label: word, origin: "unknown", hidden: false };
  });
}
