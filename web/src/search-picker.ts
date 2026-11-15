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
 * Where a key moves the focus in a list of `count` rows, from row `at` (-1: the search field). Down from the field goes
 * to the first row, Up from the first row back to the field; Home and End go to the ends; other keys: undefined.
 */
export function rowAfterKey(key: string, at: number, count: number): number | undefined {
  if (count === 0) return undefined;
  switch (key) {
    case "ArrowDown":
      return Math.min(at + 1, count - 1);
    case "ArrowUp":
      return Math.max(at - 1, -1);
    case "Home":
      return at < 0 ? undefined : 0;
    case "End":
      return at < 0 ? undefined : count - 1;
    default:
      return undefined;
  }
}
