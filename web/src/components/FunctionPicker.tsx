/**
 * Picks the named function a channel fader is narrowed to (T12, docs/specs/groups-masters.md,
 * « Fader de canaux »): a search field over the ticked channels' functions, a list of buttons (the
 * same on a mouse, a finger or a keyboard), and « the whole travel » to undo it. Picking sets the
 * fader's range; what is picked stays named even when another function shares its range, and the
 * channels the range does not fit are named (the fader has one range for all its channels).
 */
import { useId, useState, type ReactElement } from "react";
import { useT } from "../App";
import { functionsOf, searchFunctions, type FaderFunction } from "../fader-functions";

export interface Range {
  min: number;
  max: number;
}

export function FunctionPicker({ functions, range, unfitted, onPick }: { functions: readonly FaderFunction[]; range: Range; unfitted: readonly string[]; onPick: (range: Range) => void }): ReactElement {
  const t = useT();
  const id = useId();
  const [query, setQuery] = useState("");
  /** The function picked here, by its key: shown as long as the range is still its own (two functions may share one), whatever prefix its label gains. */
  const [picked, setPicked] = useState<string | null>(null);
  const whole = range.min <= 0 && range.max >= 255;
  const covering = functionsOf(functions, range);
  const chosen = covering.find((f) => f.key === picked) ?? covering[0];
  const shown = searchFunctions(functions, query);
  const status = whole ? t.faderFunctionWhole : chosen ? `${chosen.label} — ${t.faderFunctionTravel}` : t.faderFunctionCustom;

  const pick = (f: FaderFunction | null) => {
    setPicked(f?.key ?? null);
    setQuery("");
    onPick(f ? { min: f.min, max: f.max } : { min: 0, max: 255 });
  };

  return (
    <section className="function-picker" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>{t.faderFunction}</h4>
      {functions.length === 0 ? (
        <p className="hint">{t.faderFunctionNone}</p>
      ) : (
        <>
          <p className="hint">{t.faderFunctionHelp}</p>
          <p className="status" role="status" aria-live="polite">
            {status}
          </p>
          <input
            type="search"
            aria-label={t.faderFunctionSearch}
            placeholder={t.faderFunctionSearch}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter takes the only function left by the search
              if (e.key === "Enter" && query.trim() && shown.length === 1) {
                e.preventDefault();
                pick(shown[0]!);
              }
            }}
          />
          <ul className="function-list" aria-label={t.faderFunction}>
            <li>
              <button type="button" className={whole ? "chosen" : ""} aria-pressed={whole} onClick={() => pick(null)}>
                {t.faderFunctionWholeButton}
              </button>
            </li>
            {shown.map((f) => {
              const on = !whole && chosen?.key === f.key;
              return (
                <li key={f.key}>
                  <button type="button" className={on ? "chosen" : ""} aria-pressed={on} onClick={() => pick(f)}>
                    {f.label}
                  </button>
                </li>
              );
            })}
          </ul>
          {shown.length === 0 && <p className="hint">{t.noMatch}</p>}
        </>
      )}
      {unfitted.length > 0 && (
        <p className="warn" role="alert">
          {t.faderFunctionUnfitted.replace("{range}", `${range.min}–${range.max}`)} {unfitted.join(", ")}
        </p>
      )}
    </section>
  );
}
