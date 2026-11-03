/**
 * Whether the primary pointer of this device is a touch screen: the user points with a finger (a
 * phone, a tablet). A laptop with a mouse and a touch screen answers false: the mouse stays the
 * primary pointer there. The media query is injectable, so this runs without a browser.
 */
export function isTouchPrimary(match?: (query: string) => { matches: boolean }): boolean {
  // globalThis, not window: the server's typecheck compiles the tests that import this file
  const ask = match ?? (globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia?.bind(globalThis);
  return ask ? ask("(hover: none), (pointer: coarse)").matches : false;
}


/** Whether the system is asked for less motion (a setting some people make for their health): the freeze of fast previews is then on by default. */
export function prefersReducedMotion(match?: (query: string) => { matches: boolean }): boolean {
  const ask = match ?? (globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia?.bind(globalThis);
  return ask ? ask("(prefers-reduced-motion: reduce)").matches : false;
}
