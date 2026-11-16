/**
 * Library commands (T20b, first delivery; docs/specs/venue-fixtures-stage.md, « Bibliothèque »): list the definitions
 * with where they lie, who uses them and their duplicates; read and compare one; duplicate, delete (to a trash),
 * restore; merge two files of one model (`pick`) or two names of one fixture (`alias`, venue/aliases.ts). Thin over
 * venue/library.ts (files, trash) and venue/aliases.ts (pure); the interface, MCP, HTTP, OSC and CLI are adapters.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CommandError, type CommandRegistry } from "./registry.js";
import type { ShowRuntime } from "../show/runtime.js";
import type { PatchedFixture, Venue } from "../venue/venue.js";
import { GENERIC_DIMMER, findMode, normaliseName, parseQxf, sameName, type FixtureDefinition } from "../venue/qxf-import.js";
import { describeDiff, diffDefinitions, findDuplicateDefinitions } from "../venue/definition-duplicates.js";
import { aliasOf, aliasTarget, modeTable, retargetAliases, storedModes, type Alias } from "../venue/aliases.js";
import { modelKey, modelKeyOrUndefined } from "../venue/overrides.js";
import { definitionFileName } from "../venue/definition-files.js";
import { isGenericDimmer } from "../venue/names.js";
import { normalisedDefinition } from "../data/archive-fixtures.js";
import { emptyTrash, folderOf, freeFileName, libraryId, listTrash, moveToTrash, otherVenuesUsing, parseLibraryId, renameDefinition, restoreFromTrash, trashEntry, writeDefinition, type LibraryDirs, type LibraryFolder } from "../venue/library.js";
import { say } from "../../../core/lang.js";

export interface LibraryServices {
  runtime: ShowRuntime;
  dataRoot: string;
  /** The open venue's id. */
  venue: () => string;
  now?: () => number;
}

/** A library file as the commands see it. */
interface LibraryFile {
  id: string;
  file: string;
  folder: LibraryFolder;
  path: string;
  def: FixtureDefinition;
}

const BUILTIN_ID = "builtin/generic";
/** How many other names of the same structure a row of the list carries (library.duplicates has them all). */
const MAX_SAME_STRUCTURE = 8;

/** The venue's two library folders (Venue.libraryDirs: its own first, then the shared one). */
const dirsOf = (venue: Venue): LibraryDirs => ({ venue: venue.libraryDirs[0] ?? "", shared: venue.libraryDirs[1] ?? "" });

function filesOf(venue: Venue): LibraryFile[] {
  const dirs = dirsOf(venue);
  return venue.libraryFiles().flatMap((f) => {
    const folder = folderOf(dirs, f.path);
    return folder ? [{ id: libraryId(folder, path.basename(f.path)), file: path.basename(f.path), folder, path: f.path, def: f.def }] : [];
  });
}

const fileById = (venue: Venue, id: string): LibraryFile => {
  parseLibraryId(id); // a malformed id says so
  const f = filesOf(venue).find((x) => x.id === id);
  if (!f) throw new CommandError("failed", say(`définition inconnue : ${id}`, `unknown definition: ${id}`), { unknown: "definition" });
  return f;
};

const sameModel = (a: { manufacturer: string; model: string }, b: { manufacturer: string; model: string }) => sameName(a.manufacturer, b.manufacturer) && sameName(a.model, b.model);

const nameKey = (m: { manufacturer: string; model: string }) => `${normaliseName(m.manufacturer)}|${normaliseName(m.model)}`;

/** The file each model resolves to (the first in reading order), by its normalised names: one pass, for large libraries. */
function winnersOf(files: readonly { path: string; def: FixtureDefinition }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    const k = nameKey(f.def);
    if (!out.has(k)) out.set(k, path.resolve(f.path));
  }
  return out;
}

/** The fixtures of the venue (absent ones too) by the library file they resolve to, through the aliases. */
function usageByFile(venue: Venue, winners = winnersOf(venue.libraryFiles())): Map<string, PatchedFixture[]> {
  const out = new Map<string, PatchedFixture[]>();
  for (const f of venue.fixtures.list()) {
    const to = aliasTarget(venue.aliases, f);
    const key = winners.get(nameKey(to)) ?? (isGenericDimmer(to.manufacturer, to.model) ? BUILTIN_ID : undefined);
    if (key) out.set(key, [...(out.get(key) ?? []), f]);
  }
  return out;
}

