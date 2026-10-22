/**
 * Activity log: the commands that changed something, who ran them and from where (interface, MIDI,
 * OSC, AI, song timeline). A burst of the same command on
 * the same object by the same caller (a fader dragged, a CC turned) is one line with a count.
 * Pure: the plugin feeds it the registry's command events, and keeps the last week in
 * data/machine/activity.json across restarts.
 */
import { z } from "zod";
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
/** Lines older than this are not read back after a restart. */
export const ACTIVITY_KEEP_MS = 7 * 86_400_000;

const EntrySchema = z.object({
  at: z.number(),
  until: z.number(),
  count: z.number().int().min(1),
  name: z.string(),
  title: z.string(),
  origin: z.enum(["ui", "midi", "osc", "os2l", "mcp", "timeline", "cli", "system"]),
  who: z.string().optional(),
  target: z.string().optional(),
  ok: z.boolean(),
  error: z.string().optional(),
});

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

/** The collections whose changes history.undo takes back, by command prefix (look.put → looks). */
const UNDOABLE = { look: "looks", group: "groups", fader: "faders", dashboard: "dashboards" } as const;
export type UndoableCollection = (typeof UNDOABLE)[keyof typeof UNDOABLE];

/**
 * What history.undo would take back for an activity line: a design change that worked, on a named
 * look, group, channel fader or dashboard (`designWrite` tells a design command from a live one:
 * a fader moved is state, not a change to undo).
 */
export function undoOf(e: ActivityEntry, designWrite: (name: string) => boolean): { collection: UndoableCollection; id: string } | undefined {
  const collection = UNDOABLE[e.name.split(".")[0] as keyof typeof UNDOABLE];
  return collection && e.ok && e.target && designWrite(e.name) ? { collection, id: e.target } : undefined;
}

/** Arguments longer than this stay off the broadcast: an import carries a whole QLC+ workspace. */
export const ARGS_BROADCAST_MAX = 2048;

/**
 * A command event as every open page receives it (topic light:command): what ran, from where, on
 * which object and whether it worked; the arguments only when short; never who ran it (the
 * activity log, with its right, says that).
 */
export function commandNotice(e: CommandEvent): { name: string; origin: Origin; ok: boolean; at: number; error?: string; target?: string; args?: unknown } {
  const target = targetOf(e.args);
  const short = JSON.stringify(e.args ?? {}).length <= ARGS_BROADCAST_MAX;
  return { name: e.name, origin: e.origin, ok: e.ok, at: e.at, ...(e.error ? { error: e.error } : {}), ...(target ? { target } : {}), ...(short ? { args: e.args } : {}) };
}

export class ActivityLog {
  private readonly entries: ActivityEntry[] = [];
  private changed = false;

  record(e: CommandEvent, title: string): void {
    const target = targetOf(e.args);
    for (let i = this.entries.length - 1; i >= Math.max(0, this.entries.length - BURST_LOOKBACK); i--) {
      const x = this.entries[i]!;
      if (e.at - x.until > BURST_MS) break;
      if (x.name === e.name && x.who === e.who && x.origin === e.origin && x.target === target && x.ok === e.ok) {
        x.until = e.at;
        x.count++;
        this.changed = true;
        return;
      }
    }
    this.entries.push({ at: e.at, until: e.at, count: 1, name: e.name, title, origin: e.origin, ...(e.who ? { who: e.who } : {}), ...(target ? { target } : {}), ok: e.ok, ...(e.error ? { error: e.error } : {}) });
    if (this.entries.length > ACTIVITY_MAX) this.entries.splice(0, this.entries.length - ACTIVITY_MAX);
    this.changed = true;
  }

  /** The lines to write (oldest first) when they changed since the last call, else undefined. */
  takeChanges(): ActivityEntry[] | undefined {
    if (!this.changed) return undefined;
    this.changed = false;
    return [...this.entries];
  }

  /** Lines read back after a restart: valid ones of the last week, before anything new. */
  restore(saved: unknown, now: number, keepMs = ACTIVITY_KEEP_MS): void {
    const lines = (Array.isArray(saved) ? saved : []).flatMap((x) => {
      const p = EntrySchema.safeParse(x);
      return p.success && now - p.data.until <= keepMs ? [p.data as ActivityEntry] : [];
    });
    this.entries.unshift(...lines.slice(-ACTIVITY_MAX));
    if (this.entries.length > ACTIVITY_MAX) this.entries.splice(0, this.entries.length - ACTIVITY_MAX);
  }

  /** Newest first. */
  list(limit = 100): ActivityEntry[] {
    return this.entries.slice(-limit).reverse();
  }
}
