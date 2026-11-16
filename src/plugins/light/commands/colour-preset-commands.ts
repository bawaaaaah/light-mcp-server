/**
 * Colour presets (T41; docs/specs/presets-songs-notes.md, « Presets de couleur »): list, create or change, delete,
 * favourites and their order, and the colour applied by hand to fixtures or a group. The presets live in the show or
 * in the personal library (show/colour-presets.ts); MCP, HTTP, OSC and the CLI are generated from these commands.
 */
import { z } from "zod";
import { CommandError, type CommandRegistry } from "./registry.js";
import type { ShowRuntime } from "../show/runtime.js";
import type { Collection } from "../data/store.js";
import { channelFaderId, ownChannelFader } from "../show/channel-faders.js";
import { inUseMessage } from "../show/references.js";
import {
  cleanFavorites,
  ColourPresetSchema,
  colourUses,
  HexColourSchema,
  MAX_COLOUR_NAME,
  MAX_COLOUR_NOTES,
  MAX_FAVORITES,
  newColourId,
  reorderFavorites,
  rgbOf,
  stackColours,
  withFavorite,
  type ColourCiting,
  type ColourEntry,
  type ColourPreset,
} from "../show/colour-presets.js";
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
/** The colour components a preset sets on a fixture's channel faders (the other colour channels are left as they are). */
const RGB = ["red", "green", "blue"] as const;

