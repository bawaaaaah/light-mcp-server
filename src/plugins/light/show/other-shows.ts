/**
 * The other shows of this machine that name an intention (T15): an intention of the personal library
 * serves every show, so deleting it must say which other shows' songs or looks still name it. Read
 * from their folders (data/shows/<id>), never opened, as show/shared-venue.ts reads their groups; an
 * unreadable file is left out (a notice, not a write).
 */
import path from "node:path";
import { readCollection, settingsOn, showIdsIn } from "../data/show-folders.js";
import { normalizeMood } from "../knowledge/knowledge.js";
import { intentionUses } from "./references.js";

const record = (raw: unknown): Record<string, unknown> | undefined => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const text = (v: unknown, fallback: string): string => (typeof v === "string" && v ? v : fallback);

/**
 * The other shows whose songs (mood) or looks (ambiance: tag) name this intention, by name. A show
 * with its own visible intention of that key does not lose anything when the library's goes: left out.
 */
export function otherShowsUsingIntention(dataRoot: string, current: string, key: string): string[] {
  return showIdsIn(dataRoot).flatMap((id) => {
    if (id === current) return [];
    const dir = path.join(dataRoot, "shows", id);
    const ownsIt = readCollection(path.join(dir, "intentions"), (raw) => {
      const o = record(raw);
      return o && typeof o.id === "string" && normalizeMood(o.id) === key && o.hidden !== true ? true : undefined;
    }).length;
    if (ownsIt) return [];
    const songs = readCollection(path.join(dir, "songs"), (raw) => {
      const s = record(raw);
      return s && { id: text(s.id, "?"), title: text(s.title, text(s.id, "?")), mood: strings(s.mood), sections: [] };
    });
    const looks = readCollection(path.join(dir, "looks"), (raw) => {
      const l = record(raw);
      return l && { id: text(l.id, "?"), name: text(l.name, text(l.id, "?")), canvas: "", tags: strings(l.tags) };
    });
    if (!intentionUses(key, { songs, looks }).length) return [];
    let name = id;
    try {
      name = settingsOn(dataRoot, id).name || id;
    } catch {
      /* an unreadable show.json: its folder name */
    }
    return [name];
  });
}
