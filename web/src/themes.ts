/**
 * Themes (moods) of the colour knowledge base for the « create a look by intention » picker (T14,
 * docs/specs/presets-songs-notes.md « Base de connaissances couleur »). A chosen theme is a plain
 * string: the knowledge key when it is a known one (what `look.from_intent` and the `ambiance:` tag
 * use), the typed word otherwise (a free theme, reported back as unknown by the server).
 */
import { fold, searchBy, searchPhrase } from "./search-text.js";

export interface Theme {
  key: string;
  label: string;
  colors: string[];
  family: string;
}

export interface KnowledgeMoods {
  moods: Record<string, { label?: string; colors: string[]; family?: string }>;
}

/** The known themes, by label (accent-insensitive order). */
export function themesOf(kb: KnowledgeMoods | null | undefined): Theme[] {
  return Object.entries(kb?.moods ?? {})
    .map(([key, m]) => ({ key, label: m.label ?? key, colors: m.colors, family: m.family ?? "" }))
    .sort((a, b) => fold(a.label).localeCompare(fold(b.label)));
}

/** The themes a search keeps: by label or key, without case or accents. */
export const searchThemes = (list: readonly Theme[], query: string): Theme[] => searchBy(list, query, (t) => [t.label, t.key]);

/** The known theme a chosen value stands for (its key, or its label typed), if any. */
export const themeOf = (list: readonly Theme[], value: string): Theme | undefined => {
  const f = fold(value).trim();
  return list.find((t) => t.key === f) ?? list.find((t) => fold(t.label) === f);
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

/** Whether the « add this word » button shows: something typed, no known theme matches it, not chosen yet. */
export const canAddFree = (list: readonly Theme[], chosen: readonly string[], query: string): boolean =>
  searchPhrase(query) !== "" && searchThemes(list, query).length === 0 && !chosen.some((c) => same(list, c, query));
