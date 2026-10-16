import { useEffect, useRef, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";

interface Head {
  id: string;
  manual: { pan: number; tilt: number } | null;
}

/**
 * XY pad for moving heads: X = pan, Y = tilt (top = 1). Sends `position.set` at most every 40 ms
 * while dragging (the last position is always sent), « ⟲ » releases back to the looks.
 */
export function XyPad({ group, fixture, label, onError, disabled = false }: { group?: string; fixture?: string; label?: string; onError: (msg: string) => void; disabled?: boolean }) {
  const t = useT();
  const [pos, setPos] = useState<{ pan: number; tilt: number } | null>(null);
  const pad = useRef<HTMLDivElement>(null);
  const pending = useRef<{ pan: number; tilt: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const target = fixture ? { fixtures: [fixture] } : group ? { group } : {};

  useEffect(() => {
    void cmd<Head[]>("position.list")
      .then((heads) => setPos((fixture ? heads.find((h) => h.id === fixture) : heads.find((h) => h.manual))?.manual ?? null))
      .catch(() => undefined);
    return () => window.clearTimeout(timer.current);
  }, [group, fixture]);

  const flush = () => {
    timer.current = undefined;
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    void cmd("position.set", { ...target, ...p }).catch((e: Error) => onError(e.message));
    timer.current = window.setTimeout(flush, 40);
  };
  const send = (p: { pan: number; tilt: number }) => {
    setPos(p);
    pending.current = p;
    if (timer.current === undefined) flush();
  };
  const fromEvent = (e: React.PointerEvent) => {
    const r = pad.current!.getBoundingClientRect();
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    return { pan: clamp((e.clientX - r.left) / r.width), tilt: clamp(1 - (e.clientY - r.top) / r.height) };
  };

  return (
    <div className="xy fill">
      <div
        ref={pad}
        className="pad"
        role="slider"
        aria-label={label ?? t.heads}
        aria-valuetext={pos ? `pan ${Math.round(pos.pan * 100)} %, tilt ${Math.round(pos.tilt * 100)} %` : "—"}
        aria-disabled={disabled || undefined}
        onPointerDown={(e) => {
          if (disabled) return; // the role may not move the heads (commands:position)
          e.currentTarget.setPointerCapture(e.pointerId);
          send(fromEvent(e));
        }}
        onPointerMove={(e) => {
          if (e.buttons && !disabled) send(fromEvent(e));
        }}
      >
        <span className="cross" />
        {pos && <span className="dot" style={{ left: `${pos.pan * 100}%`, top: `${(1 - pos.tilt) * 100}%` }} />}
      </div>
      <div className="row">
        <label>{label ?? t.heads}</label>
        <small>{pos ? `${Math.round(pos.pan * 100)} / ${Math.round(pos.tilt * 100)}` : t.followsLooks}</small>
        <button
          title={t.releaseHeads}
          disabled={disabled}
          onClick={() => {
            pending.current = null;
            setPos(null);
            void cmd("position.release", target).catch((e: Error) => onError(e.message));
          }}
        >
          ⟲
        </button>
      </div>
    </div>
  );
}
