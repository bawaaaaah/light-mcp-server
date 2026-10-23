/**
 * Animated preview of a look on its canvas. The steps come from the server (`look.preview`, the
 * same generator as the show); the timing is replayed here: cadence at the current tempo, attack
 * as a cross-fade, loop / ping-pong / random order. The same frame can light the stage plan.
 */
import { useEffect, useRef, useState } from "react";

export interface Preview {
  cells: number;
  topology: string;
  columns?: number;
  steps: (string | null)[][];
}
interface Timing {
  every: { beats?: number; seconds?: number };
  attack: number;
  order: string;
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a: string | null, b: string | null, k: number): string | null => {
  if (!b || !a) return b ?? a;
  const [x, y] = [rgb(a), rgb(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i]! - v) * k)).join(",")})`;
};

/** The preview's frame now (cells in the canvas's order), replayed at the look's timing: the strip and the stage show the same one. */
export function usePreviewFrame(preview: Preview | null, timing: Timing, bpm: number): (string | null)[] {
  const [frame, setFrame] = useState<(string | null)[]>([]);
  const start = useRef(performance.now());
  const order = useRef<number[]>([]);

  useEffect(() => {
    start.current = performance.now();
    order.current = [];
  }, [preview, timing.order]);

  useEffect(() => {
    if (!preview) return;
    const n = preview.steps.length;
    const stepAt = (i: number) => {
      if (n === 1) return 0;
      if (timing.order === "loop") return i % n;
      if (timing.order === "pingpong") {
        const p = i % (2 * n - 2);
        return p < n ? p : 2 * n - 2 - p;
      }
      while (order.current.length <= i) {
        const prev = order.current[order.current.length - 1];
        let pick = Math.floor(Math.random() * n);
        if (pick === prev) pick = (pick + 1) % n;
        order.current.push(pick);
      }
      return order.current[i]!;
    };
    const seconds = timing.every.seconds ?? ((timing.every.beats ?? 1) * 60) / Math.max(1, bpm);
    let raf = 0;
    const tick = () => {
      const pos = (performance.now() - start.current) / 1000 / seconds;
      const i = Math.floor(pos);
      const frac = pos - i;
      const cur = preview.steps[stepAt(i)] ?? [];
      const prev = i > 0 ? (preview.steps[stepAt(i - 1)] ?? []) : cur;
      const k = timing.attack > 0 && frac < timing.attack ? frac / timing.attack : 1;
      setFrame(cur.map((c, j) => (k >= 1 ? c : mix(prev[j] ?? null, c, k))));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [preview, timing.every.beats, timing.every.seconds, timing.attack, timing.order, bpm]);
  return frame;
}

/**
 * The preview strip. A line canvas sits on the steps' grid (`order`: the cell shown at each place;
 * `starts`: places where a new fixture begins, a separator before); a grid canvas keeps its rows.
 * `plain`: on its own, as wide as its box (a button's menu on the Live), its `columns` given or one per cell.
 */
export function LookPreview({ preview, frame, label, order, starts, plain = false, columns }: { preview: Preview; frame: (string | null)[]; label: string; order?: number[]; starts?: ReadonlySet<number>; plain?: boolean; columns?: string }) {
  if (preview.topology === "grid" && preview.columns) {
    return (
      <div className="preview" style={{ gridTemplateColumns: `repeat(${preview.columns}, 1fr)` }} aria-label={label}>
        {Array.from({ length: preview.cells }, (_, k) => (
          <span key={k} className={frame[k] ? "cell" : "cell free"} style={{ background: frame[k] ?? undefined }} />
        ))}
      </div>
    );
  }
  const shown = order ?? Array.from({ length: preview.cells }, (_, k) => k);
  if (plain)
    return (
      <div className="preview plain" style={{ gridTemplateColumns: columns ?? `repeat(${preview.cells}, minmax(0, 1fr))` }} aria-label={label}>
        {shown.map((k, i) => (
          <span key={k} className={`${frame[k] ? "cell" : "cell free"}${starts?.has(i) ? " block-start" : ""}`} style={{ background: frame[k] ?? undefined }} />
        ))}
      </div>
    );
  return (
    <div className="step-row preview-row" aria-label={label}>
      <small />
      {shown.map((k, i) => (
        <span key={k} className={`${frame[k] ? "cell" : "cell free"}${starts?.has(i) ? " block-start" : ""}`} style={{ background: frame[k] ?? undefined }} />
      ))}
    </div>
  );
}
