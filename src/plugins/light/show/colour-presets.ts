/**
 * Colour presets (T41; docs/specs/presets-songs-notes.md, « Presets de couleur »): one named colour, apart from the
 * palettes (which stay sets of colours). Stored at the user's choice in the open show (`colours/`, it travels with
 * the show) or in the personal library of this machine (`data/private/colours/`, every show sees it), as the
 * intentions are (T15): the show's wins over a personal one of the same id, and the origin is said. A favourite is
 * a rank carried by the preset itself (decision of 2026-11-16): a personal favourite is one in every show, a show's in
 * that show. Pure: the commands pass the lists.
 */
import { z } from "zod";
import { say } from "../../../core/lang.js";
import { usesOf } from "./references.js";

export const MAX_COLOUR_NAME = 60;
export const MAX_COLOUR_NOTES = 2000;
/** At most this many favourites: a Live widget shows them as buttons. */
export const MAX_FAVORITES = 48;

/**
 * A colour as a look writes it (decision C4): `#rrggbb`, with the white LED's part `+wNN` (0..255) or not, any case,
 * read back in lower case. Never black (review M7): a colour applied black would only switch the fixture off.
 */
export const HexColourSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}(\+[wW]\d{1,3})?$/, { error: () => say("couleur attendue au format #rrggbb (ou #rrggbb+wNN pour la LED blanche)", "colour expected as #rrggbb (or #rrggbb+wNN for the white LED)") })
  .transform((c) => c.toLowerCase())
  .refine((c) => /^#[0-9a-f]{6}\+w\d+$/.test(c) ? Number(c.split("+w")[1]) <= 255 : true, { error: () => say("blanc +wNN : de 0 à 255", "white +wNN: 0 to 255") })
  .refine((c) => !/^#000000(\+w0+)?$/.test(c), { error: () => say("le noir n'est pas une couleur : il éteindrait l'appareil (Blackout ou un fader pour ça)", "black is no colour: it would switch the fixture off (Blackout or a fader for that)") });

/** The `#rrggbb` part of a colour (what a screen shows), without its white LED part. */
export const screenHex = (c: string): string => c.slice(0, 7);

export const ColourPresetSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(MAX_COLOUR_NAME),
  color: HexColourSchema,
  notes: z.string().max(MAX_COLOUR_NOTES).optional(),
  /** Its rank among the favourites (1 first); absent: not a favourite. */
  favorite: z.number().int().min(1).optional(),
});
export type ColourPreset = z.infer<typeof ColourPresetSchema>;

export type ColourOrigin = "show" | "personal";

/** A preset as the open show sees it: where it lives, and, for the show's, whether it covers a personal one of its id. */
export interface ColourEntry extends ColourPreset {
  origin: ColourOrigin;
  /** A show preset of the id of a personal one: that one is hidden while it is there. */
  over?: "personal";
}

/** Every preset the open show sees, by id: the personal library, then the show's over it (the show wins). */
export function stackColours(personal: readonly ColourPreset[], show: readonly ColourPreset[]): Map<string, ColourEntry> {
  const out = new Map<string, ColourEntry>();
  for (const p of personal) out.set(p.id, { ...p, origin: "personal" });
  for (const p of show) out.set(p.id, { ...p, origin: "show", ...(out.has(p.id) ? { over: "personal" as const } : {}) });
  return out;
}

/** A new preset's id: `c-<time base36>-<4 random>` (as intentions, T15b): never derived from the name, free to change. */
export function newColourId(now: number, random: () => number = Math.random): string {
  const tail = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `c-${Math.max(0, Math.floor(now)).toString(36)}-${tail}`;
}

/**
 * The favourites a show sees, in their order: by rank, then by name and id (the library's and the show's interleaved
 * by their ranks; two of one rank, a library's met in another show, by name).
 */
export const favoritesInOrder = <T extends Pick<ColourPreset, "id" | "name" | "favorite">>(entries: Iterable<T>): T[] =>
  [...entries].filter((e) => e.favorite !== undefined).sort((a, b) => a.favorite! - b.favorite! || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

/** A list of ids read once each, in order, empty ones left out. */
export const cleanFavorites = (list: readonly string[]): string[] => [...new Set(list.filter((id) => id.trim() !== ""))];

/**
 * The favourites after one is added, removed or moved: `index` places it (clamped; absent: at the end when added,
 * where it is when already there). Removing one not there changes nothing.
 */
export function withFavorite(list: readonly string[], id: string, favorite: boolean, index?: number): string[] {
  const rest = cleanFavorites(list).filter((x) => x !== id);
  if (!favorite) return rest;
  const at = index === undefined ? (list.includes(id) ? list.indexOf(id) : rest.length) : Math.max(0, Math.min(rest.length, Math.floor(index)));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/**
 * A new order of the favourites: the ids given, in their order, then those not given in their former order (a list
 * read before another screen added one does not lose it). Ids given that are not favourites are refused.
 */
export function reorderFavorites(list: readonly string[], ids: readonly string[]): string[] {
  const now = cleanFavorites(list);
  const unknown = ids.filter((id) => !now.includes(id));
  if (unknown.length) throw new Error(say(`pas dans les favoris : ${unknown.join(", ")}`, `not in the favourites: ${unknown.join(", ")}`));
  const given = cleanFavorites(ids);
  return [...given, ...now.filter((id) => !given.includes(id))];
}

/** What names colour presets in a show: commands of its MIDI mappings and song cues (`colour.apply {id}`), and the favourites it sees. */
export interface ColourCiting {
  mappings: { id: string; label?: string; on: { command: string; args: Record<string, unknown> }; off?: { command: string; args: Record<string, unknown> } }[];
  songs: { id: string; title: string; cues?: { command: string; args: Record<string, unknown> }[] }[];
  favorites: readonly string[];
}

/** Where a preset is used (one line per place, show/references.ts): MIDI mappings and song cues. The favourites are not a use: a delete drops it from them. */
export const colourUses = (id: string, show: Omit<ColourCiting, "favorites">): string[] => usesOf("colour", id, { groups: [], faders: [], dashboards: [], snapshots: [], looks: [], ...show, songs: show.songs.map((s) => ({ sections: [], ...s })) });

/** Every preset id the show cites: the favourites it sees, then what its mappings and cues name. What an archive carries a copy of. */
export function citedColours(show: ColourCiting): string[] {
  const out = new Set(cleanFavorites(show.favorites));
  const add = (command: string, args: Record<string, unknown>) => {
    if (command.startsWith("colour.") && typeof args.id === "string") out.add(args.id);
  };
  for (const m of show.mappings) {
    add(m.on.command, m.on.args);
    if (m.off) add(m.off.command, m.off.args);
  }
  for (const s of show.songs) for (const c of s.cues ?? []) add(c.command, c.args);
  return [...out];
}
