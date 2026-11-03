import { SHEET_GUARD_MS } from "./preview-first.js";

/**
 * After the sheet of « preview before launch » closes, the second tap of a double tap lands on whatever is
 * under the finger: the look just started, Blackout, a button held… For a short moment, presses at the spot
 * of the last one are swallowed. Panic never is: a safety control must not drop a press.
 */
export const GHOST_RADIUS_PX = 48;

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
  const block = (e: Press) => {
    if (!swallows(performance.now(), armed, { x: e.clientX, y: e.clientY })) return;
    if (e.target?.closest?.(".panic-cell")) return; // never Panic
    e.stopPropagation();
    e.preventDefault();
  };
  // at the window, in the capture phase: before any handler of the page sees it
  for (const type of ["pointerdown", "pointerup", "click"]) page.addEventListener(type, block, true);
}

/** Guards the spot of a press that has just closed the sheet. */
export function armGhostGuard(point: { x: number; y: number }, now = performance.now(), ms = SHEET_GUARD_MS): void {
  armed = { x: point.x, y: point.y, until: now + ms };
  install();
}
