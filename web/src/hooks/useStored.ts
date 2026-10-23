import { useState } from "react";

/**
 * A choice kept on this device (a convenience, such as the stage plan's grid): the default when the
 * browser keeps nothing (private window, blocked storage).
 */
export function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const kept = localStorage.getItem(key);
      return kept === null ? initial : (JSON.parse(kept) as T);
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      // kept for this page only
    }
  };
  return [value, set];
}
