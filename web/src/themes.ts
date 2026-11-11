/**
 * Themes (moods) of the colour knowledge base for the « create a look by intention » picker (T14,
 * docs/specs/presets-songs-notes.md « Base de connaissances couleur »). A chosen theme is a plain
 * string: the knowledge key when it is a known one (what `look.from_intent` and the `ambiance:` tag
 * use), the typed word otherwise (a free theme, reported back as unknown by the server).
 */
import { fold, searchBy, searchPhrase } from "./search-text.js";
import { intentionKey, type IntentionOrigin, type KnowledgeIntentions } from "./intentions.js";

export interface Theme {
  key: string;
  label: string;
  colors: string[];
  family: string;
  /** Where it comes from (T15): a show or personal intention is marked in the list. */
  origin?: IntentionOrigin;
}

export type KnowledgeMoods = KnowledgeIntentions;

/** The known themes, by label (accent-insensitive order). */
export function themesOf(kb: KnowledgeMoods | null | undefined): Theme[] {
  return Object.entries(kb?.moods ?? {})
    .map(([key, m]) => ({ key, label: m.label ?? key, colors: m.colors, family: m.family ?? "", ...(m.origin ? { origin: m.origin } : {}) }))
    .sort((a, b) => fold(a.label).localeCompare(fold(b.label)));
}

/** The themes a search keeps: by label or key, without case or accents. */
export const searchThemes = (list: readonly Theme[], query: string): Theme[] => searchBy(list, query, (t) => [t.label, t.key]);

/** The known theme a chosen value stands for (its key, or its label typed), if any. */
export const themeOf = (list: readonly Theme[], value: string): Theme | undefined => {
  const f = fold(value).trim();
  // a key with spaces or punctuation typed (« lever de rideau ») is the key the server would read
  const key = intentionKey(value);
  return list.find((t) => t.key === f) ?? list.find((t) => fold(t.label) === f) ?? (key ? list.find((t) => t.key === key) : undefined);
};

/** What a chosen value is shown as: the label of a known theme, the word itself otherwise. */
export const themeLabel = (list: readonly Theme[], value: string): string => themeOf(list, value)?.label ?? value;

const same = (list: readonly Theme[], a: string, b: string) => (themeOf(list, a)?.key ?? fold(a).trim()) === (themeOf(list, b)?.key ?? fold(b).trim());

/** Picks a value, or unpicks it when already chosen (a known theme typed by label is the same as its key). */
export function toggleTheme(list: readonly Theme[], chosen: readonly string[], value: string): string[] {
  const word = value.trim();
  if (!word) return [...chosen];
  const key = themeOf(list, word)?.key ?? word;
  return chosen.some((c) => same(list, c, key)) ? chosen.filter((c) => !same(list, c, key)) : [...chosen, key];
}

/** Adds a free word (never removes: typing a chosen one again is a no-op). */
export const addTheme = (list: readonly Theme[], chosen: readonly string[], value: string): string[] =>
  !value.trim() || chosen.some((c) => same(list, c, value)) ? [...chosen] : toggleTheme(list, chosen, value);

/**
 * Whether the « add this word » button shows: something typed, no known theme is exactly it (a word
 * contained in a known theme, « ange » in « Louange », is still a possible free word), not chosen yet.
 */
export const canAddFree = (list: readonly Theme[], chosen: readonly string[], query: string): boolean =>
  searchPhrase(query) !== "" && !themeOf(list, query) && !chosen.some((c) => same(list, c, query));

/**
 * What Enter in the search field adds: the theme typed exactly, else the only theme whose label or key
 * *starts* with the text (« inti » → Intimité), else nothing (the caller then adds the free word).
 * A word merely contained in a label (« ange » in « Louange ») is never picked for the user.
 */
export function enterPick(list: readonly Theme[], query: string): string | undefined {
  const exact = themeOf(list, query);
  if (exact) return exact.key;
  const phrase = searchPhrase(query);
  const starts = phrase ? list.filter((t) => fold(t.label).startsWith(phrase) || fold(t.key).startsWith(phrase)) : [];
  return starts.length === 1 ? starts[0]!.key : undefined;
}