const named = (fs: readonly PatchedFixture[]) => fs.map((f) => ({ id: f.id, name: f.name }));

/**
 * `fixture.definition.add` (the Import page, MCP, CLI): a .qxf into the shared folder, checked first. A file of that
 * name with another content, or **another file of the same model** with another content (T40: it would have kept
 * winning, the new one ignored), is refused unless `replace`; `replace` then writes over the file the library really
 * uses for that model (where it lies: the venue's own or the shared folder), so that the change is seen at once. The
 * same model already there, identical: nothing written (`unchanged`).
 */
export function addDefinition(venue: Venue, sharedDir: string, name: string, xml: string, replace: boolean): { file: string; folder: LibraryFolder; manufacturer: string; model: string; modes: string[]; unchanged?: true; replaced?: true } {
  const def = parseQxf(xml); // throws on anything that is not a definition
  if (!def.manufacturer.trim() || !def.model.trim()) throw new Error(say("définition sans fabricant ou sans modèle", "definition without a manufacturer or a model"));
  venue.refreshDefinitions();
  const dirs = dirsOf(venue);
  const file = definitionFileName(name);
  let target = path.join(sharedDir, file);
  const used = venue.libraryFileFor(def.manufacturer, def.model);
  const summary = (full: string) => ({ file: path.basename(full), folder: folderOf(dirs, full) ?? ("shared" as const), manufacturer: def.manufacturer, model: def.model, modes: def.modes.map((m) => m.name) });
  if (used && path.resolve(used.path) !== path.resolve(target)) {
    if (!replace && normalisedDefinition(used.def) === normalisedDefinition(def)) return { ...summary(used.path), unchanged: true as const };
    const folder = folderOf(dirs, used.path) ?? "shared";
    if (!replace)
      throw new CommandError(
        "failed",
        say(`${def.manufacturer} ${def.model} est déjà dans la bibliothèque, autrement, dans ${used.source}${folder === "venue" ? " (propre à ce lieu)" : ""} (replace pour le remplacer)`, `${def.manufacturer} ${def.model} is already in the library, otherwise, in ${used.source}${folder === "venue" ? " (this venue's own)" : ""} (replace to replace it)`),
        { exists: true, file: path.basename(used.path), folder, sameModel: true },
      );
    target = used.path;
  } else if (existsSync(target) && readFileSync(target, "utf8") !== xml && !replace)
    throw new CommandError("failed", say(`${file} existe déjà (replace pour le remplacer)`, `${file} already exists (replace to replace it)`), { exists: true, file }); // detail: the UI offers « Remplacer »
  const replaced = existsSync(target);
  writeDefinition(target, xml);
  venue.refreshDefinitions();
  return { ...summary(target), ...(replaced && replace ? { replaced: true as const } : {}) };
}

