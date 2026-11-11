/**
 * The show folders on disk (<dataRoot>/shows/<id>) and the settings each one's show.json holds, read
 * without opening the show. Shared by the file commands (commands/file-commands.ts) and the notice
 * of the other shows on a venue (show/shared-venue.ts): no command layer below them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ID_RE } from "./store.js";
import { ShowSettingsSchema } from "../show/model.js";

export type ShowSettings = z.infer<typeof ShowSettingsSchema>;

/** A show's settings (show.json) as on disk, defaults filled in; throws when the file cannot be read. */
export function settingsOn(dataRoot: string, id: string): ShowSettings {
  const file = path.join(dataRoot, "shows", id, "show.json");
  return ShowSettingsSchema.parse(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
}

/** Why a show.json could not be read, as people read it (a schema error lists its fields). */
export function unreadableWhy(e: unknown): string {
  return e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") : e instanceof Error ? e.message : String(e);
}

/** The show folders under <dataRoot>/shows; a linked folder counts, a dead link or a stray file does not. */
export function showIdsIn(dataRoot: string): string[] {
  const dir = path.join(dataRoot, "shows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => ID_RE.test(d.name) && (d.isDirectory() || (d.isSymbolicLink() && (statSync(path.join(dir, d.name), { throwIfNoEntry: false })?.isDirectory() ?? false))))
    .map((d) => d.name);
}

/**
 * The shows that play on a venue, but `except`, with their settings. A show whose show.json cannot
 * be read is never taken for a show on the default venue: it is left out and handed to `unreadable`
 * (its id and why), which may throw where a write depends on it.
 */
export function showsOnVenue(dataRoot: string, venueId: string, except: string | undefined, unreadable: (id: string, why: string) => void): { id: string; settings: ShowSettings }[] {
  return showIdsIn(dataRoot).flatMap((id) => {
    if (id === except) return [];
    let settings;
    try {
      settings = settingsOn(dataRoot, id);
    } catch (e) {
      unreadable(id, unreadableWhy(e));
      return [];
    }
    return settings.venue === venueId ? [{ id, settings }] : [];
  });
}
