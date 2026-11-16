/**
 * Colour presets (T41; docs/specs/presets-songs-notes.md, « Presets de couleur »): list, create or change, delete,
 * favourites and their order, and the colour applied by hand to fixtures or a group (the manual colour layer of the
 * runtime, show/manual-colour.ts). The presets live in the show or in the personal library (show/colour-presets.ts);
 * MCP, HTTP, OSC and the CLI are generated from these commands.
 */
import { z } from "zod";
import { CommandError, type CommandRegistry } from "./registry.js";
import type { ShowRuntime } from "../show/runtime.js";
import type { Collection } from "../data/store.js";
import { inUseMessage } from "../show/references.js";
import {
  ColourPresetSchema,
  colourUses,
  favoritesInOrder,
  HexColourSchema,
  MAX_COLOUR_NAME,
  MAX_COLOUR_NOTES,
  MAX_FAVORITES,
  newColourId,
  reorderFavorites,
  stackColours,
  withFavorite,
  type ColourCiting,
  type ColourEntry,
  type ColourPreset,
} from "../show/colour-presets.js";
import { MANUAL_COLOUR_FADE_MS } from "../show/manual-colour.js";
import { say } from "../../../core/lang.js";

/** Where the presets live, and what names them in the open show. */
export interface ColourStores {
  show: Collection<ColourPreset>;
  personal: Collection<ColourPreset>;
  /** The show's MIDI mappings and songs (opened by the plugin with their own schemas). */
  citing: () => Omit<ColourCiting, "favorites">;
  /** A new preset's id; `newColourId` at the time of the call by default (injectable). */
  newId?: () => string;
}

const Scope = z.enum(["show", "personal"]);

/** The store an entry lives in. */
const storeOf = (stores: ColourStores, e: Pick<ColourEntry, "origin">) => (e.origin === "personal" ? stores.personal : stores.show);

/**
 * Writes the favourites as ranks on the presets themselves (decision of 2026-11-16): 1, 2, 3… in the order given,
 * and no rank on the visible presets left out. Only the presets whose rank changes are written (each in its store).
 */
function writeRanks(stores: ColourStores, order: readonly string[]): void {
  const stack = stackColours(stores.personal.list(), stores.show.list());
  for (const e of stack.values()) {
    const at = order.indexOf(e.id);
    const rank = at >= 0 ? at + 1 : undefined;
    if (e.favorite === rank) continue;
    const store = storeOf(stores, e);
    const { favorite: _old, ...rest } = store.get(e.id)!;
    store.put(rank === undefined ? rest : { ...rest, favorite: rank });
  }
}

/**
 * The favourites of a show written before T41's decision 3 (an ordered `colourFavorites` in show.json) become ranks on
 * the presets, in that order after the favourites they already carry; the list is then dropped from show.json.
 */
export function migrateColourFavorites(show: ShowRuntime, stores: ColourStores): void {
  const legacy = show.settings.colourFavorites;
  if (!legacy?.length) return;
  const stack = stackColours(stores.personal.list(), stores.show.list());
  const now = favoritesInOrder(stack.values()).map((e) => e.id);
  writeRanks(stores, [...now, ...legacy.filter((id) => stack.has(id) && !now.includes(id))].slice(0, MAX_FAVORITES));
  show.saveSettings({ colourFavorites: undefined });
}