export function registerLibraryCommands(reg: CommandRegistry, s: LibraryServices): void {
  const venue = s.runtime.venue;
  const now = () => s.now?.() ?? Date.now();
  const IdSchema = z.string().min(1).describe("a definition: venue/<file> (this venue's own folder) or shared/<file> (data/fixtures), as library.list gives it");

  /** One row of the list. */
  const rows = () => {
    const files = filesOf(venue);
    const winners = winnersOf(files);
    const usage = usageByFile(venue, winners);
    const report = findDuplicateDefinitions(files.map((f) => ({ def: f.def, source: f.id })));
    const copies = new Map<string, string[]>();
    for (const g of report.sameName) {
      const ids = [g.winner, ...g.others.map((o) => o.source)];
      for (const id of ids) copies.set(id, ids);
    }
    // the other names of one structure, a few per row (a range of many models sharing one layout would repeat them all)
    const structure = new Map<string, { names: { manufacturer: string; model: string }[]; count: number }>();
    for (const g of report.sameSignature)
      for (const n of g.names) {
        const others = g.names.filter((o) => o !== n);
        const entry = { names: others.slice(0, MAX_SAME_STRUCTURE).map((o) => ({ manufacturer: o.manufacturer, model: o.model })), count: others.length };
        for (const src of n.sources) structure.set(src, entry);
      }
    const aliases = venue.aliases.list();
    const fileRows = files.map((f) => {
      const key = modelKeyOrUndefined(f.def.manufacturer, f.def.model);
      const alias = aliasOf(venue.aliases, f.def.manufacturer, f.def.model);
      const from = aliases.filter((a) => sameModel(a.to, f.def));
      return {
        id: f.id,
        file: f.file,
        folder: f.folder,
        manufacturer: f.def.manufacturer,
        model: f.def.model,
        type: f.def.type,
        modes: f.def.modes.map((m) => ({ name: m.name, channels: m.channels.length, heads: m.heads.length })),
        /** This file is the one the library uses for its model (the first in reading order). */
        winner: winners.get(nameKey(f.def)) === path.resolve(f.path),
        /** Every file of this model (itself included), when there are several. */
        copies: copies.get(f.id) ?? [],
        /** Other names with the same structure (modes, channels, ranges): the first few, and how many there are. */
        sameStructure: structure.get(f.id)?.names ?? [],
        ...(structure.has(f.id) ? { sameStructureCount: structure.get(f.id)!.count } : {}),
        usedBy: named(usage.get(path.resolve(f.path)) ?? []),
        overrides: Boolean(key && venue.models.get(key)),
        ...(alias ? { aliasedTo: alias.to } : {}),
        ...(from.length ? { aliasedFrom: from.map((a) => a.from) } : {}),
      };
    });
    const generic = { id: BUILTIN_ID, file: "", folder: "builtin" as const, manufacturer: GENERIC_DIMMER.manufacturer, model: GENERIC_DIMMER.model, type: GENERIC_DIMMER.type, modes: [], winner: true, copies: [], sameStructure: [], usedBy: named(usage.get(BUILTIN_ID) ?? []), overrides: false };
    return { files: fileRows, generic, report, aliases };
  };

  reg.register({
    name: "library.list",
    title: "Bibliothèque des projecteurs",
    description:
      "The fixture definitions of the library, one row per .qxf file: id (venue/<file> for this venue's own folder, shared/<file> for data/fixtures; the venue's own is read first and wins for its model), manufacturer, model, type, modes, winner (the file the library uses for its model), copies (every file of the same model), sameStructure (other names with the same modes, channels and ranges), usedBy (this venue's patched fixtures that resolve to it, aliases followed), overrides (this venue has corrections for the model), aliasedTo / aliasedFrom (library.merge as alias). QLC+'s built-in generic dimmer comes last (folder builtin). Also aliases (this venue's) and trash (how many definitions are in the trash). Filters: search (manufacturer, model or file), manufacturer, type, used, duplicates (copies or same structure), folder.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({
      search: z.string().optional(),
      manufacturer: z.string().optional(),
      type: z.string().optional(),
      used: z.boolean().optional().describe("true: only what this venue's patch uses; false: only what it does not"),
      duplicates: z.boolean().optional().describe("true: only definitions with copies or the same structure as another name"),
      folder: z.enum(["venue", "shared", "builtin"]).optional(),
    }),
    run: (f) => {
      const { files, generic, aliases } = rows();
      const words = (f.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const keep = (r: (typeof files)[number] | typeof generic) =>
        words.every((w) => `${r.manufacturer} ${r.model} ${r.file}`.toLowerCase().includes(w)) &&
        (f.manufacturer === undefined || sameName(r.manufacturer, f.manufacturer)) &&
        (f.type === undefined || r.type.toLowerCase() === f.type.toLowerCase()) &&
        (f.used === undefined || (r.usedBy.length > 0) === f.used) &&
        (f.duplicates === undefined || (r.copies.length > 0 || r.sameStructure.length > 0) === f.duplicates) &&
        (f.folder === undefined || r.folder === f.folder);
      return { definitions: [...files, generic].filter(keep), aliases: aliases.map((a) => ({ ...a, fixtures: venue.fixtures.list().filter((x) => sameModel(x, a.from)).length })), trash: listTrash(s.dataRoot).length };
    },
  });

  reg.register({
    name: "library.duplicates",
    title: "Doublons de la bibliothèque",
    description:
      "The library's duplicates, by definition id (library.list): sameName, one model in several files (the winner, the one the library uses, and each other one, identical or with what differs, said in `message`); sameSignature, one structure under several names (gamme of one manufacturer, or one fixture under two names: library.merge as alias).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({}),
    run: () => {
      const { report } = rows();
      return {
        sameName: report.sameName.map((g) => ({ ...g, others: g.others.map((o) => ({ ...o, ...(o.diff ? { message: describeDiff(o.diff) } : {}) })) })),
        sameSignature: report.sameSignature,
      };
    },
  });

  reg.register({
    name: "library.get",
    title: "Lire une définition",
    description: "One library definition by its id (library.list): its .qxf text (xml) and what the library reads from it (manufacturer, model, type, modes with their channels, heads).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({ id: IdSchema }),
    run: ({ id }) => {
      const f = fileById(venue, id);
      return {
        id: f.id,
        file: f.file,
        folder: f.folder,
        manufacturer: f.def.manufacturer,
        model: f.def.model,
        type: f.def.type,
        modes: f.def.modes.map((m) => ({ name: m.name, channels: m.channels, heads: m.heads })),
        xml: readFileSync(f.path, "utf8"),
      };
    },
  });

  reg.register({
    name: "library.diff",
    title: "Comparer deux définitions",
    description: "What differs between two library definitions (ids from library.list): type, modes only in one, channel counts, channels or ranges, other settings; message says it as people read it, identical when nothing does.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({ a: IdSchema, b: IdSchema }),
    run: ({ a, b }) => {
      const [x, y] = [fileById(venue, a), fileById(venue, b)];
      const diff = diffDefinitions(x.def, y.def);
      const identical = !diff.type && !diff.modesOnlyInWinner.length && !diff.modesOnlyInOther.length && !diff.channelCounts.length && !diff.rangesDiffer.length && !diff.otherDiffers;
      return { a, b, identical, diff, message: identical ? say("identiques", "identical") : describeDiff(diff) };
    },
  });

  // ---- delete, trash, restore

  /** What removing a file does: this venue's fixtures on it, other venues' (a shared file), and the file they would fall back to. */
  const removalPlan = (f: LibraryFile) => {
    const usedBy = usageByFile(venue).get(path.resolve(f.path)) ?? [];
    const otherVenues = f.folder === "shared" ? otherVenuesUsing(s.dataRoot, s.venue(), f.path) : [];
    const rest = filesOf(venue).filter((o) => o.id !== f.id && sameModel(o.def, f.def));
    const fallback = rest[0];
    return { usedBy, otherVenues, fallback, identicalFallback: Boolean(fallback && normalisedDefinition(fallback.def) === normalisedDefinition(f.def)) };
  };

  reg.register({
    name: "library.delete",
    title: "Supprimer une définition",
    description:
      "Moves a library definition (id from library.list) to the trash (library.trash, library.restore). Refused while fixtures resolve to it — this venue's (usedBy) and, for a shared file, other venues' (otherVenues) — unless force, or unless another identical file of the same model takes over (fallback). With force, those fixtures fall back to fallback, or have no definition (show.lint says so). dryRun: only says what it would do. dropOverrides: also removes this venue's corrections of the model when no file of it is left.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: IdSchema, force: z.boolean().default(false), dryRun: z.boolean().default(false), dropOverrides: z.boolean().default(false) }),
    dry: (a) => a.dryRun,
    run: ({ id, force, dryRun, dropOverrides }, ctx) => {
      const f = fileById(venue, id);
      const p = removalPlan(f);
      const key = modelKeyOrUndefined(f.def.manufacturer, f.def.model);
      const orphanOverrides = !p.fallback && Boolean(key && venue.models.get(key));
      const plan = { id, manufacturer: f.def.manufacturer, model: f.def.model, usedBy: named(p.usedBy), otherVenues: p.otherVenues, ...(p.fallback ? { fallback: p.fallback.id, identicalFallback: p.identicalFallback } : {}), orphanOverrides };
      const blocking = (p.usedBy.length > 0 || p.otherVenues.length > 0) && !p.identicalFallback;
      if (dryRun) return { ...plan, deleted: false, refused: blocking && !force };
      if (blocking && !force) {
        const names = [...p.usedBy.map((x) => x.name), ...p.otherVenues.map((v) => say(`lieu ${v.venue} (${v.fixtures.join(", ")})`, `venue ${v.venue} (${v.fixtures.join(", ")})`))];
        throw new CommandError("failed", say(`${f.def.manufacturer} ${f.def.model} sert encore : ${names.join(", ")} (force pour la supprimer quand même)`, `${f.def.manufacturer} ${f.def.model} is still in use: ${names.join(", ")} (force to delete it anyway)`), { ...plan, force: true });
      }
      const trash = moveToTrash(s.dataRoot, f.path, { folder: f.folder, ...(f.folder === "venue" ? { venue: s.venue() } : {}), manufacturer: f.def.manufacturer, model: f.def.model, ...(ctx.who ? { who: ctx.who } : {}) }, now());
      venue.refreshDefinitions();
      const droppedOverrides = dropOverrides && orphanOverrides && key ? venue.models.delete(key) : false;
      return { ...plan, deleted: true, trash, droppedOverrides };
    },
  });

  reg.register({
    name: "library.trash",
    title: "Corbeille des définitions",
    description: "The definitions moved to the trash (library.delete, library.merge), newest first: id (for library.restore), file, folder it came from (venue: with the venue), manufacturer, model, deletedAt, who. Nothing is purged by itself (library.trash.empty).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({}),
    run: () => listTrash(s.dataRoot),
  });

  reg.register({
    name: "library.restore",
    title: "Restaurer une définition",
    description: "Puts a definition of the trash (id from library.trash) back in the folder it came from (a venue's own: that venue's), under a free name if its own is taken. Its fixtures resolve it again.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: z.string().min(1) }),
    run: ({ id }) => {
      const { entry } = trashEntry(s.dataRoot, id);
      const dirs = dirsOf(venue);
      const dir = entry.folder === "shared" ? dirs.shared : entry.venue && entry.venue !== s.venue() ? path.join(s.dataRoot, "venues", entry.venue, "fixture-definitions") : dirs.venue;
      const file = restoreFromTrash(s.dataRoot, id, dir);
      venue.refreshDefinitions();
      return { file, folder: entry.folder, ...(entry.venue ? { venue: entry.venue } : {}), manufacturer: entry.manufacturer, model: entry.model };
    },
  });

  reg.register({
    name: "library.trash.empty",
    title: "Vider la corbeille des définitions",
    description: "Removes every definition of the trash for good (they can no longer be restored). Returns how many were removed.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({}),
    run: () => ({ removed: emptyTrash(s.dataRoot) }),
  });

  // ---- duplicate

  reg.register({
    name: "library.duplicate",
    title: "Dupliquer une définition",
    description:
      "Copies a library definition (id) into this venue's own folder (folder: shared for data/fixtures), as a new model: model (default « <model> (copie) »), manufacturer (default the same); this venue's corrections of the model are copied under the new name. sameName: true keeps the names instead — a copy for this venue, which then wins over the shared definition of that model (its fixtures, takesOver, use the copy); only from a shared file. The original is untouched.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: IdSchema, model: z.string().trim().min(1).max(120).optional(), manufacturer: z.string().trim().min(1).max(120).optional(), sameName: z.boolean().default(false), folder: z.enum(["venue", "shared"]).default("venue") }),
    run: ({ id, model, manufacturer, sameName: keepNames, folder }) => {
      const f = fileById(venue, id);
      const dirs = dirsOf(venue);
      const xml = readFileSync(f.path, "utf8");
      if (keepNames) {
        if (f.folder === "venue" || folder === "shared") throw new Error(say("une copie sous le même nom ne se fait que d'une définition partagée vers ce lieu", "a copy under the same name is only made from a shared definition into this venue"));
        const own = filesOf(venue).find((o) => o.folder === "venue" && sameModel(o.def, f.def));
        if (own) throw new Error(say(`ce lieu a déjà sa copie de ${f.def.manufacturer} ${f.def.model} : ${own.id}`, `this venue already has its copy of ${f.def.manufacturer} ${f.def.model}: ${own.id}`));
        const takesOver = usageByFile(venue).get(path.resolve(f.path)) ?? [];
        const copy = freeFileName(dirs.venue, f.file);
        writeDefinition(path.join(dirs.venue, copy), xml);
        venue.refreshDefinitions();
        return { id: libraryId("venue", copy), manufacturer: f.def.manufacturer, model: f.def.model, takesOver: named(takesOver) };
      }
      const names = { manufacturer: manufacturer ?? f.def.manufacturer, model: model ?? `${f.def.model} ${say("(copie)", "(copy)")}` };
      if (!modelKeyOrUndefined(names.manufacturer, names.model)) throw new Error(say("nom de modèle sans lettre ni chiffre", "model name without a letter or digit"));
      // a free model name: « (copie) », then « (copie) 2 »… when no name was given; a given one already there is refused
      if (model === undefined) for (let i = 2; venue.libraryFileFor(names.manufacturer, names.model) || venue.aliases.get(modelKey(names.manufacturer, names.model)); i++) names.model = `${f.def.model} ${say("(copie)", "(copy)")} ${i}`;
      else if (venue.libraryFileFor(names.manufacturer, names.model)) throw new Error(say(`${names.manufacturer} ${names.model} est déjà dans la bibliothèque`, `${names.manufacturer} ${names.model} is already in the library`));
      if (isGenericDimmer(names.manufacturer, names.model)) throw new Error(say("nom réservé au gradateur générique", "name reserved to the generic dimmer"));
      const dir = folder === "shared" ? dirs.shared : dirs.venue;
      const name = freeFileName(dir, definitionFileName(`${names.manufacturer}-${names.model}`));
      const def = writeDefinition(path.join(dir, name), renameDefinition(xml, names));
      venue.refreshDefinitions();
      // the model's corrections in this venue go with the copy (venue/overrides.ts)
      const oldKey = modelKeyOrUndefined(f.def.manufacturer, f.def.model);
      const corrections = oldKey ? venue.models.get(oldKey) : undefined;
      const newKey = modelKey(def.manufacturer, def.model);
      if (corrections && !venue.models.get(newKey)) venue.models.put({ id: newKey, manufacturer: def.manufacturer, model: def.model, overrides: corrections.overrides });
      return { id: libraryId(folder, name), manufacturer: def.manufacturer, model: def.model, copiedOverrides: Boolean(corrections) };
    },
  });

  // ---- merge

  const OverridesChoice = z.enum(["target", "source"]).describe("when both models have corrections in this venue: target keeps the target's, source copies the old name's over them");
  reg.register({
    name: "library.merge",
    title: "Fusionner deux définitions",
    description:
      "Merges duplicates (ids from library.list). as pick: keep and drop are files of one model; the dropped files go to the trash, the fixtures stay as they are (refused when a mode in use exists only in a dropped file, or, for a shared file, when another venue would lose its definition, unless force). as alias: drop's model becomes a name of keep's (decision Q2): its fixtures keep their manufacturer, model, mode and address and resolve keep's definition, their mode by the mode table (found by name, then channel count; modes gives the rest, old → keep's mode name; a mode in use without an equivalent refuses the alias, unmapped lists them; a footprint change needs force); the files stay, library.unalias undoes it. The old name's corrections are copied onto keep's model (kept under the old name too); when keep's model has its own, overrides must say which win (detail overridesConflict). Aliases that named the old model now name keep's. dryRun: the plan only, never refused.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({
      keep: IdSchema,
      drop: z.array(IdSchema).min(1),
      as: z.enum(["pick", "alias"]),
      modes: z.record(z.string(), z.string()).default({}).describe("alias: old mode name → keep's mode name, for the modes not found by themselves"),
      overrides: OverridesChoice.optional(),
      force: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    }),
    dry: (a) => a.dryRun,
    run: (a, ctx) => {
      const keep = fileById(venue, a.keep);
      const drops = [...new Set(a.drop)].map((id) => fileById(venue, id));
      if (drops.some((d) => d.id === keep.id)) throw new Error(say("la définition gardée ne peut pas être aussi retirée", "the kept definition cannot be dropped too"));
      return a.as === "pick" ? mergePick(keep, drops, a, ctx.who) : mergeAlias(keep, drops, a);
    },
  });

  const mergePick = (keep: LibraryFile, drops: LibraryFile[], a: { force: boolean; dryRun: boolean }, who?: string) => {
    if (drops.some((d) => !sameModel(d.def, keep.def))) throw new Error(say("« garder celle-ci » ne fusionne que des fichiers du même modèle (sinon : alias)", "« keep this one » only merges files of one model (otherwise: alias)"));
    // the kept file must win once the others are gone: every file of the model read before it is dropped too
    const all = filesOf(venue);
    const ahead = all.slice(0, all.findIndex((o) => o.id === keep.id)).filter((o) => sameModel(o.def, keep.def) && !drops.some((d) => d.id === o.id));
    if (ahead.length) throw new Error(say(`${ahead.map((o) => o.id).join(", ")} passerait encore avant ${keep.id} : le retirer aussi`, `${ahead.map((o) => o.id).join(", ")} would still come before ${keep.id}: drop it too`));
    const fixtures = venue.fixtures.list().filter((f) => sameModel(aliasTarget(venue.aliases, f), keep.def));
    const lostModes = [...new Set(fixtures.map((f) => aliasTarget(venue.aliases, f).mode ?? f.mode))].filter((m) => !findMode(keep.def, m)).sort();
    const otherVenues = drops.flatMap((d) => (d.folder === "shared" && keep.folder === "venue" ? otherVenuesUsing(s.dataRoot, s.venue(), d.path) : []));
    const plan = { as: "pick" as const, keep: keep.id, drop: drops.map((d) => d.id), fixtures: named(fixtures), lostModes, otherVenues, differs: drops.filter((d) => normalisedDefinition(d.def) !== normalisedDefinition(keep.def)).map((d) => d.id) };
    if (a.dryRun) return { ...plan, merged: false, refused: lostModes.length > 0 || (otherVenues.length > 0 && !a.force) };
    if (lostModes.length) throw new CommandError("failed", say(`mode(s) utilisé(s) absent(s) de ${keep.id} : ${lostModes.join(", ")}`, `mode(s) in use missing from ${keep.id}: ${lostModes.join(", ")}`), plan);
    if (otherVenues.length && !a.force) throw new CommandError("failed", say(`d'autres lieux perdraient cette définition : ${otherVenues.map((v) => v.venue).join(", ")} (force pour fusionner quand même)`, `other venues would lose this definition: ${otherVenues.map((v) => v.venue).join(", ")} (force to merge anyway)`), { ...plan, force: true });
    const trashed = drops.map((d) => ({ id: d.id, trash: moveToTrash(s.dataRoot, d.path, { folder: d.folder, ...(d.folder === "venue" ? { venue: s.venue() } : {}), manufacturer: d.def.manufacturer, model: d.def.model, ...(who ? { who } : {}) }, now()) }));
    venue.refreshDefinitions();
    return { ...plan, merged: true, trashed };
  };

  const mergeAlias = (keep: LibraryFile, drops: LibraryFile[], a: { modes: Record<string, string>; overrides?: "target" | "source"; force: boolean; dryRun: boolean }) => {
    const from = drops[0]!.def;
    if (drops.some((d) => !sameModel(d.def, from))) throw new Error(say("un alias fait suivre un seul modèle à la fois", "an alias forwards one model at a time"));
    if (sameModel(from, keep.def)) throw new Error(say("même modèle : « garder celle-ci » (pick) plutôt qu'un alias", "same model: « keep this one » (pick) rather than an alias"));
    if (isGenericDimmer(from.manufacturer, from.model)) throw new Error(say("le gradateur générique ne peut pas être un alias", "the generic dimmer cannot be an alias"));
    const targetAlias = aliasOf(venue.aliases, keep.def.manufacturer, keep.def.model);
    if (targetAlias) throw new Error(say(`${keep.def.manufacturer} ${keep.def.model} est lui-même un alias de ${targetAlias.to.manufacturer} ${targetAlias.to.model} : choisir celui-ci`, `${keep.def.manufacturer} ${keep.def.model} is itself an alias of ${targetAlias.to.manufacturer} ${targetAlias.to.model}: pick that one`));
    const fromKey = modelKey(from.manufacturer, from.model);
    const toKey = modelKey(keep.def.manufacturer, keep.def.model);
    // the fixtures patched under the old name, their modes as the old definition counts them
    const fromDef = venue.libraryFileFor(from.manufacturer, from.model)?.def ?? from;
    // the alias names a model: its fixtures get the file the library uses for it, whichever file was picked
    const toDef = venue.libraryFileFor(keep.def.manufacturer, keep.def.model)?.def ?? keep.def;
    const fixtures = venue.fixtures.list().filter((f) => sameModel(f, from));
    const used = fixtures.map((f) => ({ mode: f.mode, channels: findMode(fromDef, f.mode)?.channels.length }));
    let table: ReturnType<typeof modeTable>;
    try {
      table = modeTable(fromDef, toDef, used, a.modes);
    } catch (err) {
      throw new CommandError("invalid", (err as Error).message);
    }
    const source = venue.models.get(fromKey);
    const target = venue.models.get(toKey);
    const conflict = Boolean(source && target);
    const plan = {
      as: "alias" as const,
      from: { manufacturer: from.manufacturer, model: from.model },
      to: { manufacturer: keep.def.manufacturer, model: keep.def.model },
      modes: table.modes,
      unmapped: table.unmapped,
      channelChanges: table.channelChanges,
      targetModes: toDef.modes.map((m) => ({ name: m.name, channels: m.channels.length })),
      fixtures: named(fixtures),
      overrides: !source ? ("none" as const) : !target ? ("copied" as const) : a.overrides === "source" ? ("replaced-target" as const) : a.overrides === "target" ? ("kept-target" as const) : ("conflict" as const),
      ...(conflict ? { overridesConflict: { source: source!.overrides, target: target!.overrides } } : {}),
    };
    if (a.dryRun) return { ...plan, merged: false, refused: table.unmapped.length > 0 || (table.channelChanges.length > 0 && !a.force) || plan.overrides === "conflict" };
    if (table.unmapped.length) throw new CommandError("failed", say(`mode(s) utilisé(s) sans équivalent dans ${keep.def.model} : ${table.unmapped.join(", ")} (modes pour les faire correspondre)`, `mode(s) in use without an equivalent in ${keep.def.model}: ${table.unmapped.join(", ")} (modes to map them)`), plan);
    if (table.channelChanges.length && !a.force)
      throw new CommandError("failed", say(`le nombre de canaux change : ${table.channelChanges.map((c) => `${c.mode} ${c.from} → ${c.to} ${c.channels}`).join(", ")} (force pour fusionner quand même ; vérifier les adresses)`, `the channel count changes: ${table.channelChanges.map((c) => `${c.mode} ${c.from} → ${c.to} ${c.channels}`).join(", ")} (force to merge anyway; check the addresses)`), { ...plan, force: true });
    if (plan.overrides === "conflict") throw new CommandError("failed", say(`${from.model} et ${keep.def.model} ont chacun leurs corrections dans ce lieu : overrides dit lesquelles gardent (target ou source)`, `${from.model} and ${keep.def.model} both have corrections in this venue: overrides says which ones stay (target or source)`), plan);
    // the old name's corrections onto the target (decision Q5): copied, kept under the old name too (nothing is lost)
    if (source && (!target || a.overrides === "source")) venue.models.put({ id: toKey, manufacturer: target?.manufacturer ?? keep.def.manufacturer, model: target?.model ?? keep.def.model, overrides: source.overrides });
    const alias: Alias = { id: fromKey, from: plan.from, to: plan.to, modes: storedModes(table.modes) };
    const retargeted = retargetAliases(venue.aliases.list(), alias);
    for (const r of retargeted) venue.aliases.put(r);
    venue.aliases.put(alias);
    return { ...plan, merged: true, alias, retargeted: retargeted.map((r) => r.from) };
  };

  reg.register({
    name: "library.unalias",
    title: "Retirer un alias",
    description: "Removes an alias of this venue (id from library.list's aliases: the old model's key): its fixtures resolve their own model's definition again. The corrections copied onto the target stay there; the old name kept its own.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: z.string().min(1) }),
    run: ({ id }) => {
      const alias = venue.aliases.get(id);
      if (!alias) throw new Error(say(`alias inconnu : ${id}`, `unknown alias: ${id}`));
      venue.aliases.delete(id);
      return { removed: true, from: alias.from, to: alias.to };
    },
  });
}
