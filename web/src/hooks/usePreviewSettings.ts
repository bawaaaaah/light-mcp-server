import { useStored } from "./useStored";
import { isTouchPrimary, prefersReducedMotion } from "../touch";

/**
 * Whether pressing a look button opens its preview first (Launch or Cancel). On by default on a touch
 * screen, where there is no hover to look before pressing; off with a mouse. A value already stored by
 * the browser wins over the device default.
 */
export function usePreviewFirst(): [boolean, (on: boolean) => void] {
  return useStored<boolean>("lookPreviewFirst", isTouchPrimary());
}

/**
 * Whether the preview of a look that flashes too fast (more than the safety ceiling per second) is
 * frozen on its first step, for people who are photosensitive. Off by default, on by default when the
 * system is asked for less motion; the browser keeps it.
 */
export function useFreezeFast(): [boolean, (on: boolean) => void] {
  return useStored<boolean>("previewFreezeFast", prefersReducedMotion());
}
