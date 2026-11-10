import { useEffect, useState } from "react";
import { createStoredBus } from "../stored-bus";

/**
 * A choice kept on this device (a convenience, such as the stage plan's grid): the default when the
 * browser keeps nothing (private window, blocked storage).
 */
const bus = createStoredBus();

export function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    // what was set in this page wins, even where the browser keeps nothing
    const published = bus.get(key);
    if (published !== undefined) return published as T;
    try {
      const kept = localStorage.getItem(key);
      return kept === null ? initial : (JSON.parse(kept) as T);
    } catch {
      return initial;
    }
  });
  // the same choice read in several places (a switch in the bar, the previews it governs) follows at once, even where the browser keeps nothing
  useEffect(() => bus.subscribe(key, (v) => setValue(v as T)), [key]);
  const set = (v: T) => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      // kept for this page only
    }
    bus.publish(key, v);
    setValue(v);
  };
  return [value, set];
}
