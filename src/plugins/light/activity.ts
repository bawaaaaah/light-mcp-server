/**
 * Activity log: the commands that changed something, who ran them and from where (interface, MIDI,
 * OSC, AI, song timeline), kept in memory since the server started. A burst of the same command on
 * the same object by the same caller (a fader dragged, a CC turned) is one line with a count.
 * Pure: the plugin feeds it the registry's command events.
 */
import type { CommandEvent, Origin } from "./commands/registry.js";

export interface ActivityEntry {
  /** First and last time of the burst. */
  at: number;
  until: number;
  count: number;
  name: string;
  title: string;
  origin: Origin;
  who?: string;
  /** The object acted on (its id), when the arguments name one. */
  target?: string;
  ok: boolean;
  error?: string;
}

/** Repeats closer than this merge into one line. */
export const BURST_MS = 2000;
export const ACTIVITY_MAX = 500;
/** How far back a repeat looks for its line: two faders moved together still merge each. */
const BURST_LOOKBACK = 12;

/** The object a command acts on: an `id`, or the id of the object it carries (look.put { look }…). */
export function targetOf(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  for (const key of ["id", "look", "group", "fader", "dashboard", "song", "setlist", "mapping", "snapshot", "fixture"]) {
    const v = a[key];
    if (typeof v === "string" && v) return v;
    if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") return (v as { id: string }).id;
  }
  return undefined;
}

export class ActivityLog {
  private readonly entries: ActivityEntry[] = [];

  record(e: CommandEvent, title: string): void {
    const target = targetOf(e.args);
    for (let i = this.entries.length - 1; i >= Math.max(0, this.entries.length - BURST_LOOKBACK); i--) {
      const x = this.entries[i]!;
      if (e.at - x.until > BURST_MS) break;
      if (x.name === e.name && x.who === e.who && x.origin === e.origin && x.target === target && x.ok === e.ok) {
        x.until = e.at;
        x.count++;
        return;
      }
    }
    this.entries.push({ at: e.at, until: e.at, count: 1, name: e.name, title, origin: e.origin, ...(e.who ? { who: e.who } : {}), ...(target ? { target } : {}), ok: e.ok, ...(e.error ? { error: e.error } : {}) });
    if (this.entries.length > ACTIVITY_MAX) this.entries.splice(0, this.entries.length - ACTIVITY_MAX);
  }

  /** Newest first. */
  list(limit = 100): ActivityEntry[] {
    return this.entries.slice(-limit).reverse();
  }
}
