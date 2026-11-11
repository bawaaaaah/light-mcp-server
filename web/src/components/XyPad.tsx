import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";

interface Head {
  id: string;
  manual: { pan: number; tilt: number } | null;
}

/**
 * XY pad for moving heads: X = pan, Y = tilt (top = 1). Sends `position.set` at most every 40 ms
 * while dragging (the last position is always sent), « ⟲ » releases back to the looks.
 * `onPosition` says each read or sent position (a panel's feedback); bump `resync` to read again
 * what has moved from elsewhere (an aim, a Panic, a release by another screen).
 */
export function XyPad({ group, fixture, label, onError, disabled = false, onPosition, resync }: { group?: string; fixture?: string; label?: string; onError: (msg: string) => void; disabled?: boolean; onPosition?: (p: { pan: number; tilt: number } | null) => void; resync?: unknown }): ReactElement {
  const t = useT();
  const [pos, setPos] = useState<{ pan: number; tilt: number } | null>(null);
  const pad = useRef<HTMLDivElement>(null);
  const pending = useRef<{ pan: number; tilt: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const hintId = useId();
  const target = fixture ? { fixtures: [fixture] } : group ? { group } : {};
  // The unmount flush runs the first render's closure: it reads the *current* target from here.
  const targetRef = useRef(target);
  targetRef.current = target;

  // Read the head's position on mount and on every resync (a panel bumps it on position.* events,
  // its own sends included). The read leaves the send loop alone — its 40 ms cadence holds — and
  // does not pull the dot back while a gesture is still being sent.
  useEffect(() => {
    void cmd<Head[]>("position.list")
      .then((heads) => {
        if (timer.current !== undefined || pending.current) return;
        const manual = (fixture ? heads.find((h) => h.id === fixture) : heads.find((h) => h.manual))?.manual ?? null;
        setPos(manual);
        onPosition?.(manual);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onPosition` is a new closure on every render of the panel: reading again on each would flood position.list
  }, [group, fixture, resync]);
  // On unmount only: stop the loop, and send the gesture value not sent yet.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      if (pending.current) flush();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on unmount: `flush` sends to this pad's own target
    [],
  );

  const flush = () => {
    timer.current = undefined;
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    void cmd("position.set", { ...targetRef.current, ...p }).catch((e: Error) => onError(e.message));
    timer.current = window.setTimeout(flush, 40);
  };
  const send = (p: { pan: number; tilt: number }) => {
    setPos(p);
    onPosition?.(p);
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
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((pos?.pan ?? 0.5) * 100)}
        aria-describedby={hintId}
        aria-valuetext={pos ? `pan ${Math.round(pos.pan * 100)} %, tilt ${Math.round(pos.tilt * 100)} %` : "—"}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          // the keyboard moves the head too: arrows by 1 % (Shift: 10 %), Home back to the centre
          if (disabled) return;
          const step = e.shiftKey ? 0.1 : 0.01;
          // while the heads follow the looks (no manual position) the server does not say where they
          // are: the first key starts from the centre, then the position is manual
          const at = pos ?? { pan: 0.5, tilt: 0.5 };
          const clamp = (v: number) => Math.max(0, Math.min(1, Math.round(v * 1000) / 1000));
          const next =
            e.key === "ArrowLeft" ? { ...at, pan: clamp(at.pan - step) }
            : e.key === "ArrowRight" ? { ...at, pan: clamp(at.pan + step) }
            : e.key === "ArrowUp" ? { ...at, tilt: clamp(at.tilt + step) }
            : e.key === "ArrowDown" ? { ...at, tilt: clamp(at.tilt - step) }
            : e.key === "Home" ? { pan: 0.5, tilt: 0.5 }
            : undefined;
          if (!next) return;
          e.preventDefault();
          e.stopPropagation(); // the stage plan's arrows (turn, nudge) are not for the pad
          send(next);
        }}
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
      <small id={hintId} className="sr-only">{t.padKeysHelp}</small>
      <div className="row">
        <label>{label ?? t.heads}</label>
        <small>{pos ? `${Math.round(pos.pan * 100)} / ${Math.round(pos.tilt * 100)}` : t.followsLooks}</small>
        <button
          title={t.releaseHeads}
          disabled={disabled}
          onClick={() => {
            pending.current = null;
            setPos(null);
            onPosition?.(null);
            void cmd("position.release", target).catch((e: Error) => onError(e.message));
          }}
        >
          ⟲
        </button>
      </div>
    </div>
  );
}
