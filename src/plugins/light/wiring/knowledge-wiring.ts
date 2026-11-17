/**
 * The colour knowledge of the light plugin: the layers of intentions (T15: shipped, private file, personal library,
 * show) and the colour presets (T41: show, personal library), with what the songs, the activity log and the
 * archives read of them.
 */
import path from "node:path";
import type { ColourStores } from "../commands/colour-preset-commands.js";
import { freshIntentionId, intentionReferences, showStack, type IntentionStores } from "../commands/design-commands.js";
import type { ShowCommandOptions } from "../commands/show-command-scope.js";
import type { SongServices } from "../commands/song-commands.js";
import type { RestoreTargets } from "../data/archive.js";
import { FolderStore, stableStringify, type Collection } from "../data/store.js";
import { loadKnowledgeLayers, type KnowledgeLayers } from "../knowledge/knowledge.js";
import { AMBIANCE, ambiguousRefs, embeddedIntentions, IntentionSchema, labelOfRef, labelsOfRefs, migrateMood, migrateTags, newIntentionId, refKey, stackIntentions } from "../knowledge/intentions.js";
import type { Mapping } from "../midi/mapping.js";
import { citedColours, ColourPresetSchema, favoritesInOrder, newColourId, stackColours } from "../show/colour-presets.js";
import { machineColourUsers, machineIntentionUsers } from "../show/other-shows.js";
import { intentionUsesByKey } from "../show/references.js";
import type { Look } from "../show/model.js";
import type { Song } from "../songs/songs.js";
import { say } from "../../../core/lang.js";

export interface KnowledgeDeps {
  dataRoot: string;
  /** The open show's folder. */
  show: FolderStore;
  /** The open show's id, read at the time of the call. */
  currentShow: () => string;
  now?: () => number;
}

/**
 * The personal library (every show of this machine; its history pruned with the shows', backups/private/library)
 * and the intentions (T15): the files read once, the personal library's and the show's own read at every call.
 */
export function openIntentions(deps: KnowledgeDeps): { personal: FolderStore; intentions: IntentionStores } {
  const { dataRoot, show } = deps;
  const knowledgePath = path.join(dataRoot, "private", "knowledge.json");
  let kb: KnowledgeLayers | undefined;
  // an unreadable private file: the shipped base alone, said by show.lint; nothing migrates meanwhile (T15b)
  let privateError: string | undefined;
  const readBase = (): KnowledgeLayers => {
    try {
      return loadKnowledgeLayers(knowledgePath);
    } catch (err) {
      privateError = `${path.relative(dataRoot, knowledgePath)} : ${(err as Error).message.split("\n")[0]}`;
      return loadKnowledgeLayers();
    }
  };
  const personal = new FolderStore(path.join(dataRoot, "private"), path.join(dataRoot, "backups", "private", "library"));
  const showIntentions = show.collection("intentions", IntentionSchema);
  const intentions: IntentionStores = {
    base: () => (kb ??= readBase()),
    privateUnreadable: () => (intentions.base(), privateError),
    personal: personal.collection("intentions", IntentionSchema),
    show: showIntentions,
    // each show reads the words of its songs and looks against this machine's intentions under its own (T15b)
    machineUsers: () => machineIntentionUsers(dataRoot, (own) => stackIntentions(intentions.base(), intentions.personal.list(), own)),
    current: deps.currentShow,
    loadErrors: () => [
      ...(privateError ? [say(`fichier privé des intentions : ${privateError} (seules les intentions livrées, de la bibliothèque et du show servent ; rien n'est migré tant qu'il est illisible)`, `private intentions file: ${privateError} (only the shipped, library and show intentions serve; nothing is migrated while it is unreadable)`)] : []),
      ...personal.loadErrors.map((e) => say(`bibliothèque personnelle : ${e}`, `personal library: ${e}`)),
      ...show.loadErrors.filter((e) => e.startsWith("intentions/")),
    ],
    newId: () => newIntentionId(deps.now?.() ?? Date.now()),
  };
  return { personal, intentions };
}

/** The intentions a write may migrate against: none while the private file is unreadable (a name could go astray). */
export const migratableStack = (intentions: IntentionStores): ReturnType<typeof showStack> | undefined => (intentions.privateUnreadable?.() ? undefined : showStack(intentions));

/**
 * What the show commands ask of the intentions (T15, T15b): where one is named, a look's ambiance: tags as stored,
 * a new id, the ambiguous tags. The stores are read at the time of the call (they are opened after these commands).
 */
export function showIntentionHooks(intentions: () => IntentionStores, used: () => { songs: Song[]; looks: Look[] }): Pick<ShowCommandOptions, "intentionReferences" | "migrateTags" | "newIntentionId" | "ambiguousTags"> {
  return {
    intentionReferences: (id) => intentionReferences(intentions(), used(), id),
    migrateTags: (tags) => {
      const stack = migratableStack(intentions());
      return stack ? migrateTags(stack, tags).tags : tags;
    },
    newIntentionId: () => freshIntentionId(intentions()),
    ambiguousTags: (tags) => ambiguousRefs(showStack(intentions()), tags.filter((t) => t.startsWith(AMBIANCE)).map((t) => t.slice(AMBIANCE.length))),
  };
}

/**
 * What names an intention, read and written by id (T15b): a song's mood and a look's ambiance: tags
 * written by name become the id one intention only answers to, shown by its label.
 */
