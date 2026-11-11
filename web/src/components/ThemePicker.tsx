/**
 * Picks one or several themes (T14, docs/specs/presets-songs-notes.md « Base de connaissances
 * couleur »): a search field, the known themes as `aria-pressed` buttons (the same on a mouse, a
 * finger or a keyboard) with their colour swatches and family, the chosen ones as removable chips,
 * and « add "<text>" » for a word no known theme matches (a free theme, still accepted). The list
 * is a prop, so it may change later (custom intentions, T15).
 */
import { useId, useRef, useState, type ReactElement } from "react";
import { useT } from "../App";
import { quoted } from "../typography";
import { addTheme, canAddFree, enterPick, searchThemes, themeLabel, themeOf, toggleTheme, type Theme } from "../themes";

export function ThemePicker({ themes, chosen, onChange }: { themes: readonly Theme[]; chosen: readonly string[]; onChange: (chosen: string[]) => void }): ReactElement {
  const t = useT();
  const id = useId();
  const [query, setQuery] = useState("");
  const shown = searchThemes(themes, query);
  const search = useRef<HTMLInputElement>(null);
  const free = canAddFree(themes, chosen, query);
  const isOn = (theme: Theme) => chosen.some((c) => themeOf(themes, c)?.key === theme.key);
  const addFree = () => {
    onChange(addTheme(themes, chosen, query));
    setQuery("");
  };

  const removeChip = (c: string) => {
    onChange(toggleTheme(themes, chosen, c));
    search.current?.focus(); // the chip is gone: keep the keyboard where it can go on
  };

  return (
    <section className="theme-picker" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>{t.themes}</h4>
      <p className="hint">{t.themeHelp}</p>
      <ul className="theme-chips" aria-label={t.themeChosen}>
        {chosen.length === 0 && <li className="hint">{t.themeNone}</li>}
        {chosen.map((c) => (
          <li key={c} className={themeOf(themes, c) ? "chip" : "chip free"}>
            <span>{themeLabel(themes, c)}</span>
            <button type="button" aria-label={t.themeRemove.replace("{name}", themeLabel(themes, c))} onClick={() => removeChip(c)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <p className="sr-only" role="status">
        {t.themeChosen}{t.colon} {chosen.length ? chosen.map((c) => themeLabel(themes, c)).join(", ") : t.themeNone}
      </p>
      <input
        ref={search}
        type="search"
        aria-label={t.themeSearch}
        placeholder={t.themeSearch}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          // Enter only ever adds (removing a theme is the chip's ×): the theme typed, the one the text
          // starts, else the free word
          const pick = enterPick(themes, query);
          if (pick) {
            onChange(addTheme(themes, chosen, pick));
            setQuery("");
          } else if (free) addFree();
        }}
      />
      <ul className="theme-list" aria-label={t.themeList}>
        {shown.map((theme) => {
          const on = isOn(theme);
          return (
            <li key={theme.key}>
              <button type="button" className={on ? "chosen" : ""} aria-pressed={on} onClick={() => onChange(toggleTheme(themes, chosen, theme.key))}>
                <span className="theme-name">{theme.label}</span>
                <span className="theme-swatches" aria-hidden="true">
                  {theme.colors.map((c, k) => (
                    <i key={k} style={{ background: c }} />
                  ))}
                </span>
                {theme.family && <small className="theme-family">{theme.family}</small>}
                {/* the user's own (T15): where it lives, the shipped ones go unmarked */}
                {theme.origin && theme.origin !== "generic" && <small className={`theme-origin origin-${theme.origin}`}>{t.intentionOrigins[theme.origin]}</small>}
              </button>
            </li>
          );
        })}
      </ul>
      {free && (
        <button type="button" className="theme-add" onClick={addFree}>
          {t.themeAdd.replace("{text}", quoted(t, query.trim()))}
        </button>
      )}
      {shown.length === 0 && !free && query.trim() !== "" && <p className="hint">{t.noMatch}</p>}
    </section>
  );
}
