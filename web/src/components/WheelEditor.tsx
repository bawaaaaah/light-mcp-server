import { useCallback, useEffect, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";

/** One slot of the wheel, as venue.wheel.get gives it (the definition's colours). */
interface Slot {
  min: number;
  max: number;
  value: number;
  name: string;
  color: string;
  color2?: string;
  open?: boolean;
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
}
interface WheelInfo {
  slots: Slot[];
  model: WheelSettings | null;
  own: WheelSettings | null;
  applies: "definition" | "model" | "fixture";
}
type Scope = "model" | "fixture";

/**
 * An entry of the fixture menu, shown only for a lamp with a colour wheel: it opens the editor of the
 * wheel's colour → slot correspondence (venue.wheel.get / put / clear, docs/specs/venue-fixtures-stage.md,
 * « Roue de couleurs »), for the whole model or this fixture only. Every change is saved at once.
 */
export function WheelEntry({ fixtureId }: { fixtureId: string }): ReactElement | null {
  const t = useT();
  const [info, setInfo] = useState<WheelInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>("model");
  const [error, setError] = useState("");
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
  if (!info) return null;
  // what this scope holds now; a fixture without its own settings starts from its model's
  const current: WheelSettings = (scope === "fixture" ? (info.own ?? info.model) : info.model) ?? {};
  const save = (next: WheelSettings) => {
    setError("");
    void cmd("venue.wheel.put", { id: fixtureId, scope, wheel: next }).then(() => load(), (e: Error) => setError(e.message));
  };
  const clear = () => {
    setError("");
    void cmd("venue.wheel.clear", { id: fixtureId, scope }).then(() => load(), (e: Error) => setError(e.message));
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
  return (
    <div className="wheel-entry">
      <button className="ghost" aria-expanded={open} title={t.wheelEditHelp} onClick={() => setOpen(!open)}>
        {t.wheelEdit}
      </button>
      {open && (
        <div className="wheel-editor" role="group" aria-label={t.wheelEdit}>
          <div className="swatches" role="radiogroup" aria-label={t.wheelScopeHelp} title={t.wheelScopeHelp}>
            {(["model", "fixture"] as const).map((s) => (
              <button key={s} className={`ghost${scope === s ? " on" : ""}`} role="radio" aria-checked={scope === s} onClick={() => setScope(s)}>
                {s === "model" ? t.wheelScopeModel : t.wheelScopeFixture}
              </button>
            ))}
          </div>
          <small className="hint">
            {t.wheelApplies}
            {t.wheelAppliesNames[info.applies]}
          </small>
          <ul className="wheel-slots">
            {info.slots.map((s) => {
              const own = slotOf(s);
              const real = own.color ?? s.color;
              return (
                <li key={s.min} className={own.off ? "off" : ""}>
                  <span className="wheel-slot-swatch" style={{ background: s.color2 ? `linear-gradient(90deg, ${real} 50%, ${s.color2} 50%)` : real }} />
                  <span className="wheel-slot-name" title={`${s.min}–${s.max}`}>
                    {s.name}
                    {s.open ? ` (${t.wheelOpen})` : ""} <small>{s.value}</small>
                  </span>
                  <span className="swatches">
                    {!s.color2 && <input type="color" aria-label={`${t.wheelSlotColor} · ${s.name}`} title={t.wheelSlotColor} value={real} onChange={(e) => setSlot(s, { color: e.target.value === s.color ? undefined : e.target.value })} />}
                    {(own.answers ?? []).map((hex) => (
                      <button key={hex} className="swatch" style={{ background: hex }} title={`${t.wheelAnswers} ${hex} · ${t.wheelRemoveAnswer}`} aria-label={`${t.wheelRemoveAnswer} ${hex} · ${s.name}`} onClick={() => setSlot(s, { answers: (own.answers ?? []).filter((x) => x !== hex) })} />
                    ))}
                    {!s.color2 && (
                      <label className="wheel-add" title={t.wheelAddAnswer}>
                        +
                        <input type="color" aria-label={`${t.wheelAddAnswer} · ${s.name}`} value={real} onChange={(e) => setSlot(s, { answers: [...new Set([...(own.answers ?? []), e.target.value.toLowerCase()])] })} />
                      </label>
                    )}
                    <button className={`ghost${own.off ? " on" : ""}`} aria-pressed={Boolean(own.off)} aria-label={`${t.wheelSlotOff} · ${s.name}`} title={t.wheelSlotOff} onClick={() => setSlot(s, { off: !own.off })}>
                      {own.off ? "⊘" : "○"}
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
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
          <button className="ghost" disabled={scope === "fixture" ? !info.own : !info.model} onClick={clear}>
            {t.wheelReset}
          </button>
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </div>
  );
}
