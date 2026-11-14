/**
 * The two-press pattern of the buttons that ask a confirmation (« À confirmer », « Appuyer encore pour défiger »):
 * its timings and the rule a second press must meet. Pure, tested without a browser; the hook is hooks/useArm.ts.
 */

/** How long an armed button waits for its second press (« À confirmer », « Appuyer encore »). */
export const ARM_MS = 3000;
/**
 * A second press closer than this to the first is no confirmation: a double click, a double tap, or a held key whose
 * repeats would fire the action the first press only armed.
 */
export const CONFIRM_MIN_MS = 500;

/**
 * Whether a press confirms what an earlier press armed: the same key, armed at least `CONFIRM_MIN_MS` and less than
 * `ARM_MS` ago. Pure, for the tests.
 */
export function confirms(arm: { key: string; at: number } | null, key: string, now: number): boolean {
  return arm !== null && arm.key === key && now - arm.at >= CONFIRM_MIN_MS && now - arm.at < ARM_MS;
}

