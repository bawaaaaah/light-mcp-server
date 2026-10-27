/**
 * Fader smoothing (docs/specs/groups-masters.md, « Lissage »): off, or the level sent glides to the
 * level asked at so many ms per step (1/255 of the travel), at a fixed speed or eased in and out.
 * Shared by the channel fader and group editors and the grand master's menu.
 */
import { useState } from "react";
import { useT } from "../App";

export interface Smoothing {
  curve: "linear" | "ease";
  msPerStep: number;
}

const PRESETS = [1, 2, 5, 10];

/** « 2,6 s »: a full travel (0 → 100 %) at this speed. */
export const fullTravel = (s: Smoothing) => `${((s.msPerStep * 255) / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;

export function SmoothingField({ value, onChange }: { value: Smoothing | undefined; onChange: (s: Smoothing | undefined) => void }) {
  const t = useT();
  const [custom, setCustom] = useState(value !== undefined && !PRESETS.includes(value.msPerStep));
  const choice = !value ? "" : custom ? "custom" : String(value.msPerStep);
  return (
    <>
      <label className="field" title={t.smoothingHelp}>
        <span>{t.smoothing}</span>
        <select
          aria-label={t.smoothing}
          value={choice}
          onChange={(e) => {
            const v = e.target.value;
            setCustom(v === "custom");
            if (!v) onChange(undefined);
            else onChange({ curve: value?.curve ?? "linear", msPerStep: v === "custom" ? (value?.msPerStep ?? 20) : Number(v) });
          }}
        >
          <option value="">{t.smoothingOff}</option>
          {PRESETS.map((ms) => (
            <option key={ms} value={ms}>
              {ms} {t.msPerStep}
            </option>
          ))}
          <option value="custom">{t.smoothingCustom}</option>
        </select>
        {value && (
          <small>
            {t.smoothingTravel} {fullTravel(value)}
          </small>
        )}
      </label>
      {value && custom && (
        <label className="field">
          <span>{t.msPerStep}</span>
          <input
            type="number"
            aria-label={t.msPerStep}
            min={0.1}
            max={1000}
            step={0.1}
            value={value.msPerStep}
            onChange={(e) => onChange({ ...value, msPerStep: Math.max(0.1, Math.min(1000, Number(e.target.value) || 0.1)) })}
          />
        </label>
      )}
      {value && (
        <label className="field">
          <span>{t.smoothingCurve}</span>
          <select aria-label={t.smoothingCurve} value={value.curve} onChange={(e) => onChange({ ...value, curve: e.target.value as Smoothing["curve"] })}>
            <option value="linear">{t.curveLinear}</option>
            <option value="ease">{t.curveEase}</option>
          </select>
        </label>
      )}
    </>
  );
}
