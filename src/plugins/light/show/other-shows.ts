/**
 * The shows of this machine that rely on an intention of its library (T15): an intention of the
 * personal library serves every show, so deleting it must say which shows' songs or looks still name
 * it. Read from their folders (data/shows/<id>), never opened, each show once (data/show-folders.ts
 * readCollection, as show/shared-venue.ts reads their groups); an unreadable file is left out.
 */
import path from "node:path";
import { readCollection, settingsOn, showIdsIn } from "../data/show-folders.js";
import { normalizeMood } from "../knowledge/knowledge.js";
import { IntentionSchema, refKey, type Intention, type IntentionEntry } from "../knowledge/intentions.js";
import { intentionUsesByKey } from "./references.js";
import { colourUses } from "./colour-presets.js";
import { say } from "../../../core/lang.js";

const record = (raw: unknown): Record<string, unknown> | undefined => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const text = (v: unknown, fallback: string): string => (typeof v === "string" && v ? v : fallback);

export interface ShowRef {
  id: string;
  name: string;
}

/**
 * For every intention id, the shows whose songs (mood) or looks (ambiance: tag) name it and that take
 * it from the machine: a show with an intention of its own of that id (a copy, or a mask hiding it)
 * does not, and is left out. Every show folder is read once. `stackFor` (T15b): the intentions that
 * show sees (this machine's under its own), so that a word written by name counts for the id it names
 * there; without it, a word counts by its key.
 */
export function machineIntentionUsers(dataRoot: string, stackFor?: (own: Intention[]) => ReadonlyMap<string, IntentionEntry>): Map<string, ShowRef[]> {
  const users = new Map<string, ShowRef[]>();
  for (const id of showIdsIn(dataRoot)) {
    const dir = path.join(dataRoot, "shows", id);
    // only what the show itself would load (the schema checks the id)
    const ownIntentions = readCollection(path.join(dir, "intentions"), (raw) => {
      const o = IntentionSchema.safeParse(raw);
      return o.success ? o.data : undefined;
    });
    const own = new Set(ownIntentions.map((i) => normalizeMood(i.id)));
    const songs = readCollection(path.join(dir, "songs"), (raw) => {
      const s = record(raw);
      return s && { id: text(s.id, "?"), title: text(s.title, text(s.id, "?")), mood: strings(s.mood), sections: [] };
    });
    const looks = readCollection(path.join(dir, "looks"), (raw) => {
      const l = record(raw);
      return l && { id: text(l.id, "?"), name: text(l.name, text(l.id, "?")), canvas: "", tags: strings(l.tags) };
    });
    const named = [...intentionUsesByKey({ songs, looks }, stackFor ? refKey(stackFor(ownIntentions)) : undefined).keys()].filter((key) => !own.has(key));
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

/** A command a mapping or a song cue runs, read leniently from a show's file. */
const commandOf = (raw: unknown): { command: string; args: Record<string, unknown> } | undefined => {
  const c = record(raw);
  return c && typeof c.command === "string" ? { command: c.command, args: record(c.args) ?? {} } : undefined;
};

/**
 * The other shows of this machine whose MIDI mappings or song cues name the colour preset `id` of the personal library
 * (T41, review M6) and that have none of their own of that id: deleting it leaves them naming an unknown preset. Each
 * line says the show and where (colourUses). `current`: the open show, left out (its own uses are read live).
 */
export function machineColourUsers(dataRoot: string, id: string, current: string): string[] {
  const lines: string[] = [];
  for (const show of showIdsIn(dataRoot)) {
    if (show === current) continue;
    const dir = path.join(dataRoot, "shows", show);
    if (readCollection(path.join(dir, "colours"), (raw) => record(raw)?.id === id || undefined).length) continue;
    const mappings = readCollection(path.join(dir, "mappings"), (raw) => {
      const m = record(raw);
      const on = m && commandOf(m.on);
      return m && on ? { id: text(m.id, "?"), label: text(m.label, text(m.id, "?")), on, ...(commandOf(m.off) ? { off: commandOf(m.off)! } : {}) } : undefined;
    });
    const songs = readCollection(path.join(dir, "songs"), (raw) => {
      const s = record(raw);
      return s && { id: text(s.id, "?"), title: text(s.title, text(s.id, "?")), cues: (Array.isArray(s.cues) ? s.cues : []).flatMap((c) => commandOf(c) ?? []) };
    });
    const uses = colourUses(id, { mappings, songs });
    if (!uses.length) continue;
    let name = show;
    try {
      name = settingsOn(dataRoot, show).name || show;
    } catch {
      /* an unreadable show.json: its folder name */
    }
    lines.push(...uses.map((u) => say(`show « ${name} » : ${u}`, `show “${name}”: ${u}`)));
  }
  return lines;
}
