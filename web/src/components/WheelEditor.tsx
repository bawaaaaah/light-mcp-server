import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";

/** One range of the wheel channel, as venue.wheel.get gives it (the definition's colours; `colorless`: it gives none). */
interface Slot {
  min: number;
  max: number;
  value: number;
  name: string;
  color?: string;
  color2?: string;
  open?: boolean;
  colorless?: boolean;
}
interface SlotSettings {
  color?: string;
  answers?: string[];
  off?: boolean;
}
interface WheelSettings {
  slots?: Record<string, SlotSettings>;
  doubles?: boolean;
  change?: "mid" | "black";
  changeMs?: number;
}
interface WheelInfo {
  slots: Slot[];
  model: WheelSettings | null;
  own: WheelSettings | null;
  applies: "definition" | "model" | "fixture";
  /** How long the wheel takes to turn, in force (ms). */
  changeMs: number;
}
type Scope = "model" | "fixture";

/**
 * A colour picker that saves once the colour is chosen: the browser fires `input` on every move of the picker
 * (React's onChange), `change` when it closes. The moves only feed a local draft; the native `change` commits.
 */
function ColorPick({ value, label, title, onPick }: { value: string; label: string; title?: string; onPick: (hex: string) => void }): ReactElement {
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const commit = () => pick.current(el.value.toLowerCase());
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, []);
  return <input ref={input} type="color" aria-label={label} title={title ?? label} value={draft} onChange={(e) => setDraft(e.target.value)} />;
}

/**
 * An entry of the fixture menu, shown only for a lamp with a colour wheel: it opens the editor of the
 * wheel's colour → slot correspondence (venue.wheel.get / put / clear, docs/specs/venue-fixtures-stage.md,
 * « Roue de couleurs »), for the whole model or this fixture only. Every change is saved at once.
 */