export function registerColourPresetCommands(reg: CommandRegistry, show: ShowRuntime, stores: ColourStores): void {
  const stack = () => {
    migrateColourFavorites(show, stores);
    return stackColours(stores.personal.list(), stores.show.list());
  };
  const favorites = () => favoritesInOrder(stack().values()).map((e) => e.id);
  const saveFavorites = (list: string[]) => {
    if (list.length > MAX_FAVORITES) throw new CommandError("invalid", say(`${MAX_FAVORITES} favoris au plus`, `${MAX_FAVORITES} favourites at most`));
    writeRanks(stores, list);
    return list;
  };
  const get = (id: string): ColourEntry => {
    const e = stack().get(id);
    if (!e) throw new CommandError("unknown", say(`preset de couleur inconnu : ${id}`, `unknown colour preset: ${id}`));
    return e;
  };
  const freshId = (): string => {
    for (let tries = 0; tries < 100; tries++) {
      const id = stores.newId?.() ?? newColourId(Date.now());
      if (!stores.show.has(id) && !stores.personal.has(id)) return id;
    }
    throw new CommandError("failed", say("pas d'id libre pour un nouveau preset de couleur", "no free id for a new colour preset"));
  };
  const describe = (e: ColourEntry) => ({ ...e, usedBy: colourUses(e.id, stores.citing()) });

  reg.register({
    name: "colour.preset.list",
    title: "Presets de couleur",
    description:
      "Colour presets the open show sees: one named colour each (#rrggbb), apart from the palettes. origin: show (stored in the open show, travels with it) or personal (the personal library of this machine, every show sees it); a show preset of the id of a personal one hides it (over: personal). favorite: its rank among the favourites (absent: not one), carried by the preset itself: a favourite of the personal library is one in every show, one of the show in this show. usedBy: MIDI mappings and song cues naming it. favorites: the favourite ids the open show sees, in their order (by rank, then name: the library's and the show's interleaved by their ranks).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design", "live"],
    schema: z.object({}),
    run: () => {
      const all = [...stack().values()];
      return { presets: all.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map(describe), favorites: favoritesInOrder(all).map((e) => e.id) };
    },
  });

  reg.register({
    name: "colour.preset.put",
    title: "Preset de couleur",
    description: `Creates or changes a colour preset: name (${MAX_COLOUR_NAME} characters at most), color (#rrggbb), notes. scope "show" (default) stores it in the open show; "personal" in the personal library of this machine (every show sees it, and a show's .lightshow archive carries a copy of the ones it cites: favourites, MIDI mappings, song cues). Without id: a creation, with a generated id (c-…, returned). With an id: that preset is written in that scope (an edit; or a copy of a personal one into the show, which then wins over it, or of a show one into the library). favorite: true makes it a favourite (last), false takes it out; absent: it stays as it was (a copy keeps the rank of what it copies). Versions of the show's presets are kept (history.list colours).`,
    right: "show:write",
    profiles: ["design"],
    schema: z.object({
      preset: z.object({ id: z.string().min(1).max(64).optional(), name: z.string().max(MAX_COLOUR_NAME), color: HexColourSchema, notes: z.string().max(MAX_COLOUR_NOTES).optional() }),
      scope: Scope.default("show"),
      favorite: z.boolean().optional(),
    }),
    run: ({ preset, scope, favorite }) => {
      const target = scope === "personal" ? stores.personal : stores.show;
      if (preset.id !== undefined && !/^[a-z0-9][a-z0-9_-]*$/.test(preset.id)) throw new CommandError("invalid", say(`id invalide : « ${preset.id} » (lettres minuscules, chiffres, - et _)`, `invalid id: “${preset.id}” (lower-case letters, digits, - and _)`));
      const id = preset.id ?? freshId();
      // its favourite rank is kept by an edit and by a copy into the other place (decision 3: the preset carries it)
      const rank = target.get(id)?.favorite ?? stack().get(id)?.favorite;
      try {
        target.put(ColourPresetSchema.parse({ ...preset, id, ...(rank === undefined ? {} : { favorite: rank }) }));
      } catch (err) {
        if (err instanceof z.ZodError) throw new CommandError("invalid", err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
        throw err;
      }
      if (favorite !== undefined) saveFavorites(withFavorite(favorites(), id, favorite));
      const entry = stack().get(id)!;
      return { preset: describe(entry), scope, ...(scope === "personal" && entry.origin === "show" ? { shadowedBy: "show" } : {}) };
    },
  });

  reg.register({
    name: "colour.preset.delete",
    title: "Supprimer un preset de couleur",
    description:
      "Deletes a colour preset by id. scope: \"show\" the show's own only, \"personal\" the personal library's (for every show of this machine), none: the one the open show sees. Refused while MIDI mappings or song cues of the open show name it and it would become unknown, unless force (the error names them, detail.uses). A show preset covering a personal one of its id gives that one back (reverted), favourite or not as that one is.",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ id: z.string(), scope: Scope.optional(), force: z.boolean().default(false) }),
    run: ({ id, scope, force }) => {
      const seen = stack().get(id);
      const origin = scope ?? seen?.origin;
      const from = origin === "personal" ? stores.personal : stores.show;
      const own = from.get(id);
      if (!own || !origin) throw new CommandError("unknown", say(`preset de couleur inconnu : ${id}`, `unknown colour preset: ${id}`));
      // the other place may still hold one of that id: then nothing names an unknown preset
      const left = origin === "show" ? stores.personal.has(id) : stores.show.has(id);
      const uses = left ? [] : colourUses(id, stores.citing());
      if (uses.length && !force) throw new CommandError("invalid", inUseMessage(own.name, uses), { uses });
      from.delete(id);
      return { id, action: left && origin === "show" ? ("reverted" as const) : ("deleted" as const), scope: origin, usedBy: uses };
    },
  });

  reg.register({
    name: "colour.preset.favorite",
    title: "Favori de couleur",
    description: `Makes a colour preset a favourite (favorite: true; index places it among the favourites the open show sees, absent: last, or where it already is), moves it (with index) or takes it out (favorite: false). The rank is carried by the preset: a personal one is a favourite in every show of this machine, a show one in this show. The favourites seen are numbered again 1, 2, 3… (the presets whose rank changes are written). ${MAX_FAVORITES} favourites at most. Returns the favourites in their order.`,
    right: "show:write",
    profiles: ["design", "live"],
    schema: z.object({ id: z.string(), favorite: z.boolean().default(true), index: z.number().int().min(0).optional() }),
    run: ({ id, favorite, index }) => {
      if (favorite) get(id);
      return { favorites: saveFavorites(withFavorite(favorites(), id, favorite, index)) };
    },
  });

  reg.register({
    name: "colour.preset.order",
    title: "Ordre des favoris de couleur",
    description: "Puts the favourite colour presets the open show sees in this order: the ids given first, in their order, then the favourites not given, as they were (refused when an id given is not a favourite); their ranks are written on the presets (a personal one keeps its rank in the other shows). Returns the favourites in their order.",
    right: "show:write",
    profiles: ["design", "live"],
    schema: z.object({ ids: z.array(z.string()).max(MAX_FAVORITES) }),
    run: ({ ids }) => {
      try {
        return { favorites: saveFavorites(reorderFavorites(favorites(), ids)) };
      } catch (err) {
        if (err instanceof CommandError) throw err;
        throw new CommandError("invalid", (err as Error).message);
      }
    },
  });

  /** The fixtures a selection names (a group: its members, sub-groups and selector included), each once; none given: every patched fixture. */
  const fixturesOf = (fixtures: string[] | undefined, group: string | undefined): string[] => {
    if (group !== undefined && !show.groups.get(group)) throw new CommandError("unknown", say(`groupe inconnu : ${group}`, `unknown group: ${group}`));
    const every = fixtures === undefined && group === undefined;
    const ids = every ? show.venue.fixtures.list().map((f) => f.id) : [...new Set([...(fixtures ?? []), ...(group !== undefined ? show.fixturesOf(group) : [])])];
    for (const f of ids) if (!show.venue.fixtures.get(f)) throw new CommandError("unknown", say(`appareil inconnu : ${f}`, `unknown fixture: ${f}`));
    if (!ids.length) throw new CommandError("invalid", say("aucun appareil dans cette sélection", "no fixture in this selection"));
    return ids;
  };
  /** Whether a colour can show on a fixture: it mixes colours, or its colour wheel answers them. */
  const colourable = (f: string): string | undefined => {
    const r = show.venue.resolve(f);
    if ("error" in r) return r.error;
    if (!r.lampOnly || show.venue.hasWheel(f)) return undefined;
    return say("ni mélange de couleurs ni roue de couleurs", "neither colour mixing nor a colour wheel");
  };
  const Selection = { fixtures: z.array(z.string()).optional(), group: z.string().optional() };
  const Fade = z.number().min(0).max(30).optional().describe(`fade in seconds (default ${MANUAL_COLOUR_FADE_MS / 1000}; 0 = cut)`);

  reg.register({
    name: "colour.apply",
    title: "Appliquer une couleur",
    description: `Applies a colour by hand to fixtures, a group (its members) or, given neither, every patched fixture: a colour preset (id) or a colour (#rrggbb). The manual colour layer (decision of 2026-11-16): above the looks, it REPLACES the colour they paint on those fixtures, at the brightness they paint it (the looks, the faders and the DCAs keep the light: a head no look lights stays dark), rendered as a look's colour is (red, green and blue; white, amber and UV at 0; a colour wheel takes its slot nearest to it, with the venue's corrected slot colours). It fades in from what showed (fade, seconds, default ${MANUAL_COLOUR_FADE_MS / 1000}) and holds until colour.release, the Panic, or a new look started on those fixtures. Fixtures without colour mixing nor a colour wheel, or absent from the show, are returned in skipped.`,
    // a play action, like launching a look: the volunteer who may launch looks may colour them
    right: "commands:trigger",
    profiles: ["live", "design"],
    schema: z.object({ id: z.string().optional().describe("a colour preset"), color: HexColourSchema.optional().describe("or a colour"), fade: Fade, ...Selection }),
    run: ({ id, color, fade, fixtures, group }) => {
      if ((id === undefined) === (color === undefined)) throw new CommandError("invalid", say("donner un preset (id) ou une couleur (color), l'un des deux", "give a preset (id) or a colour (color), one of the two"));
      const hex = color ?? get(id!).color;
      const ok: string[] = [];
      const skipped: { fixture: string; error: string }[] = [];
      for (const f of fixturesOf(fixtures, group)) {
        const why = show.venue.absent.has(f) ? say("absent de ce show", "absent from this show") : colourable(f);
        if (why) skipped.push({ fixture: f, error: why });
        else ok.push(f);
      }
      if (!ok.length && skipped.length) throw new CommandError("failed", say(`couleur appliquée à aucun appareil : ${skipped.map((x) => `${x.fixture} (${x.error})`).join(" ; ")}`, `colour applied to no fixture: ${skipped.map((x) => `${x.fixture} (${x.error})`).join("; ")}`), { skipped });
      const applied = show.setColour(ok, hex, (fade ?? MANUAL_COLOUR_FADE_MS / 1000) * 1000);
      return { color: hex, ...(id ? { id } : {}), applied, skipped };
    },
  });

  reg.register({
    name: "colour.applied",
    title: "Couleurs appliquées",
    description: "The colours applied by hand now (colour.apply), by fixture id: #rrggbb. A fixture whose colour is fading back to the looks is not listed.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["live", "design"],
    schema: z.object({}),
    run: () => Object.fromEntries(show.venue.fixtures.list().flatMap((f) => {
      const hex = show.manualColour(f.id);
      return hex ? [[f.id, hex] as const] : [];
    })),
  });

  reg.register({
    name: "colour.release",
    title: "Rendre la couleur",
    description: `Gives the looks their colour back on fixtures, a group or, given neither, every fixture holding a colour applied by hand (colour.apply), fading (fade, seconds, default ${MANUAL_COLOUR_FADE_MS / 1000}). Returns the fixtures released.`,
    right: "commands:trigger",
    profiles: ["live", "design"],
    schema: z.object({ fade: Fade, ...Selection }),
    run: ({ fade, fixtures, group }) => {
      const ms = (fade ?? MANUAL_COLOUR_FADE_MS / 1000) * 1000;
      return { released: show.releaseColours(fixtures === undefined && group === undefined ? undefined : fixturesOf(fixtures, group), ms) };
    },
  });
}
