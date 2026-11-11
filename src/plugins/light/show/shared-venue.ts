/**
 * The other shows playing on a venue: a venue's fixtures and their tags are shared by every show
 * on it, so a tag added for one show changes the live groups (by tag) of the others. Read from their
 * folders (data/shows/<id>), never opened: their groups only, as stored.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ID_RE } from "../data/store.js";
import { GroupSchema, ShowSettingsSchema, type Group } from "./model.js";

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/** The groups of each other show on this venue (its name, its groups); an unreadable group is left out. */
export function groupsOfOtherShows(showsDir: string, current: string, venue: string): { show: string; groups: Group[] }[] {
  if (!existsSync(showsDir)) return [];
  return readdirSync(showsDir)
    .filter((id) => id !== current && ID_RE.test(id) && statSync(path.join(showsDir, id)).isDirectory())
    .flatMap((id) => {
      const settings = ShowSettingsSchema.safeParse(readJson(path.join(showsDir, id, "show.json")) ?? {});
      if (!settings.success || settings.data.venue !== venue) return [];
      const dir = path.join(showsDir, id, "groups");
      const groups = existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith(".json"))
            .flatMap((f) => {
              const g = GroupSchema.safeParse(readJson(path.join(dir, f)));
              return g.success ? [g.data] : [];
            })
        : [];
      return [{ show: settings.data.name || id, groups }];
    });
}
