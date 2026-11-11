/**
 * A list of modes to pick from by name (T6): a fixture's DMX modes (its menu) and a channel's working modes
 * with their variants indented under them (the fixture panel; decision T6, question 1: one list, no
 * submenu). A search field when the list is long, buttons the same on a mouse, a finger or a keyboard
 * (no native <select>: no search, no readable indent, uncertain on touch — as the function picker of
 * T12), the current one marked by a sign and a word (`aria-current`), the values on the right. Each row
 * keeps room on its left for a thumbnail (T19).
 */
import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { useT } from "../App";
import { searchBy } from "../search-text";

export interface ModeItem {
  key: string;
  label: string;
  /** Shown on the right: the DMX values, a channel count. */
  detail?: string;
  /** A variant: indented under its mode, whose key it names (kept in a search that finds the variant). */
  parent?: string;
  current?: boolean;
}

/** Lists longer than this get a search field. */
export const SEARCH_FROM = 8;

/**
 * `heading` false: the title only names the section (a fieldset's legend already says it); the list inside is not
 * named again. `focusOnOpen`: the search, else the current row, else the first, takes the focus when it appears
 * (a list opened from a button).
 */
export function ModePicker({ title, items, onPick, disabled, heading = true, focusOnOpen = false }: { title: string; items: readonly ModeItem[]; onPick: (item: ModeItem) => void; disabled?: boolean; heading?: boolean; focusOnOpen?: boolean }): ReactElement {
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
  const found = new Set(searchBy(items, query, (i) => [i.label, i.detail ?? ""]).map((i) => i.key));
  // a variant found keeps its mode in view above it, a mode found keeps its variants
  const shown = items.filter((i) => found.has(i.key) || (i.parent === undefined && items.some((v) => v.parent === i.key && found.has(v.key))) || (i.parent !== undefined && found.has(i.parent)));
  const picks = shown.filter((i) => found.has(i.key));
  return (
    <section ref={box} className="mode-picker" aria-labelledby={heading ? `${id}-title` : undefined} aria-label={heading ? undefined : title}>
      {heading && <h4 id={`${id}-title`}>{title}</h4>}
      {items.length > SEARCH_FROM && (
        <input
          type="search"
          aria-label={t.fixtureMode.search}
          placeholder={t.fixtureMode.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter takes the only mode left by the search
            if (e.key === "Enter" && query.trim() && picks.length === 1) {
              e.preventDefault();
              onPick(picks[0]!);
            }
          }}
        />
      )}
      <ul className="mode-list">
        {shown.map((i) => (
          <li key={i.key} className={i.parent !== undefined ? "variant" : undefined}>
            <button type="button" className={i.current ? "chosen" : undefined} aria-current={i.current ? "true" : undefined} disabled={disabled} onClick={() => onPick(i)}>
              <span className="thumb" aria-hidden />
              <span className="name">
                {i.current && <span aria-hidden>● </span>}
                {i.label}
                {i.current && <small className="now"> · {t.fixtureMode.current}</small>}
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
