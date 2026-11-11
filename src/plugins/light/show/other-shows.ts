/**
 * The shows of this machine that rely on an intention of its library (T15): an intention of the
 * personal library serves every show, so deleting it must say which shows' songs or looks still name
 * it. Read from their folders (data/shows/<id>), never opened, each show once (data/show-folders.ts
 * readCollection, as show/shared-venue.ts reads their groups); an unreadable file is left out.
 */
import path from "node:path";
import { readCollection, settingsOn, showIdsIn } from "../data/show-folders.js";
import { normalizeMood } from "../knowledge/knowledge.js";
import { intentionUsesByKey } from "./references.js";

const record = (raw: unknown): Record<string, unknown> | undefined => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const text = (v: unknown, fallback: string): string => (typeof v === "string" && v ? v : fallback);

export interface ShowRef {
  id: string;
  name: string;
}

/**
 * For every intention key, the shows whose songs (mood) or looks (ambiance: tag) name it and that take
 * it from the machine: a show with an intention of its own of that key (a copy, or a mask hiding it)
 * does not, and is left out. Every show folder is read once.
 */
export function machineIntentionUsers(dataRoot: string): Map<string, ShowRef[]> {
  const users = new Map<string, ShowRef[]>();
  for (const id of showIdsIn(dataRoot)) {
    const dir = path.join(dataRoot, "shows", id);
    const own = new Set(
      readCollection(path.join(dir, "intentions"), (raw) => {
        const o = record(raw);
        return o && typeof o.id === "string" ? normalizeMood(o.id) : undefined;
      }),
    );
    const songs = readCollection(path.join(dir, "songs"), (raw) => {
      const s = record(raw);
      return s && { id: text(s.id, "?"), title: text(s.title, text(s.id, "?")), mood: strings(s.mood), sections: [] };
    });
    const looks = readCollection(path.join(dir, "looks"), (raw) => {
      const l = record(raw);
      return l && { id: text(l.id, "?"), name: text(l.name, text(l.id, "?")), canvas: "", tags: strings(l.tags) };
    });
    const named = [...intentionUsesByKey({ songs, looks }).keys()].filter((key) => !own.has(key));
    if (!named.length) continue;
    let name = id;
    try {
      name = settingsOn(dataRoot, id).name || id;
    } catch {
      /* an unreadable show.json: its folder name */
    }
    for (const key of named) users.set(key, [...(users.get(key) ?? []), { id, name }]);
  }
  return users;
}
