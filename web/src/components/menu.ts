import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";

/**
 * A menu opened where the click was (right-click, or a long press on a touch screen), kept on screen
 * by its real size (it grows with its content, narrows on a phone; taller than the window, it
 * scrolls inside), closed by a click elsewhere or Escape.
 */
export function useFloatingMenu(at: { x: number; y: number }, onClose: () => void) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 340, height: 380 });
  useEffect(() => {
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && (el.offsetWidth !== size.width || el.offsetHeight !== size.height)) setSize({ width: el.offsetWidth, height: el.offsetHeight });
  });
  const left = Math.max(8, Math.min(at.x, document.documentElement.clientWidth - size.width - 8));
  const top = Math.max(8, Math.min(at.y, window.innerHeight - size.height - 8));
  return { box, style: { left, top } };
}

const LONG_PRESS_MS = 600;

/**
 * Right-click, or a finger held still on a touch screen, opens a menu at that point; the click that
 * ends a long press is eaten. For list rows: the dashboards' widgets have their own (edit mode, drag).
 */
export function useContextMenu<K>(open: (at: { x: number; y: number }, key: K) => void) {
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const cancel = () => {
    const p = press.current;
    if (p && !p.fired) {
      window.clearTimeout(p.timer);
      press.current = null;
    }
  };
  /** The handlers for one row of the list. */
  return (key: K) => ({
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      cancel();
      open({ x: e.clientX, y: e.clientY }, key);
    },
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType !== "touch") return;
      const at = { x: e.clientX, y: e.clientY };
      const timer = window.setTimeout(() => {
        if (!press.current) return;
        press.current.fired = true;
        open(at, key);
      }, LONG_PRESS_MS);
      press.current = { timer, ...at, fired: false };
    },
    onPointerMove: (e: ReactPointerEvent) => {
      const p = press.current;
      if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (e: ReactMouseEvent) => {
      if (!press.current?.fired) return;
      press.current = null;
      e.stopPropagation();
      e.preventDefault();
    },
  });
}
