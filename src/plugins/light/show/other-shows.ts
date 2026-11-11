/**
 * The other shows of this machine that name an intention (T15): an intention of the personal library
 * serves every show, so deleting it must say which other shows' songs or looks still name it. Read
 * from their folders (data/shows/<id>), never opened, as show/shared-venue.ts reads their groups; an
 * unreadable file is left out (a notice, not a write).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { settingsOn, showIdsIn } from "../data/show-folders.js";
import { intentionUses } from "./references.js";

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

const objects = <T>(dir: string, pick: (raw: Record<string, unknown>) => T | undefined): T[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .flatMap((f) => {
          const raw = readJson(path.join(dir, f));
          const item = raw && typeof raw === "object" && !Array.isArray(raw) ? pick(raw as Record<string, unknown>) : undefined;
          return item === undefined ? [] : [item];
        })
    : [];

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const text = (v: unknown, fallback: string): string => (typeof v === "string" && v ? v : fallback);

/** The other shows whose songs (mood) or looks (ambiance: tag) name this intention: their names. */
export function otherShowsUsingIntention(dataRoot: string, current: string, key: string): string[] {
  return showIdsIn(dataRoot).flatMap((id) => {
    if (id === current) return [];
    const dir = path.join(dataRoot, "shows", id);
    const songs = objects(path.join(dir, "songs"), (s) => ({ title: text(s.title, text(s.id, "?")), mood: strings(s.mood) }));
    const looks = objects(path.join(dir, "looks"), (l) => ({ name: text(l.name, text(l.id, "?")), tags: strings(l.tags) }));
    if (!intentionUses(key, { songs: songs.map((s) => ({ id: s.title, sections: [], ...s })), looks: looks.map((l) => ({ id: l.name, canvas: "", ...l })) }).length) return [];
    let name = id;
    try {
      name = settingsOn(dataRoot, id).name || id;
    } catch {
      /* an unreadable show.json: its folder name */
    }
    return [name];
  });
}
