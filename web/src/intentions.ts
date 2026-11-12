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
  /** Former labels kept (T15b), set once one is removed in the editor; absent, the server keeps them (and adds the one a rename leaves). */
  aliases?: string[];
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
  intention: { id?: string; label: string; colors: string[]; energy: Energy; family: string; notes?: string; aliases?: string[] };
}

/** The arguments of `intention.put` for a draft. */
export const putArgs = (d: IntentionDraft, before?: IntentionDraft): PutArgs => {
  // former labels edited (one removed): sent whole, with the label a rename leaves (the server then takes them as given)
  const renamed = before && intentionKey(before.label) !== intentionKey(d.label) ? [before.label] : [];
  const aliases = d.aliases === undefined ? undefined : [...d.aliases, ...renamed];
  return {
    scope: d.scope,
    intention: { ...(d.id !== undefined ? { id: d.id } : {}), label: d.label.trim(), colors: d.colors.map((c) => normalizeHex(c) ?? c), energy: d.energy, family: d.family.trim(), ...(d.notes.trim() ? { notes: d.notes.trim() } : {}), ...(aliases ? { aliases } : {}) },
  };
};

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

/** One intention a word may name, as people read it. */
export interface WordCandidate {
  id: string;
  label: string;
  /** Where it comes from; a masked one says what it masks. */
  origin: IntentionOrigin;
  hidden: boolean;
}

/** What a word names here (T15b), as the server reads it (`resolveIntention`). */
export interface ResolvedWord extends WordCandidate {
  by: "id" | "label" | "alias";
  /** How many intentions answer to it (more than one: an ambiguous name). */
  candidates: number;
  /** Those intentions, best first (the chosen one first). */
  others: WordCandidate[];
}

/** A generated id (the server's `newIntentionId`): typed as such, it names that intention whatever its label. */
export const GENERATED_ID = /^i-[a-z0-9]+-[a-z0-9]{4}$/;

/**
 * The strict form of an id (the server's `STRICT`, T15b): `=` then the id, always that intention. A
 * key-id's plain word reads by name (a nearer intention of its label takes it): choosing the farther
 * one writes this form.
 */
export const STRICT = "=";

/** How a song or a look names an intention for sure: its id, or its strict form when the plain id would read as another one. */
export const refFor = (kb: KnowledgeIntentions | null | undefined, id: string): string => (resolveWord(kb, id)?.id === id ? id : `${STRICT}${id}`);

type Entry = { id: string; m: KnowledgeMood; hidden: boolean; rank: number; label: string; aliases: string[] };
/** The intentions of a reply, read once (the keys of their names computed once per reply). */
const indexes = new WeakMap<KnowledgeIntentions, { all: Entry[]; byId: Map<string, Entry> }>();
const indexOf = (kb: KnowledgeIntentions) => {
  let x = indexes.get(kb);
  if (!x) {
    const entry = (id: string, m: KnowledgeMood, hidden: boolean): Entry => ({ id, m, hidden, rank: ORIGIN_RANK[m.origin ?? "generic"], label: intentionKey(m.label || id), aliases: (m.aliases ?? []).map(intentionKey).filter(Boolean) });
    const all = [...Object.entries(kb.moods).map(([id, m]) => entry(id, m, false)), ...(kb.hidden ?? []).map((h) => entry(h.id, h, true))];
    x = { all, byId: new Map(all.map((e) => [e.id, e])) };
    indexes.set(kb, x);
  }
  return x;
};

/**
 * The intention a word (a song's mood, a look's `ambiance:` tag) names, exactly as the server finds it
 * (knowledge/intentions.ts `resolveIntention`): a generated id typed as such names its own; a key-id
 * (the word or its key: shipped, private file, or made before ids were generated) only while no visible
 * intention of a nearer layer bears that label, and, masked, only while no visible one answers; else by
 * name: the visible before the masked, the nearest layer (show > personal > private file > shipped),
 * a label before a former label. Undefined for a word nothing answers to (a free word).
 */