export function attachSongIntentions(songs: SongServices, intentions: IntentionStores): void {
  songs.intentionLabels = () => {
    const stack = showStack(intentions);
    return (mood) => labelsOfRefs(stack, mood);
  };
  songs.migrateMood = (mood) => {
    const stack = migratableStack(intentions);
    return stack ? migrateMood(stack, mood).mood : mood;
  };
  songs.ambiguousMood = (mood) => ambiguousRefs(showStack(intentions), mood);
}

/** The colour presets (T41): the show's own and the personal library's (data/private/colours), as the intentions. */
export function openColours(deps: KnowledgeDeps & { personal: FolderStore; mappings: Collection<Mapping>; songs: Collection<Song> }): ColourStores {
  const { show, personal, mappings, songs, dataRoot } = deps;
  return {
    show: show.collection("colours", ColourPresetSchema),
    personal: personal.collection("colours", ColourPresetSchema),
    citing: () => ({ mappings: mappings.list(), songs: songs.list() }),
    newId: () => newColourId(deps.now?.() ?? Date.now()),
    otherShows: (id) => machineColourUsers(dataRoot, id, deps.currentShow()),
  };
}

/**
 * An intention command's line said by the intention's label (T15b: a new one's id is generated), read
 * when it is recorded: the label given, else the one it bears, else the one its last copy bore (deleted).
 */
export function intentionLineLabel(intentions: IntentionStores, args: unknown): string | undefined {
  const a = (args && typeof args === "object" ? args : {}) as { id?: unknown; intention?: { id?: unknown; label?: unknown } };
  if (typeof a.intention?.label === "string" && a.intention.label.trim()) return a.intention.label.trim();
  const id = typeof a.id === "string" ? a.id : typeof a.intention?.id === "string" ? a.intention.id : undefined;
  if (!id) return undefined;
  const label = labelOfRef(showStack(intentions), id);
  if (label !== id) return label;
  return [...intentions.show.deleted(), ...intentions.personal.deleted()].find((d) => d.id === id)?.name;
}

/**
 * The words of the show's songs (mood) and looks (ambiance: tags) written by name become the id of the intention
 * they name, where one intention only answers to the name (T15b); each change kept in the history as any put.
 * Nothing while the private intentions file is unreadable.
 */
export function migrateIntentionWords(intentions: IntentionStores, songs: Collection<Song> | undefined, looks: Collection<Look>): void {
  // nothing names an intention: the files of this machine are not read for nothing
  if (!songs?.list().some((s) => s.mood.length) && !looks.list().some((l) => l.tags.some((t) => t.startsWith(AMBIANCE)))) return;
  if (intentions.privateUnreadable?.()) return;
  const stack = showStack(intentions);
  for (const s of songs?.list() ?? []) {
    const m = migrateMood(stack, s.mood);
    if (m.changed) songs!.put({ ...s, mood: m.mood });
  }
  for (const l of looks.list()) {
    const t = migrateTags(stack, l.tags);
    if (t.changed) looks.put({ ...l, tags: t.tags });
  }
}

/**
 * The intentions of this machine (personal library, private file) the open show names, and the personal colour
 * presets it cites, as files of its own: its archives carry them, so that a restore anywhere brings them back as
 * the show's (T15, T41).
 */
export function showExtraFiles(intentions: IntentionStores, colours: ColourStores, used: { songs: Song[]; looks: Look[] }): Record<string, string> {
  const stack = showStack(intentions);
  const keys = intentionUsesByKey(used, refKey(stack)).keys();
  const files = embeddedIntentions(stack, keys).intentions.map((x) => [`intentions/${x.id}.json`, stableStringify(x)] as const);
  // the personal colour presets it cites (favourites, mappings, cues) and has none of its own of that id (T41)
  const c = colours;
  const cited = citedColours({ ...c.citing(), favorites: favoritesInOrder(stackColours(c.personal.list(), c.show.list()).values()).map((e) => e.id) });
  const colourFiles = cited.flatMap((id) => {
    const p = !c.show.has(id) && c.personal.get(id);
    return p ? [[`colours/${id}.json`, stableStringify(p)] as const] : [];
  });
  return Object.fromEntries([...files, ...colourFiles]);
}

/** What a restore compares the archive's intentions and colour presets with: this machine's (T15b, T41). */
export function machineRestoreHooks(intentions: IntentionStores, colours: ColourStores): Pick<RestoreTargets, "machineIntention" | "machineColour" | "machineIntentions"> {
  return {
    // an intention of this machine as an archive would carry it: one restored as it is stays in the library
    machineIntention: (key) => {
      const i = intentions;
      const [own] = embeddedIntentions(stackIntentions(i.base(), i.personal.list(), []), [key]).intentions;
      return own && stableStringify(own);
    },
    // a colour preset of the personal library as an archive would carry it (T41): one restored as it is stays there
    machineColour: (id) => {
      const p = colours.personal.get(id);
      return p && stableStringify(p);
    },
    // what an intention the archive brings is compared with: one of the same label here is a twin (T15b)
    machineIntentions: () => {
      const i = intentions;
      return [...stackIntentions(i.base(), i.personal.list(), []).values()].flatMap((e) => (e.hidden || e.origin === "show" ? [] : [{ id: e.id, label: e.label || e.id, origin: e.origin, colors: e.colors }]));
    },
  };
}
