/**
 * Step editor for the « pas » technique: one row per step, one square per canvas cell. Click (or
 * drag) paints with the brush: a colour, « éteint » ("-") or « non piloté » (""). Above the steps,
 * the fixture behind each run of cells (`blocks`), on the same grid as the squares.
 */
import { useState, type CSSProperties } from "react";
import { useT } from "../App";
import { ColorInput } from "./SchemaFields";
import type { Block } from "../canvas-blocks";

export function StepsEditor({ steps, cells, blocks = [], onChange }: { steps: string[][]; cells: number; blocks?: Block[]; onChange: (s: string[][]) => void }) {
  const t = useT();
  const [brush, setBrush] = useState("#ff0000");
  const [mode, setMode] = useState<"color" | "off" | "free">("color");
  const value = mode === "color" ? brush : mode === "off" ? "-" : "";
  const rows = steps.map((r) => Array.from({ length: cells }, (_, k) => r[k] ?? ""));
  const paint = (s: number, k: number) => {
    if (rows[s]![k] === value) return;
    onChange(rows.map((r, i) => (i === s ? r.map((c, j) => (j === k ? value : c)) : r)));
  };

  // the number, a column per cell, then duplicate and delete: the names above line up with the squares
  const grid = { "--step-columns": `2em repeat(${cells}, minmax(0.4em, 1.6em)) 2.2em 2.2em` } as CSSProperties;
  const named = blocks.some((b) => b.label);

  return (
    <div className="steps-editor" style={grid}>
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
      {named && (
        <div className="step-row step-blocks" aria-label={t.stepBlocks}>
          <small />
          {blocks.map((b) => (
            <span key={b.from} className="block" style={{ gridColumn: `span ${b.to - b.from + 1}` }} title={`${b.label || "—"} · ${b.from + 1}–${b.to + 1}`}>
              {b.color && <span className="swatch-dot" style={{ background: b.color }} aria-hidden />}
              {b.label}
            </span>
          ))}
        </div>
      )}
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
