/**
 * The pure part of the shared list with a search (`components/SearchPicker.tsx`): which rows a search keeps, which
 * of them can be picked, and where the arrow keys go. Tested without a browser (test/web-search-picker.test.ts).
 */
import { searchBy } from "./search-text.js";

export interface SearchItem {
  key: string;
  label: string;
  /** Shown on the right: DMX values, a channel count, « engagée ». Searched too. */
  detail?: string;
  /** A variant: indented under the item whose key it names (kept in view when the variant is found). */
  parent?: string;
  current?: boolean;
  /** A colour swatch on the left (a named position's, a target's): `#rrggbb`. */
  color?: string;
  /** A short warning after the label (« à revoir »): said, never the only sign (it is text). */
  badge?: string;
  /** More words the item is found by (its tags, a former name). */
  keywords?: readonly string[];
  /** Shown but not pickable (a position that covers none of the heads): the arrow keys pass over it. */
  disabled?: boolean;
}

/** Lists longer than this get a search field. */
export const SEARCH_FROM = 8;

/**
 * The rows a search shows, in the list's order, and those of them it found (the ones Enter can take): a variant found
 * keeps its parent in view above it, a parent found keeps its variants.
 */
export function pickerRows<T extends SearchItem>(items: readonly T[], query: string): { shown: T[]; picks: T[] } {
  const found = new Set(searchBy(items, query, (i) => [i.label, i.detail ?? "", i.badge ?? "", ...(i.keywords ?? [])]).map((i) => i.key));
  const shown = items.filter((i) => found.has(i.key) || (i.parent === undefined && items.some((v) => v.parent === i.key && found.has(v.key))) || (i.parent !== undefined && found.has(i.parent)));
  return { shown, picks: shown.filter((i) => found.has(i.key)) };
}

/**
 * Where a key moves the focus in a list of `count` rows, from row `at` (-1: the search field), passing over the rows
 * `disabled` says cannot take it. Down from the field goes to the first row that can, Up from the first one back to the
 * field; Home and End go to the first and last that can; other keys, or no row that can: undefined.
 */
export function rowAfterKey(key: string, at: number, count: number, disabled: (row: number) => boolean = () => false): number | undefined {
  const rows = Array.from({ length: count }, (_, k) => k).filter((k) => !disabled(k));
  if (!rows.length) return undefined;
  switch (key) {
    case "ArrowDown":
      return rows.find((k) => k > at) ?? (at < 0 ? undefined : at);
    case "ArrowUp":
      return [...rows].reverse().find((k) => k < at) ?? -1;
    case "Home":
      return at < 0 ? undefined : rows[0];
    case "End":
      return at < 0 ? undefined : rows[rows.length - 1];
    default:
      return undefined;
  }
}
