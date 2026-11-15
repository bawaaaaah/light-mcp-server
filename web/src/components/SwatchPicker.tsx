/**
 * A colour picked among the ready-made swatches (color.ts), or none: a row of round radio buttons, named for the
 * screen readers by the swatch's name. Shared by the forms of the 3D targets (T24) and of the named positions (T32).
 */
import type { ReactElement } from "react";
import { useT } from "../App";
import { SWATCHES } from "../color";

export function SwatchPicker({ label, noneLabel, value, onChange }: { label: string; noneLabel: string; value: string | undefined; onChange: (color: string | undefined) => void }): ReactElement {
  const t = useT();
  return (
    <div className="field">
      <span>{label}</span>
      <div className="swatches" role="radiogroup" aria-label={label}>
        <button type="button" className={`swatch none ${!value ? "chosen" : ""}`} role="radio" aria-checked={!value} title={noneLabel} aria-label={noneLabel} onClick={() => onChange(undefined)} />
        {SWATCHES.map(([name, hex]) => (
          <button
            type="button"
            key={hex}
            className={`swatch ${value === hex ? "chosen" : ""}`}
            role="radio"
            aria-checked={value === hex}
            title={t.swatchNames[name as keyof typeof t.swatchNames]}
            aria-label={t.swatchNames[name as keyof typeof t.swatchNames]}
            style={{ background: hex }}
            onClick={() => onChange(hex)}
          />
        ))}
      </div>
    </div>
  );
}
