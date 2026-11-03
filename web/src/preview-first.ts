/**
 * The rules of « preview before launch » (docs/specs/ui-dashboards.md), apart from the components so
 * they can be tested without a browser.
 */

/** How long after the sheet opened a press on its backdrop or on Launch is still the finger that opened it bouncing. */
export const SHEET_GUARD_MS = 400;

/** Whether the guard is over: only a press after it is a choice. */
export const guardPassed = (now: number, openedAt: number): boolean => now - openedAt > SHEET_GUARD_MS;

/**
 * Whether a press on a look button opens its preview first. Only switching on asks: a held (momentary)
 * button is a deliberate hold, and a « Déclencher » look that already plays has nothing to start.
 * Stopping is never asked about: the caller only uses this for the way in.
 */
export function asksBeforeLaunch({ on, mode, playing }: { on: boolean; mode?: string; playing: boolean }): boolean {
  return on && mode !== "momentary" && !(mode === "trigger" && playing);
}
