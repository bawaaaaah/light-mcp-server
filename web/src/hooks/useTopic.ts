import { useEffect, useState } from "react";
import { control } from "../ws";
import { changesAny, type Domain } from "../../../src/plugins/light/commands/domains.js";

/** Latest value of a control topic, optionally seeded by a command. */
export function useTopic<T>(topic: string, initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => control.subscribe(topic, (d) => setValue(d as T)), [topic]);
  return value;
}

/**
 * Calls `fn` whenever a command that changes one of `domains` succeeds (its event says what it changes:
 * src/plugins/light/commands/domains.ts), or after every command with "any", and whenever the live link comes up: what
 * changed while it was down (a server restart, a tablet's Wi-Fi) or before it first connected was not heard, so the page
 * reads it again.
 */
export function useDomainEvents(domains: readonly Domain[] | "any", fn: () => void): void {
  useEffect(
    () => {
      const offEvents = control.subscribe("light:command", (d) => {
        const e = d as { ok: boolean; changes?: readonly Domain[] };
        if (e.ok && (domains === "any" || changesAny(e.changes, domains))) fn();
      });
      const offStatus = control.onStatus((up) => up && fn());
      return () => {
        offEvents();
        offStatus();
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [domains === "any" ? domains : domains.join(",")],
  );
}
