/** The activity log of the light plugin (docs/specs/mcp.md): what changed, kept across restarts in a file. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { undoOf, type ActivityLog } from "../activity.js";
import { commandTitle, type CommandRegistry } from "../commands/registry.js";

/** The activity log survives a restart (data/machine/activity.json, the last week). */
export const activityFile = (dataRoot: string): string => path.join(dataRoot, "machine", "activity.json");

/** Reads back the log of the last run; an unreadable file only loses the past lines. */
export function restoreActivity(log: ActivityLog, file: string): void {
  try {
    if (existsSync(file)) log.restore(JSON.parse(readFileSync(file, "utf8")), Date.now());
  } catch {
    /* an unreadable log only loses the past lines */
  }
}

/** Writes the activity log when it changed; never stops the show for it. */
export function writeActivity(log: ActivityLog, file: string): void {
  const lines = log.takeChanges();
  if (!lines) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(lines));
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.warn(`Journal d'activité non enregistré : ${(err as Error).message}`);
  }
}

/**
 * Records every command into the log (an intention's line said by its label), then registers activity.list
 * (in this order: the subscription comes after the plugin's own, as before).
 */
export function wireActivity(commands: CommandRegistry, log: ActivityLog, intentionLabel: (args: unknown) => string | undefined): void {
  commands.onCommand((e) => log.record(e, commands.get(e.name)?.title ?? e.name, e.name.startsWith("intention.") ? intentionLabel(e.args) : undefined));
  commands.register({
    name: "activity.list",
    title: "Activité récente",
    titleEn: "Recent activity",
    description: "What changed (the last week, kept across restarts), newest first: command, who (user name, master token, AI client), from where (ui, midi, osc, mcp, timeline), the object acted on (targetLabel: an intention's label, its id being generated), and whether it worked. A burst of the same command (a fader dragged) is one line with a count. undo, on a change to a look, group, channel fader, dashboard or canvas: what history.undo takes (with the line's at and until) to put it back as it was. collection, on a history.restore or history.undo line: the collection it acted on (such a line on a canvas has an undo too).",
    right: "show:write",
    readOnly: true,
    profiles: ["setup", "design", "live"],
    schema: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
    run: ({ limit }) => {
      const designWrite = (name: string) => {
        const def = commands.get(name);
        return def?.right === "show:write" && !def.readOnly;
      };
      return log.list(limit).map((e) => {
        const undo = undoOf(e, designWrite);
        const def = commands.get(e.name);
        const line = { ...e, ...(def ? { title: commandTitle(def) } : {}) };
        return undo ? { ...line, undo } : line;
      });
    },
  });
}
