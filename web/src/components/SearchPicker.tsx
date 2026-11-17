/**
 * The shared list to pick from by name, with a search (T6 for the modes, generalised by T32 for the named positions):
 * a fixture's DMX modes (its menu), a channel's working modes with their variants indented under them, a look's target,
 * a named position. A search field when the list is long, folded without case or accents (search-text.ts); buttons the
 * same on a mouse, a finger or a keyboard (no native <select>: no search, no readable indent, uncertain on touch — as the
 * function picker of T12); the arrow keys go from the search to the rows and between them, Enter in the search takes the
 * only row left, Escape empties the search. The current row is marked by a sign and a word (`aria-current`), a colour
 * swatch and a short badge (« à revoir ») when given, the detail on the right. Each row keeps room on its left for a
 * thumbnail (T19). The filtering and the keys are pure (search-picker.ts).
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useT } from "../i18n-context";
import { pickerRows, rowAfterKey, SEARCH_FROM, type SearchItem } from "../search-picker";

export interface SearchPickerProps<T extends SearchItem> {
  title: string;
  items: readonly T[];
  onPick: (item: T) => void;
  disabled?: boolean;
  /** false: the title only names the section (a fieldset's legend already says it); the list inside is not named again. */
  heading?: boolean;
  /** The search, else the current row, else the first, takes the focus when it appears (a list opened from a button). */
  focusOnOpen?: boolean;
  /** The word after the current row (« en cours » by default: a mode; « choisie » for a look's target). */
  currentLabel?: string;
  /** The search field's label and placeholder (« Rechercher » by default). */
  searchLabel?: string;
  /** From how many rows a search field is shown (SEARCH_FROM by default; 0: always). */
  searchFrom?: number;
}

export function SearchPicker<T extends SearchItem>({ title, items, onPick, disabled, heading = true, focusOnOpen = false, currentLabel, searchLabel, searchFrom = SEARCH_FROM }: SearchPickerProps<T>): ReactElement {
  const t = useT();
  const id = useId();
  const [query, setQuery] = useState("");
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusOnOpen) return;
    const el = box.current?.querySelector<HTMLElement>('input[type="search"], button[aria-current="true"], button');
    el?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when it opens
  }, []);
  const { shown, picks } = pickerRows(items, query);
  const searching = items.length > searchFrom;
  const label = searchLabel ?? t.search;
  /** The arrows from the search to the rows and between them, Home and End within the rows. */
  const move = (e: KeyboardEvent<HTMLElement>, at: number) => {
    const rows = [...(box.current?.querySelectorAll<HTMLButtonElement>(".search-list button") ?? [])];
    const next = rowAfterKey(e.key, at, rows.length, (k) => rows[k]?.disabled === true);
    if (next === undefined || (next < 0 && !searching)) return;
    e.preventDefault();
    if (next < 0) box.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    else rows[next]?.focus();
  };
  return (
    <section ref={box} className="search-picker" aria-labelledby={heading ? `${id}-title` : undefined} aria-label={heading ? undefined : title}>
      {heading && <h4 id={`${id}-title`}>{title}</h4>}
      {searching && (
        <input
          type="search"
          aria-label={label}
          placeholder={label}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter takes the only row left by the search
            if (e.key === "Enter" && query.trim() && picks.length === 1 && !disabled && !picks[0]!.disabled) {
              e.preventDefault();
              onPick(picks[0]!);
            } else if (e.key === "Escape" && query) {
              e.preventDefault();
              e.stopPropagation(); // a dialog around it stays open: the first Escape only empties the search
              setQuery("");
            } else if (e.key === "ArrowDown") move(e, -1);
          }}
        />
      )}
      <ul className="search-list">
        {shown.map((i, k) => (
          <li key={i.key} className={i.parent !== undefined ? "variant" : undefined}>
            <button type="button" className={i.current ? "chosen" : undefined} aria-current={i.current ? "true" : undefined} disabled={disabled || i.disabled} onClick={() => onPick(i)} onKeyDown={(e) => move(e, k)}>
              <span className="thumb" aria-hidden>
                {i.color && <span className="swatch" style={{ background: i.color }} />}
              </span>
              <span className="name">
                {/* a row with a colour already has its dot: the word alone marks it current */}
                {i.current && !i.color && <span aria-hidden>● </span>}
                {i.label}
                {i.current && <small className="now"> · {currentLabel ?? t.fixtureMode.current}</small>}
                {i.badge && <small className="badge"> · {i.badge}</small>}
              </span>
              {i.detail && <small className="detail">{i.detail}</small>}
            </button>
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p className="hint">{t.noMatch}</p>}
    </section>
  );
}
