import { SHEET_GUARD_MS } from "./preview-first.js";

/**
 * After the sheet of « preview before launch » closes, the second tap of a double tap lands on whatever is
 * under the finger: the look just started, Blackout, a button held… For a short moment, presses at the spot
 * of the last one are swallowed. Panic never is: a safety control must not drop a press.
 */
export const GHOST_RADIUS_PX = 48;
/** The click that follows a swallowed release comes within this. */
const RELEASE_ECHO_MS = 100;

export interface Armed {
  x: number;
  y: number;
  /** `performance.now()` until which the spot is guarded. */
  until: number;
}

/** Whether a press at `point`, at `now`, is the echo of the one that armed the guard. Pure. */
export function swallows(now: number, armed: Armed | null, point: { x: number; y: number }): boolean {
  return armed !== null && now < armed.until && Math.hypot(point.x - armed.x, point.y - armed.y) <= GHOST_RADIUS_PX;
}

/** What the guard needs of a pointer or click event (the server's typecheck compiles the tests that import this file, with no DOM types). */
interface Press {
  clientX: number;
  clientY: number;
  type?: string;
  pointerId?: number;
  target?: { closest?: (selector: string) => unknown } | null;
  stopPropagation(): void;
  preventDefault(): void;
}

let armed: Armed | null = null;
let installed = false;

function install(): void {
  const page = (globalThis as { window?: { addEventListener(type: string, listener: (e: Press) => void, capture: boolean): void } }).window;
  if (installed || !page) return;
  installed = true;
  // the pointers whose press was swallowed, with when it was released (null: still down): their release and click go too, however
  // late, or a held button would be let go of
  const held = new Map<number, number | null>();
  const block = (e: Press) => {
    const id = e.pointerId;
    if (e.type === "pointerdown" && id !== undefined) held.delete(id); // a new press starts afresh
    const now = performance.now();
    const released = id === undefined ? undefined : held.get(id);
    const echo = released === null || (released !== undefined && now - released < RELEASE_ECHO_MS);
    if (!echo && !swallows(now, armed, { x: e.clientX, y: e.clientY })) return;
    if (e.target?.closest?.("button.panic")) return; // never Panic (its undo is no emergency: it may be swallowed)
    if (id !== undefined) {
      if (e.type === "pointerdown") held.set(id, null);
      else if (e.type === "pointerup" || e.type === "pointercancel") held.set(id, now);
      else if (e.type === "click") held.delete(id);
    }
    e.stopPropagation();
    e.preventDefault();
  };
  // at the window, in the capture phase: before any handler of the page sees it
  for (const type of ["pointerdown", "pointerup", "pointercancel", "click"]) page.addEventListener(type, block, true);
}

/** Guards the spot of a press that has just closed the sheet. */
export function armGhostGuard(point: { x: number; y: number }, now = performance.now(), ms = SHEET_GUARD_MS): void {
  armed = { x: point.x, y: point.y, until: now + ms };
  install();
}
