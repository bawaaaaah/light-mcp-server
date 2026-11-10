import { useRef, type ReactNode, type ReactElement } from "react";

/** The level really sent by a smoothed fader on its way, over its track; nothing once arrived. */
export function GhostBar({ level }: { level: number | undefined }): ReactElement | null {
  if (level === undefined) return null;
  return <span className="ghost-bar" aria-hidden style={{ height: `${level * 100}%` }} />;
}

/** A vertical fader drawn entirely in DOM, with a native range kept for focus and assistive tools.
 *  Shared by the dashboard widgets (Dashboards.tsx) and the fixture panel (FixturePanel.tsx). */
export function FaderTrack({ label, value, sent, disabled, interactive, onChange, children }: {
  label: string;
  value: number;
  sent?: number;
  disabled: boolean;
  interactive: boolean;
  onChange: (level: number) => void;
  children?: ReactNode;
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
  return (
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
}
