import { useImperativeHandle, useRef, type KeyboardEvent, type ReactElement, type ReactNode, type Ref } from "react";
import { useT } from "../i18n-context";
import { radioTarget } from "../radio-keys";

/** What a caller can do with the group: put the focus back on the checked choice (a button gone, a question answered). */
export interface SegmentedRadioHandle {
  focus: () => void;
}

/** One choice of a `SegmentedRadio`. */
export interface SegmentedOption<V> {
  value: V;
  label: ReactNode;
  /** Shown before the label, hidden from screen readers (the label names the choice). */
  icon?: string;
  /** Not choosable now (`aria-disabled`, still focusable by a click to say why in its title): the arrows skip it. */
  disabled?: boolean;
  title?: string;
  className?: string;
  testId?: string;
}

/**
 * A row of buttons choosing one value (T47: « modèle / appareil » of the heads, the wheel, the tracks, the travel; T28:
 * the base of a look's move, the heads of a path), a radio group to the keyboard: one tab stop on the checked choice,
 * the arrows move to the next or previous one (round the end, skipping a disabled one), Home and End to the first and
 * the last, the focus following the choice. The keys are `radioTarget` (radio-keys.ts, pure and tested).
 */
export function SegmentedRadio<V extends string | number>({
  label,
  labelledBy,
  options,
  value,
  onChange,
  handle,
  className = "swatches",
  buttonClassName = "ghost",
}: {
  /** The group's name, or `labelledBy`: the id of what names it (a fieldset's legend). */
  label?: string;
  labelledBy?: string;
  options: readonly SegmentedOption<V>[];
  /** None checked yet: no tab stop either. */
  value: V | null;
  onChange: (value: V) => void;
  handle?: Ref<SegmentedRadioHandle>;
  className?: string;
  buttonClassName?: string;
}): ReactElement {
  const buttons = useRef(new Map<V, HTMLButtonElement>());
  useImperativeHandle(handle, () => ({ focus: () => (value === null ? undefined : buttons.current.get(value)?.focus()) }), [value]);
  const move = (e: KeyboardEvent<HTMLButtonElement>, from: V) => {
    const to = radioTarget(
      e.key,
      options.findIndex((o) => o.value === from),
      options.length,
      (i) => !options[i]!.disabled,
    );
    if (to === undefined) return;
    e.preventDefault();
    const next = options[to]!.value;
    onChange(next);
    buttons.current.get(next)?.focus();
  };
  return (
    <div className={className} role="radiogroup" {...(labelledBy ? { "aria-labelledby": labelledBy } : { "aria-label": label })}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          ref={(el) => {
            if (el) buttons.current.set(o.value, el);
            else buttons.current.delete(o.value);
          }}
          className={[buttonClassName, o.className, value === o.value ? "on" : ""].filter(Boolean).join(" ") || undefined}
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          {...(o.disabled ? { "aria-disabled": true } : {})}
          {...(o.title ? { title: o.title } : {})}
          {...(o.testId ? { "data-testid": o.testId } : {})}
          onKeyDown={(e) => move(e, o.value)}
          onClick={() => !o.disabled && onChange(o.value)}
        >
          {o.icon && <span aria-hidden="true">{o.icon} </span>}
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
