import { useImperativeHandle, useRef, type KeyboardEvent, type ReactElement, type ReactNode, type Ref } from "react";
import { useT } from "../App";

/** What a caller can do with the group: put the focus back on the checked choice (a button gone, a question answered). */
export interface SegmentedRadioHandle {
  focus: () => void;
}

/**
 * A row of buttons choosing one value (T47: « modèle / appareil » of the heads, the wheel, the tracks, the travel), a
 * radio group to the keyboard: one tab stop on the checked choice, the arrows move to the next or previous one (round
 * the end), Home and End to the first and the last, the focus following the choice.
 */
export function SegmentedRadio<V extends string | number>({
  label,
  options,
  value,
  onChange,
  handle,
}: {
  label: string;
  options: readonly { value: V; label: ReactNode }[];
  /** None checked yet: no tab stop either. */
  value: V | null;
  onChange: (value: V) => void;
  handle?: Ref<SegmentedRadioHandle>;
}): ReactElement {
  const buttons = useRef(new Map<V, HTMLButtonElement>());
  useImperativeHandle(handle, () => ({ focus: () => (value === null ? undefined : buttons.current.get(value)?.focus()) }), [value]);
  const move = (e: KeyboardEvent<HTMLButtonElement>, from: V) => {
    const order = options.map((o) => o.value);
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Partial<Record<string, number>>)[e.key];
    const next = e.key === "Home" ? order[0] : e.key === "End" ? order[order.length - 1] : step ? order[(order.indexOf(from) + step + order.length) % order.length] : undefined;
    if (next === undefined) return;
    e.preventDefault();
    onChange(next);
    buttons.current.get(next)?.focus();
  };
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          ref={(el) => {
            if (el) buttons.current.set(o.value, el);
            else buttons.current.delete(o.value);
          }}
          className={`ghost${value === o.value ? " on" : ""}`}
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          onKeyDown={(e) => move(e, o.value)}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Where a setting of a fixture is kept: its model (every fixture of it) or this fixture alone. */
export type SettingScope = "model" | "fixture";

/** « Modèle / Cet appareil »: the scope of a fixture's heads, wheel, tracks or travel. */
export function ScopeRadio({ value, onChange, handle }: { value: SettingScope | null; onChange: (value: SettingScope) => void; handle?: Ref<SegmentedRadioHandle> }): ReactElement {
  const t = useT();
  return (
    <SegmentedRadio
      label={t.headsScope}
      options={[
        { value: "model", label: t.headsScopeModel },
        { value: "fixture", label: t.headsScopeFixture },
      ]}
      value={value}
      onChange={onChange}
      handle={handle}
    />
  );
}