export function WheelEntry({ fixtureId, onSaved }: { fixtureId: string; onSaved: () => void }): ReactElement | null {
  const t = useT();
  const [info, setInfo] = useState<WheelInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>("model");
  const [error, setError] = useState("");
  const [clearing, setClearing] = useState(false);
  const [turn, setTurn] = useState("");
  const scopeButtons = useRef<Record<Scope, HTMLButtonElement | null>>({ model: null, fixture: null });
  const load = useCallback(
    (first = false) =>
      cmd<WheelInfo | null>("venue.wheel.get", { id: fixtureId }).then(
        (w) => {
          setInfo(w); // null: no wheel chosen by colour here, no entry
          if (w && first) setScope(w.applies === "fixture" ? "fixture" : "model");
        },
        () => setInfo(null),
      ),
    [fixtureId],
  );
  useEffect(() => {
    void load(true);
  }, [load]);
  // what this scope holds now; a fixture without its own settings starts from its model's
  const current: WheelSettings = (info && (scope === "fixture" ? (info.own ?? info.model) : info.model)) ?? {};
  const shownTurn = current.changeMs ?? info?.changeMs ?? 0;
  useEffect(() => setTurn(String(shownTurn)), [shownTurn]);
  if (!info) return null;
  const saved = () => load().then(onSaved);
  const save = (next: WheelSettings) => {
    setError("");
    void cmd("venue.wheel.put", { id: fixtureId, scope, wheel: next }).then(saved, (e: Error) => setError(e.message));
  };
  /** Asked inline, never in a window; the focus goes back to the scope in force once answered. */
  const endClearing = (confirmed: boolean) => {
    setClearing(false);
    scopeButtons.current[scope]?.focus();
    if (!confirmed) return;
    setError("");
    void cmd("venue.wheel.clear", { id: fixtureId, scope }).then(saved, (e: Error) => setError(e.message));
  };
  const slotOf = (s: Slot): SlotSettings => current.slots?.[String(s.min)] ?? {};
  const setSlot = (s: Slot, patch: SlotSettings) => {
    const merged = { ...slotOf(s), ...patch };
    const tidy = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined && v !== false && !(Array.isArray(v) && !v.length))) as SlotSettings;
    const slots = { ...current.slots };
    if (Object.keys(tidy).length) slots[String(s.min)] = tidy;
    else delete slots[String(s.min)];
    save({ ...current, slots });
  };
  const saveTurn = () => {
    const ms = Math.round(Number(turn));
    if (turn.trim() === "" || !Number.isFinite(ms) || ms === shownTurn) return setTurn(String(shownTurn));
    save({ ...current, changeMs: Math.max(0, Math.min(5000, ms)) });
  };
  const held = scope === "fixture" ? info.own : info.model;
  return (
    <div className="field wheel-entry">
      <button className="ghost" aria-expanded={open} title={t.wheelEditHelp} onClick={() => setOpen(!open)}>
        {t.wheelEdit}
      </button>
      {open && (
        <div className="wheel-editor" role="group" aria-label={t.wheelEdit}>
          <div className="swatches" role="radiogroup" aria-label={t.headsScope}>
            {(["model", "fixture"] as const).map((s) => (
              <button
                key={s}
                ref={(el) => void (scopeButtons.current[s] = el)}
                className={`ghost${scope === s ? " on" : ""}`}
                role="radio"
                aria-checked={scope === s}
                onClick={() => {
                  setScope(s);
                  setClearing(false);
                }}
              >
                {s === "model" ? t.headsScopeModel : t.headsScopeFixture}
              </button>
            ))}
          </div>
          <small className="hint">{t.wheelScopeHelp}</small>
          {scope === "fixture" && !info.own && <small className="hint">{t.wheelScopeCopies}</small>}
          <small className="hint">
            {t.wheelApplies}
            {t.wheelAppliesNames[info.applies]}
          </small>
          <div className="wheel-slots">
            <div className="wheel-head" aria-hidden="true">
              <span>{t.wheelColSlot}</span>
              <span>{t.wheelColReal}</span>
              <span>{t.wheelColAnswers}</span>
              <span>{t.wheelColOff}</span>
            </div>
            <ul>
              {info.slots.map((s) => {
                const own = slotOf(s);
                const real = own.color ?? s.color;
                return (
                  <li key={s.min} className={own.off ? "off" : ""}>
                    <span className="wheel-slot-name" title={`${s.min}–${s.max}`}>
                      <span className={`wheel-slot-swatch${real ? "" : " none"}`} style={real ? { background: s.color2 ? `linear-gradient(90deg, ${real} 50%, ${s.color2} 50%)` : real } : undefined} />
                      {s.name}
                      {s.open ? ` (${t.wheelOpen})` : ""} <small>{s.value}</small>
                    </span>
                    <span className="wheel-real">
                      {!s.color2 && <ColorPick label={`${t.wheelSlotColor} · ${s.name}`} title={t.wheelSlotColor} value={real ?? "#ffffff"} onPick={(hex) => setSlot(s, { color: hex === s.color ? undefined : hex })} />}
                      {own.color && (
                        <>
                          <small className="wheel-modified">{t.wheelModified}</small>
                          <button className="ghost" aria-label={`${t.wheelBackToDefinition} · ${s.name}`} title={t.wheelBackToDefinition} onClick={() => setSlot(s, { color: undefined })}>
                            ↺
                          </button>
                        </>
                      )}
                    </span>
                    <span className="swatches">
                      {(own.answers ?? []).map((hex) => (
                        <button key={hex} className="swatch" style={{ background: hex }} title={`${t.wheelAnswers} ${hex} · ${t.wheelRemoveAnswer}`} aria-label={`${t.wheelRemoveAnswer} ${hex} · ${s.name}`} onClick={() => setSlot(s, { answers: (own.answers ?? []).filter((x) => x !== hex) })} />
                      ))}
                      {!s.color2 && real && (own.answers ?? []).length < 16 && (
                        <label className="wheel-add" title={t.wheelAddAnswer}>
                          +
                          <ColorPick label={`${t.wheelAddAnswer} · ${s.name}`} value={real} onPick={(hex) => setSlot(s, { answers: [...new Set([...(own.answers ?? []), hex])] })} />
                        </label>
                      )}
                    </span>
                    <button className={`ghost wheel-off${own.off ? " on" : ""}`} disabled={!real} aria-pressed={Boolean(own.off)} aria-label={`${t.wheelSlotOff} · ${s.name}`} title={t.wheelSlotOff} onClick={() => setSlot(s, { off: !own.off })}>
                      {own.off ? "⊘" : "○"} {t.wheelColOff}
                    </button>
                    {!real && <small className="hint wheel-colorless">{t.wheelColorless}</small>}
                  </li>
                );
              })}
            </ul>
          </div>
          {info.slots.some((s) => s.color2) && (
            <div className="invert-row">
              <span>{t.wheelDoubles}</span>
              <button className={`ghost${current.doubles !== false ? " on" : ""}`} aria-pressed={current.doubles !== false} aria-label={t.wheelDoubles} onClick={() => save({ ...current, doubles: current.doubles === false })}>
                {current.doubles !== false ? "◉" : "○"}
              </button>
            </div>
          )}
          <label className="field">
            <span>{t.wheelChange}</span>
            <select value={current.change ?? "mid"} onChange={(e) => save({ ...current, change: e.target.value as "mid" | "black" })}>
              <option value="mid">{t.wheelChangeMid}</option>
              <option value="black">{t.wheelChangeBlack}</option>
            </select>
          </label>
          {current.change === "black" && (
            <label className="field">
              <span>{t.wheelChangeMs}</span>
              <input type="number" min={0} max={5000} step={50} value={turn} onChange={(e) => setTurn(e.target.value)} onBlur={saveTurn} onKeyDown={(e) => e.key === "Enter" && saveTurn()} />
              <small className="hint">{t.wheelChangeMsHelp}</small>
            </label>
          )}
          {held &&
            (clearing ? (
              <div className="row wheel-confirm" role="group" aria-label={t.wheelReset}>
                <span>{scope === "model" ? t.wheelResetAskModel : t.wheelResetAskFixture}</span>
                <button className="danger" autoFocus onClick={() => endClearing(true)}>
                  {t.wheelResetConfirm}
                </button>
                <button className="ghost" onClick={() => endClearing(false)}>
                  {t.cancel}
                </button>
              </div>
            ) : (
              <button className="ghost" onClick={() => setClearing(true)}>
                {t.wheelReset}
              </button>
            ))}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
