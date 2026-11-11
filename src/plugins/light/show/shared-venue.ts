/**
 * The other shows playing on a venue: a venue's fixtures and their tags are shared by every show
 * on it, so a tag added for one show changes the live groups (by tag) of the others. Read from their
 * folders (data/shows/<id>), never opened: their groups only, as stored. A notice, not a write: a
 * show whose show.json cannot be read is left out (data/show-folders.ts, showsOnVenue).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { showsOnVenue } from "../data/show-folders.js";
import { GroupSchema, type Group } from "./model.js";

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/** The groups of each other show on this venue (its name, its groups); an unreadable group is left out. */
export function groupsOfOtherShows(dataRoot: string, current: string, venue: string): { show: string; groups: Group[] }[] {
  return showsOnVenue(dataRoot, venue, current, () => undefined).map(({ id, settings }) => {
    const dir = path.join(dataRoot, "shows", id, "groups");
    const groups = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".json"))
          .flatMap((f) => {
            const g = GroupSchema.safeParse(readJson(path.join(dir, f)));
            return g.success ? [g.data] : [];
          })
      : [];
    return { show: settings.name || id, groups };
  });
}
