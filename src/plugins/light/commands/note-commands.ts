/**
 * Notes on every object: search and set.
 * Part of the show commands (show-commands.ts registers them all, with the scope they share: show-command-scope.ts).
 */
import { z } from "zod";
import { say } from "../../../core/lang.js";
import type { ShowCommandScope } from "./show-command-scope.js";

export function registerNoteCommands(common: ShowCommandScope): void {
  const { reg, show, venue, dashboards } = common;
  // ---- notes everywhere
  const noteCollections = () =>
    ({
      fixtures: venue.fixtures,
      canvases: venue.canvases,
      zones: show.zones,
      rules: show.rules,
      palettes: show.palettes,
      looks: show.looks,
      groups: show.groups,
      songs: show.store.collection("songs", z.object({ id: z.string() }).passthrough()),
      mappings: show.store.collection("mappings", z.object({ id: z.string() }).passthrough()),
      dashboards: dashboards,
    }) as Record<string, { list(): { id: string; name?: string; title?: string; label?: string; notes?: string }[]; get(id: string): unknown; put(v: unknown): unknown }>;
  reg.register({
    name: "notes.search",
    title: "Rechercher dans les notes",
    titleEn: "Search the notes",
    description: "Searches the notes attached to every object (fixtures, zones, looks, groups, songs, mappings, dashboards…). Empty query = every annotated object.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design", "live"],
    schema: z.object({ query: z.string().default("") }),
    run: ({ query }) => {
      const q = query.toLowerCase();
      const out: { collection: string; id: string; name: string; notes: string }[] = [];
      for (const [collection, c] of Object.entries(noteCollections())) {
        for (const o of c.list()) {
          if (!o.notes) continue;
          const name = o.name ?? o.title ?? o.label ?? o.id;
          if (!q || o.notes.toLowerCase().includes(q) || name.toLowerCase().includes(q)) out.push({ collection, id: o.id, name, notes: o.notes });
        }
      }
      return out;
    },
  });
  reg.register({
    name: "notes.set",
    title: "Écrire une note",
    titleEn: "Write a note",
    hints: "D",
    changes: ["notes"],
    description: "Sets (or clears with an empty text) the notes of any object: collection (fixtures, canvases, zones, rules, palettes, looks, groups, songs, mappings, dashboards) and id.",
    right: "show:write",
    profiles: ["setup", "design", "live"],
    schema: z.object({ collection: z.enum(["fixtures", "canvases", "zones", "rules", "palettes", "looks", "groups", "songs", "mappings", "dashboards"]), id: z.string(), notes: z.string() }),
    run: ({ collection, id: oid, notes }) => {
      const c = noteCollections()[collection]!;
      const obj = c.get(oid) as Record<string, unknown> | undefined;
      if (!obj) throw new Error(say(`${collection}/${oid} introuvable`, `${collection}/${oid} not found`));
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      return c.put({ ...obj, notes: notes ? `${notes}${/\(\d{4}-/.test(notes) ? "" : ` (${stamp})`}` : undefined });
    },
  });
}
