/**
 * Step editor for the « pas » technique: one row per step, one square per canvas cell. Click (or
 * drag) paints with the brush: a colour, « éteint » ("-") or « non piloté » (""). The squares are
 * shown in `order` (the stage's, from jardin to cour) on the look editor's grid, a separator where
 * a new fixture begins; painting one paints its own cell of the canvas.
 */
import { useState } from "react";
import { useT } from "../App";
import { ColorInput } from "./SchemaFields";
import type { Block } from "../canvas-blocks";

/** The fixture behind each run of cells, on the same grid as the squares (the look editor's). */
export function BlockNames({ blocks }: { blocks: Block[] }) {
  const t = useT();
  if (!blocks.some((b) => b.label)) return null;
  return (
    <div className="step-row step-blocks" aria-label={t.stepBlocks}>
      <small />
      {blocks.map((b) => (
        <span key={b.from} className={`block${b.from > 0 ? " block-start" : ""}`} style={{ gridColumn: `span ${b.to - b.from + 1}` }} title={`${b.label || "—"} · ${b.to - b.from + 1} ${t.cellsShort}`}>
          {b.color && <span className="swatch-dot" style={{ background: b.color }} aria-hidden />}
          {b.label}
        </span>
      ))}
    </div>
  );
}

export function StepsEditor({ steps, cells, blocks = [], order, onChange }: { steps: string[][]; cells: number; blocks?: Block[]; order?: number[]; onChange: (s: string[][]) => void }) {
  const t = useT();
  const [brush, setBrush] = useState("#ff0000");
  const [mode, setMode] = useState<"color" | "off" | "free">("color");
  const value = mode === "color" ? brush : mode === "off" ? "-" : "";
  const rows = steps.map((r) => Array.from({ length: cells }, (_, k) => r[k] ?? ""));
  const shown = order ?? Array.from({ length: cells }, (_, k) => k);
  const starts = new Set(blocks.filter((b) => b.from > 0).map((b) => b.from));
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
      <BlockNames blocks={blocks} />
      {rows.map((r, s) => (
        <div key={s} className="step-row">
          <small>{s + 1}</small>
          {shown.map((k, i) => {
            const c = r[k]!;
            return (
              <span
                key={k}
                className={`${c === "" ? "cell free" : "cell"}${starts.has(i) ? " block-start" : ""}`}
                style={{ background: c === "-" ? "#000" : c === "" ? undefined : c.slice(0, 7) }}
                onPointerDown={() => paint(s, k)}
                onPointerEnter={(e) => e.buttons && paint(s, k)}
              />
            );
          })}
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
