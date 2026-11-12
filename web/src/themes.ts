/**
 * Themes (moods) of the colour knowledge base for the « create a look by intention » picker (T14,
 * docs/specs/presets-songs-notes.md « Base de connaissances couleur »). A chosen theme is a plain
 * string: the intention's id when it is a known one (what `look.from_intent`, a song's mood and the
 * `ambiance:` tag store, T15b), the typed word otherwise (a free theme, reported back as unknown by
 * the server). Shown by its label everywhere.
 */
import { fold, searchBy, searchPhrase } from "./search-text.js";
import { GENERATED_ID, intentionKey, STRICT, ORIGIN_RANK, type IntentionOrigin, type KnowledgeIntentions } from "./intentions.js";

export interface Theme {
  /** The intention's id. */
  key: string;
  label: string;
  colors: string[];
  family: string;
  /** Where it comes from (T15): a show or personal intention is marked in the list. */
  origin?: IntentionOrigin;
  /** Former labels (T15b): typing one still finds it. */
  aliases?: string[];
  /** Another theme has the same label (T15b): the list says where each comes from. */
  duplicate?: boolean;
}

export type KnowledgeMoods = KnowledgeIntentions;

/** The known themes, by label (accent-insensitive order), the most specific first for a shared label. */
export function themesOf(kb: KnowledgeMoods | null | undefined): Theme[] {
  const list: Theme[] = Object.entries(kb?.moods ?? {}).map(([key, m]) => ({ key, label: m.label || key, colors: m.colors, family: m.family ?? "", ...(m.origin ? { origin: m.origin } : {}), ...(m.aliases?.length ? { aliases: m.aliases } : {}) }));
  const count = new Map<string, number>();
  for (const t of list) count.set(intentionKey(t.label), (count.get(intentionKey(t.label)) ?? 0) + 1);
  return list.map((t) => ((count.get(intentionKey(t.label)) ?? 0) > 1 ? { ...t, duplicate: true } : t)).sort((a, b) => fold(a.label).localeCompare(fold(b.label)) || rank(a) - rank(b) || a.key.localeCompare(b.key));
}

const rank = (t: Theme): number => ORIGIN_RANK[t.origin ?? "generic"];

/** The themes a search keeps: by label, former label or key, without case or accents. */
export const searchThemes = (list: readonly Theme[], query: string): Theme[] => searchBy(list, query, (t) => [t.label, t.key, ...(t.aliases ?? [])]);

/**
 * The known theme a chosen value stands for, as the server reads it (T15b, `resolveIntention`): its id
 * (or a key typed with spaces, « lever de rideau »), else its label, else a former label, the most
 * specific first when several share it (show > personal > private file > shipped).
 */
export const themeOf = (list: readonly Theme[], value: string): Theme | undefined => {
  // the strict form (`=id`): that one, even when a nearer one bears its label
  if (value.startsWith(STRICT)) return list.find((t) => t.key === value.slice(STRICT.length));
  const key = intentionKey(value);
  if (!key) return undefined;
  const exact = list.find((t) => t.key === value);
  if (exact && GENERATED_ID.test(value)) return exact;
  const byKey = exact ?? list.find((t) => t.key === key);
  const labels = list.filter((t) => t !== byKey && intentionKey(t.label) === key);
  // a key-id names its own unless a nearer intention bears that label (decision of 2026-11-12)
  if (byKey && !labels.some((t) => rank(t) < rank(byKey))) return byKey;
  const best = (a: Theme, b: Theme) => rank(a) - rank(b) || a.key.localeCompare(b.key);
  return [...labels, ...(byKey ? [byKey] : [])].sort(best)[0] ?? [...list].filter((t) => (t.aliases ?? []).some((a) => intentionKey(a) === key)).sort(best)[0];
};

/** What a chosen value is shown as: the label of a known theme, the word itself otherwise. */
export const themeLabel = (list: readonly Theme[], value: string): string => themeOf(list, value)?.label ?? value;

const same = (list: readonly Theme[], a: string, b: string) => (themeOf(list, a)?.key ?? fold(a).trim()) === (themeOf(list, b)?.key ?? fold(b).trim());

/** Picks a value, or unpicks it when already chosen (a known theme typed by label is the same as its key). */
/** What a chosen theme is stored as (T15b): its id, or its strict form when the plain id would read as a nearer one of its label. */
export const themeRef = (list: readonly Theme[], theme: Theme): string => (themeOf(list, theme.key) === theme ? theme.key : `${STRICT}${theme.key}`);

export function toggleTheme(list: readonly Theme[], chosen: readonly string[], value: string): string[] {
  const word = value.trim();
  if (!word) return [...chosen];
  const theme = themeOf(list, word);
  const key = theme ? themeRef(list, theme) : word;
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
  // a label several bear: nothing picked for the user, the list shows them with where each comes from
  if (exact?.duplicate && intentionKey(exact.label) === intentionKey(query)) return undefined;
  if (exact) return exact.key;
  const phrase = searchPhrase(query);
  const starts = phrase ? list.filter((t) => fold(t.label).startsWith(phrase) || fold(t.key).startsWith(phrase)) : [];
  return starts.length === 1 ? starts[0]!.key : undefined;
}
