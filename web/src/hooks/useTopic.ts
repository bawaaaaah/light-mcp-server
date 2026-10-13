import { useEffect, useState } from "react";
import { control } from "../ws";

/** Latest value of a control topic, optionally seeded by a command. */
export function useTopic<T>(topic: string, initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => control.subscribe(topic, (d) => setValue(d as T)), [topic]);
  return value;
}

/** Calls `fn` whenever a command whose name starts with one of `prefixes` succeeds. */
export function useCommandEvents(prefixes: string[], fn: () => void): void {
  useEffect(
    () =>
      control.subscribe("light:command", (d) => {
        const e = d as { name: string; ok: boolean };
        if (e.ok && prefixes.some((p) => e.name.startsWith(p))) fn();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefixes.join(",")],
  );
}
