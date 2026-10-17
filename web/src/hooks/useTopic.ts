import { useEffect, useState } from "react";
import { control } from "../ws";

/** Latest value of a control topic, optionally seeded by a command. */
export function useTopic<T>(topic: string, initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => control.subscribe(topic, (d) => setValue(d as T)), [topic]);
  return value;
}

/**
 * Calls `fn` whenever a command whose name starts with one of `prefixes` succeeds, and whenever the
 * live link comes up: what changed while it was down (a server restart, a tablet's Wi-Fi) or before
 * it first connected was not heard, so the page reads it again.
 */
export function useCommandEvents(prefixes: string[], fn: () => void): void {
  useEffect(
    () => {
      const offEvents = control.subscribe("light:command", (d) => {
        const e = d as { name: string; ok: boolean };
        if (e.ok && prefixes.some((p) => e.name.startsWith(p))) fn();
      });
      const offStatus = control.onStatus((up) => up && fn());
      return () => {
        offEvents();
        offStatus();
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefixes.join(",")],
  );
}
