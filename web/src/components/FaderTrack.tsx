import { useRef, type ReactNode, type ReactElement } from "react";
import { dmxOf, rangeAt, rangeNeighbours, type NamedRange } from "../fader-functions";

/** The level really sent by a smoothed fader on its way, over its track; nothing once arrived. */
export function GhostBar({ level }: { level: number | undefined }): ReactElement | null {
  if (level === undefined) return null;
  return <span className="ghost-bar" aria-hidden style={{ height: `${level * 100}%` }} />;
}

/**
 * The ranges beside a fader whose channel is cut into functions (T6, « plages voisines »): the one its value is
 * in, highlighted with its value, and two above and two below with their first value, in the direction of the
 * travel (the top of the column is the high values).
 */
export function RangeLadder({ ranges, value, label }: { ranges: readonly NamedRange[]; value: number; label: string }): ReactElement {
  const { above, current, below } = rangeNeighbours(ranges, value);
  const row = (r: NamedRange) => (
    <li key={`${r.min}-${r.name}`}>
      <span className="range-name" title={r.name || undefined}>{r.name || `${r.min}–${r.max}`}</span>
      <small>{r.min}</small>
    </li>
  );
  return (
    <ol className="range-ladder" aria-label={label}>
      {above.map(row)}
      <li className="now" aria-current="true">
        <span className="range-name" title={current?.name || undefined}>{current ? current.name || `${current.min}–${current.max}` : "–"}</span>
        <small>{value}</small>
      </li>
      {below.map(row)}
    </ol>
  );
}

/** A vertical fader drawn entirely in DOM, with a native range kept for focus and assistive tools.
 *  Shared by the dashboard widgets (Dashboards.tsx) and the fixture panel (FixturePanel.tsx). With `ranges`
 *  (a channel cut into functions, T6) the ranges around its value show on its left and the range input names
 *  the one it is in; `travel` is the fader's own range of DMX values (the whole travel by default). */
export function FaderTrack({ label, value, sent, disabled, interactive, onChange, children, ranges, travel, rangesLabel, ladder = true }: {
  label: string;
  value: number;
  sent?: number;
  disabled: boolean;
  interactive: boolean;
  onChange: (level: number) => void;
  children?: ReactNode;
  ranges?: readonly NamedRange[];
  travel?: { min: number; max: number };
  rangesLabel?: string;
  /** false: the ranges are said by the range input only, no column beside the track (a widget one cell wide). */
  ladder?: boolean;
}): ReactElement {
  const track = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const pointer = useRef<number | null>(null);
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = track.current?.getBoundingClientRect();
    if (!box?.height) return;
    const offset = box.bottom - e.clientY;
    // WebKit rounds pointer coordinates to whole pixels: without an end stop, clicking a thumb at 0 % writes a few steps.
    const level = offset <= 1 ? 0 : offset >= box.height - 1 ? 1 : Math.round((offset / box.height) * 1000) / 1000;
    onChange(level);
  };
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== e.pointerId) return;
    pointer.current = null;
    if (track.current?.hasPointerCapture(e.pointerId)) track.current.releasePointerCapture(e.pointerId);
  };
  const dmx = ranges?.length ? dmxOf(value, travel) : undefined;
  const inRange = dmx === undefined ? undefined : rangeAt(ranges!, dmx);
  const body = (
    <div
      ref={track}
      className={`track${disabled ? " disabled" : ""}`}
      onPointerDown={(e) => {
        if (disabled || !interactive || e.button !== 0 || !e.isPrimary) return;
        e.preventDefault();
        pointer.current = e.pointerId;
        track.current?.setPointerCapture(e.pointerId);
        input.current?.focus({ preventScroll: true });
        move(e);
      }}
      onPointerMove={(e) => {
        if (pointer.current === e.pointerId) move(e);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={() => (pointer.current = null)}
    >
      <input
        ref={input}
        type="range"
        min={0}
        max={1000}
        step={1}
        aria-label={label}
        aria-orientation="vertical"
        aria-valuetext={dmx === undefined ? undefined : `${dmx}${inRange?.name ? ` — ${inRange.name}` : ""}`}
        disabled={disabled}
        value={Math.round(value * 1000)}
        onChange={(e) => onChange(Number(e.currentTarget.value) / 1000)}
        onKeyDown={(e) => {
          const delta = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0;
          if (!delta) return;
          e.preventDefault();
          onChange(Math.min(1, Math.max(0, (Math.round(value * 1000) + delta) / 1000)));
        }}
      />
      <span className="fader-rail" aria-hidden />
      <span className="level-bar" aria-hidden style={{ height: `${value * 100}%` }} />
      {children}
      <GhostBar level={sent} />
      <span className="fader-thumb" aria-hidden style={{ bottom: `${value * 100}%` }} />
    </div>
  );
  if (dmx === undefined || !ladder) return body;
  return (
    <div className="track-row">
      <RangeLadder ranges={ranges!} value={dmx} label={rangesLabel ?? label} />
      {body}
    </div>
  );
}
