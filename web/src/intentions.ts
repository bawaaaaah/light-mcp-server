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
});

const byLabel = (a: IntentionRow, b: IntentionRow) => a.label.localeCompare(b.label, "fr", { sensitivity: "base" });

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
  /** Set when editing (the key never follows the label); absent for a new one. */
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

/** A key is an id: 64 characters at most (the server refuses longer). */
export const MAX_KEY = 64;
export const MAX_LABEL = 80;

export type DraftProblem = "label" | "long" | "taken" | "colors";

/**
 * What stops a draft from being saved. `taken`: whether that place already has a visible intention
 * of this key (a creation only: an edit writes its own key).
 */
export function draftProblems(d: IntentionDraft, taken: (key: string, scope: Scope) => boolean): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const key = d.id ?? intentionKey(d.label);
  if (!key) problems.push("label");
  else if (key.length > MAX_KEY || d.label.length > MAX_LABEL) problems.push("long");
  else if (d.id === undefined && taken(key, d.scope)) problems.push("taken");
  if (d.colors.length < 1 || d.colors.length > MAX_COLORS || d.colors.some((c) => !normalizeHex(c))) problems.push("colors");
  return problems;
}

/** Whether a place already holds a visible intention of that key (the list knows the top one only: the show's wins). */
export const takenIn =
  (list: readonly IntentionRow[]): ((key: string, scope: Scope) => boolean) =>
  (key: string, scope: Scope): boolean =>
    list.some((r) => r.key === key && !r.hidden && (scope === "show" ? r.origin === "show" : r.origin === "personal" || r.over === "personal"));

/**
 * What a new intention would replace (its key being one of the shipped base or the private file):
 * said before it is saved. Undefined for an edit or a new key.
 */
export function replacedBy(d: IntentionDraft, list: readonly IntentionRow[]): IntentionRow | undefined {
  if (d.id !== undefined) return undefined;
  const key = intentionKey(d.label);
  return key ? list.find((r) => r.key === key && (r.origin === "generic" || r.origin === "private" || (r.hidden && r.over !== undefined))) : undefined;
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

export type RowAction = "edit" | "touchUp" | "copyToShow" | "revert" | "delete" | "hide" | "restore";

/**
 * What a row offers. A show or personal intention is edited in its place; a shipped or private one
 * is touched up for the show (the shipped base is not the user's to change). A personal or private
 * one can be copied into the show, so that it travels with its archives. Removing a touch-up gives
 * the one below back (revert), removing a shipped or private one masks it for the show (hide), a
 * mask is taken back (restore).
 */
export function actionsOf(row: IntentionRow): RowAction[] {
  if (row.hidden) return ["restore"];
  if (row.origin === "show") return ["edit", row.over ? "revert" : "delete"];
  if (row.origin === "personal") return ["edit", "copyToShow", row.over ? "revert" : "delete"];
  if (row.origin === "private") return ["touchUp", "copyToShow", "hide"];
  return ["touchUp", "hide"];
}
