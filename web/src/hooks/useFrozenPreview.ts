import { useFreezeFast } from "./usePreviewSettings";
import { flashRate, shouldFreeze, type RateTiming } from "../preview-rate";
import type { Preview } from "../components/LookPreview";

/**
 * Whether a look's preview stays on its first step: the « freeze flashes » setting is on and the look
 * flashes more than the safety ceiling per second at this tempo (the server sends the count per loop,
 * the rate follows the tempo). One answer for every preview (tooltip, menu, sheet, editor), so none
 * of them keeps flashing; recomputed at each render, so a tempo change is followed.
 */
export function useFrozenPreview(preview: Preview | null, timing: RateTiming, bpm: number): boolean {
  const [freezeFast] = useFreezeFast();
  if (!freezeFast || !preview?.flashes) return false;
  return shouldFreeze(flashRate(preview, timing, bpm), preview.flashes.max);
}
