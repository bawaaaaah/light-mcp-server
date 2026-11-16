import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";

/**
 * A menu opened where the click was (right-click, or a long press on a touch screen), kept on screen
 * by its real size (it grows with its content, narrows on a phone; taller than the window, it
 * scrolls inside), closed by a click elsewhere or Escape.
 * `above`: the y just over the thing it hangs from (a tooltip): with no room below `at`, it opens
 * above that instead of sliding up over it. `closeOutside` false: a click elsewhere leaves it open (a form whose
 * input would be lost: only its own buttons and Escape close it). `at.before`: the x where what it describes starts on
 * the left: with no room right of `at.x`, it opens to the left of that rather than over it.
 */
export function useFloatingMenu<E extends HTMLElement = HTMLDivElement>(at: { x: number; y: number; before?: number }, onClose: () => void, above?: number, closeOutside = true): { box: RefObject<E | null>; style: { left: number; top: number } } {
  const box = useRef<E>(null);
  const [size, setSize] = useState({ width: 340, height: 380 });
  // the window's size, only to place the menu again when it changes
  const [, setViewport] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const away = (e: PointerEvent) => closeOutside && !box.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs after every render on purpose, to follow the content as it grows; setSize only fires when the measured size changed, so it cannot loop
  useLayoutEffect(() => {
    const el = box.current;
    if (el && (el.offsetWidth !== size.width || el.offsetHeight !== size.height)) setSize({ width: el.offsetWidth, height: el.offsetHeight });
  });
  // an entry that grows on its own (a heads or wheel editor unfolding, its list arriving) re-renders itself, not the
  // menu: watch the box's size too, and the window's, so the menu is placed again and stays inside the viewport
  const observer = useRef<ResizeObserver | undefined>(undefined);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.width === el.offsetWidth && s.height === el.offsetHeight ? s : { width: el.offsetWidth, height: el.offsetHeight }));
    const watching = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer.current = watching;
    const resized = () => (measure(), setViewport({ width: window.innerWidth, height: window.innerHeight }));
    window.addEventListener("resize", resized);
    return () => {
      watching?.disconnect();
      observer.current = undefined;
      window.removeEventListener("resize", resized);
    };
  }, []);
  // The observer only reports a size that differs from the last one IT saw, at the end of a frame. The measure after
  // a render (above) can record a size the observer never saw (an entry shrinking then growing back within one
  // frame): the box is then back at the observer's last size, nothing is reported, and the menu stays placed for the
  // smaller size, its bottom outside the window. So each recorded size starts the observation again: observing
  // always reports once, which checks the recorded size against the box as it really is, and corrects it.
  useEffect(() => {
    const el = box.current;
    const watching = observer.current;
    if (!el || !watching) return;
    watching.unobserve(el);
    watching.observe(el);
  }, [size.width, size.height]);
  const width = document.documentElement.clientWidth;
  const left = at.before !== undefined && at.x + size.width + 8 > width && at.before - size.width >= 8 ? at.before - size.width : Math.max(8, Math.min(at.x, width - size.width - 8));
  const flip = above !== undefined && at.y + size.height + 8 > window.innerHeight;
  const top = flip ? Math.max(8, above - size.height) : Math.max(8, Math.min(at.y, window.innerHeight - size.height - 8));
  return { box, style: { left, top } };
}

/** The controls Tab stops at, in order (a radio group's unchecked radios are not stops). */
export function tabStops(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]")].filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled);
}

/**
 * A floating menu that holds the keyboard while open: Tab and Shift+Tab go round inside it instead of leaving it for
 * the page behind, and the focus goes back to where it was (the row, the plan's fixture or zone) when it closes.
 * Returns the menu's onKeyDown.
 */
export function useMenuFocus(box: RefObject<HTMLElement | null>): (e: ReactKeyboardEvent) => void {
  const opener = useRef<HTMLElement | SVGElement | null>(document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement ? document.activeElement : null);
  useEffect(() => {
    const back = opener.current;
    return () => {
      // StrictMode runs this cleanup between two mounts in dev: the menu is back by the time the microtask runs, then focus stays
      queueMicrotask(() => {
        // eslint-disable-next-line react-hooks/exhaustive-deps -- read on purpose after the cleanup: is the menu still (or again) in the page?
        if (!box.current?.isConnected && back?.isConnected) back.focus({ preventScroll: true });
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once; `box` is a stable ref
  }, []);
  return (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const stops = tabStops(box.current);
    if (!stops.length) return;
    const [first, last] = [stops[0]!, stops[stops.length - 1]!];
    // the key reaches this handler only from inside the box: the box itself (after a click on its background) goes back to a stop
    if (document.activeElement === box.current) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
}

const LONG_PRESS_MS = 600;

/** The handlers `useContextMenu` gives one row of the list. */
export interface ContextMenuHandlers {
  onContextMenu: (e: ReactMouseEvent) => void;
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onClickCapture: (e: ReactMouseEvent) => void;
}

/**
 * Right-click, or a finger held still on a touch screen, opens a menu at that point; the click that
 * ends a long press is eaten. For list rows: the dashboards' widgets have their own (edit mode, drag).
 */
export function useContextMenu<K>(open: (at: { x: number; y: number }, key: K) => void): (key: K) => ContextMenuHandlers {
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
