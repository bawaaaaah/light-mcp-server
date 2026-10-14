/**
 * Step editor for the « pas » technique: one row per step, one square per canvas cell. Click (or
 * drag) paints with the brush: a colour, « éteint » ("-") or « non piloté » ("").
 */
import { useState } from "react";
import { useT } from "../App";
import { ColorInput } from "./SchemaFields";

export function StepsEditor({ steps, cells, onChange }: { steps: string[][]; cells: number; onChange: (s: string[][]) => void }) {
  const t = useT();
  const [brush, setBrush] = useState("#ff0000");
  const [mode, setMode] = useState<"color" | "off" | "free">("color");
  const value = mode === "color" ? brush : mode === "off" ? "-" : "";
  const rows = steps.map((r) => Array.from({ length: cells }, (_, k) => r[k] ?? ""));
  const paint = (s: number, k: number) => {
    if (rows[s]![k] === value) return;
    onChange(rows.map((r, i) => (i === s ? r.map((c, j) => (j === k ? value : c)) : r)));
  };

  return (
    <div className="steps-editor">
      <div className="row">
        <label className="row">
          <input type="radio" checked={mode === "color"} onChange={() => setMode("color")} />
          <ColorInput value={brush} onChange={(c) => (setBrush(c), setMode("color"))} />
        </label>
        <label className="row">
          <input type="radio" checked={mode === "off"} onChange={() => setMode("off")} /> {t.off}
        </label>
        <label className="row">
          <input type="radio" checked={mode === "free"} onChange={() => setMode("free")} /> {t.untouched}
        </label>
      </div>
      {rows.map((r, s) => (
        <div key={s} className="step-row">
          <small>{s + 1}</small>
          {r.map((c, k) => (
            <span
              key={k}
              className={c === "" ? "cell free" : "cell"}
              style={{ background: c === "-" ? "#000" : c === "" ? undefined : c.slice(0, 7) }}
              onPointerDown={() => paint(s, k)}
              onPointerEnter={(e) => e.buttons && paint(s, k)}
            />
          ))}
          <button className="ghost" title={t.duplicate} onClick={() => onChange([...rows.slice(0, s + 1), [...r], ...rows.slice(s + 1)])}>
            ⧉
          </button>
          {rows.length > 1 && (
            <button className="ghost" title={t.delete} onClick={() => onChange(rows.filter((_, i) => i !== s))}>
              ✕
            </button>
          )}
        </div>
      ))}
      <button onClick={() => onChange([...rows, Array.from({ length: cells }, () => "-")])}>+ {t.step}</button>
    </div>
  );
}
