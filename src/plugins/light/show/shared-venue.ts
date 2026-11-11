/**
 * The other shows playing on a venue: a venue's fixtures and their tags are shared by every show
 * on it, so a tag added for one show changes the live groups (by tag) of the others. Read from their
 * folders (data/shows/<id>), never opened: their groups only, as stored. A notice, not a write: a
 * show whose show.json cannot be read is left out (data/show-folders.ts, showsOnVenue).
 */
import path from "node:path";
import { readCollection, showsOnVenue } from "../data/show-folders.js";
import { GroupSchema, type Group } from "./model.js";

/** The groups of each other show on this venue (its name, its groups); an unreadable group is left out. */
export function groupsOfOtherShows(dataRoot: string, current: string, venue: string): { show: string; groups: Group[] }[] {
  return showsOnVenue(dataRoot, venue, current, () => undefined).map(({ id, settings }) => {
    const groups = readCollection(path.join(dataRoot, "shows", id, "groups"), (raw) => {
      const g = GroupSchema.safeParse(raw);
      return g.success ? g.data : undefined;
    });
    return { show: settings.name || id, groups };
  });
}