export function resolveWord(kb: KnowledgeIntentions | null | undefined, word: string): ResolvedWord | undefined {
  if (!kb) return undefined;
  const key = intentionKey(word);
  if (!key) return undefined;
  const { all, byId } = indexOf(kb);
  const brief = (e: Entry): WordCandidate => ({ id: e.id, label: e.m.label || e.id, origin: (e.hidden ? e.m.over : e.m.origin) ?? "generic", hidden: e.hidden });
  // the strict form: that id or nothing
  if (word.startsWith(STRICT)) {
    const strict = byId.get(word.slice(STRICT.length));
    return strict ? { ...brief(strict), by: "id", candidates: 1, others: [brief(strict)] } : undefined;
  }
  const exact = byId.get(word);
  if (exact && GENERATED_ID.test(word)) return { ...brief(exact), by: "id", candidates: 1, others: [brief(exact)] };
  const byKey = exact ?? byId.get(key);
  const labels = all.filter((e) => e !== byKey && e.label === key);
  const aliases = all.filter((e) => e !== byKey && e.label !== key && e.aliases.includes(key));
  if (byKey) {
    const nearer = byKey.hidden ? [...labels, ...aliases].some((e) => !e.hidden) : labels.some((e) => !e.hidden && e.rank < byKey.rank);
    if (!nearer) return { ...brief(byKey), by: "id", candidates: 1, others: [brief(byKey)] };
    labels.push(byKey);
  }
  const best = (a: Entry, b: Entry) => Number(a.hidden) - Number(b.hidden) || a.rank - b.rank || a.id.localeCompare(b.id);
  const ordered = [...labels.sort(best), ...aliases.sort(best)].sort((a, b) => Number(a.hidden) - Number(b.hidden));
  // a masked one competes with nothing visible
  const found = ordered.some((e) => !e.hidden) ? ordered.filter((e) => !e.hidden) : ordered;
  const first = found[0];
  return first ? { ...brief(first), by: labels.includes(first) ? "label" : "alias", candidates: found.length, others: found.map(brief) } : undefined;
}

/** The visible intentions that bear a label (T15b), the nearest first: more than one, the label is shared. */
export function bearersOf(kb: KnowledgeIntentions | null | undefined, label: string): WordCandidate[] {
  const key = intentionKey(label);
  if (!kb || !key) return [];
  return indexOf(kb)
    .all.filter((e) => !e.hidden && e.label === key)
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
    .map((e) => ({ id: e.id, label: e.m.label || e.id, origin: e.m.origin ?? "generic", hidden: false }));
}

/** What a word is shown as (T15b): the label of the intention it names, the word itself otherwise. */
export const wordLabel = (kb: KnowledgeIntentions | null | undefined, word: string): string => resolveWord(kb, word)?.label ?? word;

const AMBIANCE = "ambiance:";

/** A look's tags as people read them (T15b): an `ambiance:` tag by its intention's label. */
export const tagsShown = (kb: KnowledgeIntentions | null | undefined, tags: readonly string[]): string[] => tags.map((t) => (t.startsWith(AMBIANCE) ? `${AMBIANCE}${wordLabel(kb, t.slice(AMBIANCE.length))}` : t));

/**
 * Tags typed in the look editor back as they are stored (T15b): an `ambiance:` tag shown by its label
 * (`tagsShown`) gets back the id it had (two tags of one label keep theirs, in order); a new name is
 * pinned to the id of the intention it goes to (the nearest: the editor says when others bear it), so
 * that the link never moves later; a word nothing answers to is sent as typed.
 */
export function tagsTyped(kb: KnowledgeIntentions | null | undefined, typed: readonly string[], before: readonly string[]): string[] {
  const back = new Map<string, string[]>();
  for (const t of before) {
    if (!t.startsWith(AMBIANCE)) continue;
    const k = intentionKey(wordLabel(kb, t.slice(AMBIANCE.length)));
    back.set(k, [...(back.get(k) ?? []), t]);
  }
  return typed.map((t) => {
    if (!t.startsWith(AMBIANCE)) return t;
    const word = t.slice(AMBIANCE.length);
    const kept = back.get(intentionKey(word))?.shift();
    if (kept) return kept;
    const r = resolveWord(kb, word);
    return r && !r.hidden ? `${AMBIANCE}${refFor(kb, r.id)}` : t;
  });
}

/** Every name a look's tags answer to (T15b): an `ambiance:` tag by its intention's label and former labels, for a search. */
export function tagNames(kb: KnowledgeIntentions | null | undefined, tags: readonly string[]): string[] {
  return tags.flatMap((t) => {
    if (!t.startsWith(AMBIANCE)) return [];
    const r = resolveWord(kb, t.slice(AMBIANCE.length));
    const m = r ? (kb?.moods[r.id] ?? kb?.hidden?.find((h) => h.id === r.id)) : undefined;
    return r ? [r.label, ...(m?.aliases ?? [])] : [];
  });
}

/** What each word (a song's mood, a look's `ambiance:` tag) names here: its label and where it comes from, or unknown. */
export function originsOf(kb: KnowledgeIntentions, words: readonly string[]): { word: string; label: string; origin: IntentionOrigin | "unknown"; hidden: boolean }[] {
  return [...new Set(words)].map((word) => {
    const r = resolveWord(kb, word);
    return r ? { word, label: r.label, origin: r.origin, hidden: r.hidden } : { word, label: word, origin: "unknown", hidden: false };
  });
}