export function registerColourPresetCommands(reg: CommandRegistry, show: ShowRuntime, stores: ColourStores): void {
  const stack = () => stackColours(stores.personal.list(), stores.show.list());
  const favorites = () => cleanFavorites(show.settings.colourFavorites);
  const saveFavorites = (list: string[]) => {
    if (list.length > MAX_FAVORITES) throw new CommandError("invalid", say(`${MAX_FAVORITES} favoris au plus`, `${MAX_FAVORITES} favourites at most`));
    show.saveSettings({ colourFavorites: list });
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
  const describe = (e: ColourEntry, favs: string[]) => {
    const at = favs.indexOf(e.id);
    return { ...e, ...(at >= 0 ? { favorite: at } : {}), usedBy: colourUses(e.id, stores.citing()) };
  };

  reg.register({
    name: "colour.preset.list",
    title: "Presets de couleur",
    description:
      "Colour presets the open show sees: one named colour each (#rrggbb), apart from the palettes. origin: show (stored in the open show, travels with it) or personal (the personal library of this machine, every show sees it); a show preset of the id of a personal one hides it (over: personal). favorite: its rank in the show's favourites (absent: not one). usedBy: MIDI mappings and song cues naming it. favorites: the show's favourite ids in their order (missing: favourites this machine does not have, a personal one of another machine).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design", "live"],
    schema: z.object({}),
    run: () => {
      const all = stack();
      const favs = favorites();
      return { presets: [...all.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map((e) => describe(e, favs)), favorites: favs.filter((id) => all.has(id)), missing: favs.filter((id) => !all.has(id)) };
    },
  });

  reg.register({
    name: "colour.preset.put",
    title: "Preset de couleur",
    description: `Creates or changes a colour preset: name (${MAX_COLOUR_NAME} characters at most), color (#rrggbb), notes. scope "show" (default) stores it in the open show; "personal" in the personal library of this machine (every show sees it, and a show's .lightshow archive carries a copy of the ones it cites: favourites, MIDI mappings, song cues). Without id: a creation, with a generated id (c-…, returned). With an id: that preset is written in that scope (an edit; or a copy of a personal one into the show, which then wins over it, or of a show one into the library). favorite: true adds it to the show's favourites (at the end), false removes it. Versions of the show's presets are kept (history.list colours).`,
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
      try {
        target.put(ColourPresetSchema.parse({ ...preset, id }));
      } catch (err) {
        if (err instanceof z.ZodError) throw new CommandError("invalid", err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
        throw err;
      }
      if (favorite !== undefined) saveFavorites(withFavorite(favorites(), id, favorite));
      const entry = stack().get(id)!;
      return { preset: describe(entry, favorites()), scope, ...(scope === "personal" && entry.origin === "show" ? { shadowedBy: "show" } : {}) };
    },
  });

  reg.register({
    name: "colour.preset.delete",
    title: "Supprimer un preset de couleur",
    description:
      "Deletes a colour preset by id. scope: \"show\" the show's own only, \"personal\" the personal library's (for every show of this machine), none: the one the open show sees. Refused while MIDI mappings or song cues of the open show name it and it would become unknown, unless force (the error names them, detail.uses). A show preset covering a personal one of its id gives that one back (reverted). When nothing of that id is left, it leaves the show's favourites.",
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
      if (!left && favorites().includes(id)) saveFavorites(withFavorite(favorites(), id, false));
      return { id, action: left && origin === "show" ? ("reverted" as const) : ("deleted" as const), scope: origin, usedBy: uses };
    },
  });

  reg.register({
    name: "colour.preset.favorite",
    title: "Favori de couleur",
    description: `Adds a colour preset to the show's favourites (favorite: true; index places it, absent: at the end, or where it already is), moves it (with index) or removes it (favorite: false). ${MAX_FAVORITES} favourites at most. Returns the favourites in their order.`,
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
    description: "Puts the show's favourite colour presets in this order: the ids given first, in their order, then the favourites not given, as they were (refused when an id given is not a favourite). Returns the favourites in their order.",
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
  /** The red, green and blue channels of a fixture's full heads (an accent head, a halo, is left out), with their names. */
  const rgbChannels = (fixture: string): { offset: number; comp: (typeof RGB)[number]; name: string }[] | { error: string } => {
    const r = show.venue.resolve(fixture);
    if ("error" in r) return { error: r.error };
    const out: { offset: number; comp: (typeof RGB)[number]; name: string }[] = [];
    for (const [head, comps] of r.heads) {
      if (r.accent.has(head)) continue;
      for (const comp of RGB) {
        const offset = comps[comp];
        if (offset !== undefined) out.push({ offset, comp, name: r.mode.channels[offset] ?? String(offset + 1) });
      }
    }
    return out.length ? out : { error: say("pas de canaux rouge, vert et bleu (roue de couleurs ou lampe : pas encore pris en charge)", "no red, green and blue channels (a colour wheel or a lamp: not handled yet)") };
  };
  /** Sets the channel faders of these channels (created at the first use, as the fixture panel does) at their levels. */
  const setFaders = (fixture: string, rows: { offset: number; name: string; level: number }[], create: boolean) => {
    const patchName = show.venue.fixtures.get(fixture)?.name ?? fixture;
    let n = 0;
    for (const row of rows) {
      const own = ownChannelFader(show.faders.list(), fixture, row.offset);
      if (own) {
        show.faders.putLive({ ...own, level: row.level });
        n++;
      } else if (create) {
        show.faders.put({ id: channelFaderId(show.faders.list(), fixture, row.offset), name: `${patchName} · ${row.name}`, channels: [{ fixture, offset: row.offset }], level: row.level });
        n++;
      }
    }
    return n;
  };
  const Selection = { fixtures: z.array(z.string()).optional(), group: z.string().optional() };

  reg.register({
    name: "colour.apply",
    title: "Appliquer une couleur",
    description:
      "Applies a colour by hand to fixtures, a group (its members) or, given neither, every patched fixture: a colour preset (id) or a colour (#rrggbb). Provisional (T41, to be confirmed by the user): it sets the channel faders of the red, green and blue channels of each fixture's full heads, as the fixture panel's faders do (created at the first use, id panel-<fixture>-<offset>): the highest value wins over the looks channel by channel (HTP), dosed by the DCAs, until colour.release or the faders are moved. Other colour channels (white, amber, UV), the dimmer and a colour wheel are left as they are; fixtures without red, green and blue channels are returned in skipped.",
    right: "commands:level",
    profiles: ["live", "design"],
    schema: z.object({ id: z.string().optional().describe("a colour preset"), color: HexColourSchema.optional().describe("or a colour"), ...Selection }),
    run: ({ id, color, fixtures, group }) => {
      if ((id === undefined) === (color === undefined)) throw new CommandError("invalid", say("donner un preset (id) ou une couleur (color), l'un des deux", "give a preset (id) or a colour (color), one of the two"));
      const hex = color ?? get(id!).color;
      const rgb = rgbOf(hex);
      const applied: string[] = [];
      const skipped: { fixture: string; error: string }[] = [];
      for (const f of fixturesOf(fixtures, group)) {
        if (show.venue.absent.has(f)) {
          skipped.push({ fixture: f, error: say("absent de ce show", "absent from this show") });
          continue;
        }
        const ch = rgbChannels(f);
        if ("error" in ch) {
          skipped.push({ fixture: f, error: ch.error });
          continue;
        }
        setFaders(f, ch.map((c) => ({ offset: c.offset, name: c.name, level: rgb[c.comp] })), true);
        applied.push(f);
      }
      if (!applied.length && skipped.length) throw new CommandError("failed", say(`couleur appliquée à aucun appareil : ${skipped.map((s) => `${s.fixture} (${s.error})`).join(" ; ")}`, `colour applied to no fixture: ${skipped.map((s) => `${s.fixture} (${s.error})`).join("; ")}`), { skipped });
      return { color: hex, ...(id ? { id } : {}), applied, skipped };
    },
  });

  reg.register({
    name: "colour.release",
    title: "Rendre la couleur",
    description: "Takes back a colour applied by hand (colour.apply) on fixtures, a group or, given neither, every patched fixture: the channel faders of their red, green and blue channels go back to 0, so the looks show again. Faders that do not exist are not created.",
    right: "commands:level",
    profiles: ["live", "design"],
    schema: z.object(Selection),
    run: ({ fixtures, group }) => {
      const released: string[] = [];
      for (const f of fixturesOf(fixtures, group)) {
        const ch = rgbChannels(f);
        if ("error" in ch) continue;
        if (setFaders(f, ch.map((c) => ({ offset: c.offset, name: c.name, level: 0 })), false)) released.push(f);
      }
      return { released };
    },
  });
}
