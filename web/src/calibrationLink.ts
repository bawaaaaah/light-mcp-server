/**
 * « Calibration manuelle » from a fixture's panel (T8, lot 6): the panel lives inside the stage plan, the calibration
 * assistant below it on the Venue page. The link asks; the assistant, when it is on the page, opens its manual tab on
 * that head. Nothing is remembered: with no assistant listening, the request is dropped.
 */
type Listener = (fixture: string) => void;
const listeners = new Set<Listener>();

/** Asks the calibration assistant to open its manual tab on this head. */
export function openManualCalibration(fixture: string): void {
  for (const listener of listeners) listener(fixture);
}

/** Listens for such requests; returns the unsubscription. */
export function onManualCalibration(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
