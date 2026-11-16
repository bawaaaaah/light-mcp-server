/**
 * The fixture library's files (T20b, docs/specs/venue-fixtures-stage.md, « Bibliothèque »): the one place that writes a
 * `.qxf` (`writeDefinition`, also used by `fixture.definition.add`), the trash of removed definitions, and who uses a
 * library file across the venues of this machine. The commands (library-commands.ts) are thin over this.
 *
 * A definition is named by its folder and file: `venue/<file>` (the open venue's own fixture-definitions) or
 * `shared/<file>` (data/fixtures, every venue's). The trash keeps each removed file in a folder of its own under
 * data/backups/deleted-definitions, with where it came from; nothing is purged by itself (decision Q3).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { say } from "../../../core/lang.js";
import { parseQxf, sameName, type FixtureDefinition } from "./qxf-import.js";
import { ID_RE } from "../data/store.js";
import { readDefinitionText } from "./definition-files.js";

export { readDefinitionText };
import { definitionDirsFor, patchModels, resolveModels } from "../data/archive-fixtures.js";
import { AliasSchema, aliasLookup, aliasTarget } from "./aliases.js";

export type LibraryFolder = "venue" | "shared";

/** The two folders of a venue's library, by name. */
export interface LibraryDirs {
  venue: string;
  shared: string;
}

export const libraryDirsOf = (dataRoot: string, venue: string): LibraryDirs => {
  const [own, shared] = definitionDirsFor(dataRoot, venue) as [string, string];
  return { venue: own, shared };
};

/** A definition's id: its folder and its file name (`shared/Spot.qxf`). */
export const libraryId = (folder: LibraryFolder, file: string): string => `${folder}/${file}`;

/**
 * The folder and file of an id. Any file name the library lists is accepted (accents, commas: a file dropped by hand
 * keeps its name); only what could leave the folder is refused here — a separator, `.` or `..`, a NUL — and the
 * commands then match the name against the files listed.
 */
export function parseLibraryId(id: string): { folder: LibraryFolder; file: string } {
  const m = /^(venue|shared)\/([^/\\\0]+)$/.exec(id);
  if (!m || m[2] === "." || m[2] === "..") throw new Error(say(`définition inconnue : ${id}`, `unknown definition: ${id}`));
  return { folder: m[1] as LibraryFolder, file: m[2]! };
}

/** The folder a library file lies in, or undefined when it is in neither. */
export function folderOf(dirs: LibraryDirs, full: string): LibraryFolder | undefined {
  const dir = path.resolve(path.dirname(full));
  return dir === path.resolve(dirs.venue) ? "venue" : dir === path.resolve(dirs.shared) ? "shared" : undefined;
}

/** `name`, or `name-2.qxf`, `-3`…: the first one the folder does not hold, compared without case (a case-insensitive disk). */
export function freeFileName(dir: string, name: string): string {
  const taken = new Set(existsSync(dir) ? readdirSync(dir).map((n) => n.toLowerCase()) : []);
  let out = name;
  for (let i = 2; taken.has(out.toLowerCase()); i++) out = name.replace(/\.qxf$/, `-${i}.qxf`);
  return out;
}

/**
 * Writes a definition file whole (a temporary file, not a `.qxf` the library would read, renamed over it), after
 * checking it reads as a definition with a manufacturer and a model. `encoding`: how the text goes to bytes (a Latin-1
 * file retouched stays Latin-1). Returns the definition read.
 */
export function writeDefinition(target: string, xml: string, encoding: "utf8" | "latin1" = "utf8"): FixtureDefinition {
  const def = parseQxf(xml); // throws on anything that is not a definition
  if (!def.manufacturer.trim() || !def.model.trim()) throw new Error(say("définition sans fabricant ou sans modèle", "definition without a manufacturer or a model"));
  writeWhole(target, Buffer.from(xml, encoding));
  return def;
}

/** Copies a definition file byte for byte (whatever its encoding), checked first, written whole. */
export function copyDefinition(source: string, target: string): FixtureDefinition {
  const { text, bytes } = readDefinitionText(source);
  const def = parseQxf(text);
  writeWhole(target, bytes);
  return def;
}

/** Bytes written through a temporary file renamed over the target: the library never reads half a file. */
function writeWhole(target: string, bytes: Uint8Array): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}


/** Moves a file, across disks too (a rename that cannot cross a device becomes a copy, then a delete). */
export function moveFile(source: string, target: string): void {
  try {
    renameSync(source, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(source, target);
    rmSync(source, { force: true });
  }
}

const escapeXml = (s: string, latin1: boolean): string => {
  const out = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // a Latin-1 file cannot hold other letters: they go as character references
  return latin1 ? [...out].map((c) => (c.codePointAt(0)! > 0xff ? `&#x${c.codePointAt(0)!.toString(16)};` : c)).join("") : out;
};

/**
 * A definition's text with another manufacturer and/or model, everything else to the byte (pure): the first
 * `<Manufacturer>` and `<Model>` elements' text replaced. Refused when the file has none. `latin1`: the text will be
 * written back as Latin-1, so a letter outside it goes as a character reference.
 */
export function renameDefinition(xml: string, names: { manufacturer?: string; model?: string }, latin1 = false): string {
  let out = xml;
  for (const [tag, value] of [["Manufacturer", names.manufacturer], ["Model", names.model]] as const) {
    if (value === undefined) continue;
    const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`);
    if (!re.test(out)) throw new Error(say(`élément <${tag}> absent du fichier`, `no <${tag}> element in the file`));
    out = out.replace(re, () => `<${tag}>${escapeXml(value.trim(), latin1)}</${tag}>`);
  }
  return out;
}

// ---- the trash

export const TrashMetaSchema = z.object({
  file: z.string(),
  folder: z.enum(["venue", "shared"]),
  /** The venue whose own folder it came from (folder « venue »). */
  venue: z.string().optional(),
  manufacturer: z.string(),
  model: z.string(),
  deletedAt: z.string(),
  who: z.string().optional(),
  /** Why it is here when not deleted: « replaced » (the old version of a file « Remplacer » overwrote). */
  reason: z.enum(["deleted", "replaced"]).optional(),
});
export type TrashMeta = z.infer<typeof TrashMetaSchema>;
export type TrashEntry = TrashMeta & { id: string };

const META = "meta.json";
export const trashDirOf = (dataRoot: string): string => path.join(dataRoot, "backups", "deleted-definitions");

/**
 * Moves a library file to the trash (its own folder there, with where it came from), or with `keep` copies it there (a
 * file about to be overwritten: « Remplacer » keeps the old version). Returns the trash entry's id.
 */
export function moveToTrash(dataRoot: string, full: string, meta: Omit<TrashMeta, "file" | "deletedAt">, now: number, keep = false): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const id = `${stamp}-${randomBytes(3).toString("hex")}`;
  const dir = path.join(trashDirOf(dataRoot), id);
  mkdirSync(dir, { recursive: true });
  const file = path.basename(full);
  writeFileSync(path.join(dir, META), JSON.stringify({ ...meta, file, deletedAt: new Date(now).toISOString() } satisfies TrashMeta, null, 2));
  if (keep) copyFileSync(full, path.join(dir, file));
  else moveFile(full, path.join(dir, file));
  return id;
}

/** The trash, newest first. An entry whose note cannot be read is left out, and stays on disk (emptying leaves it too). */
export function listTrash(dataRoot: string): TrashEntry[] {
  const root = trashDirOf(dataRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .flatMap((id) => {
      try {
        const meta = TrashMetaSchema.parse(JSON.parse(readFileSync(path.join(root, id, META), "utf8")));
        return existsSync(path.join(root, id, meta.file)) ? [{ ...meta, id }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : a.id < b.id ? 1 : -1));
}

/** One trash entry and its file's full path; refused for an id that is not one. */
export function trashEntry(dataRoot: string, id: string): { entry: TrashEntry; full: string } {
  if (!/^[\w-]+$/.test(id)) throw new Error(say(`entrée de corbeille inconnue : ${id}`, `unknown trash entry: ${id}`));
  const entry = listTrash(dataRoot).find((e) => e.id === id);
  if (!entry) throw new Error(say(`entrée de corbeille inconnue : ${id}`, `unknown trash entry: ${id}`));
  return { entry, full: path.join(trashDirOf(dataRoot), id, entry.file) };
}

/** Puts a trashed file back in `dir` (under a free name), and forgets the entry. Returns the file name. */
export function restoreFromTrash(dataRoot: string, id: string, dir: string): string {
  const { full } = trashEntry(dataRoot, id);
  parseQxf(readDefinitionText(full).text); // still a definition: never put an unreadable file back
  const name = freeFileName(dir, path.basename(full));
  mkdirSync(dir, { recursive: true });
  moveFile(full, path.join(dir, name));
  rmSync(path.join(trashDirOf(dataRoot), id), { recursive: true, force: true });
  return name;
}

/** Empties the trash for good: the entries it lists (one whose note cannot be read stays). Returns them. */
export function emptyTrash(dataRoot: string): TrashEntry[] {
  const entries = listTrash(dataRoot);
  for (const e of entries) rmSync(path.join(trashDirOf(dataRoot), e.id), { recursive: true, force: true });
  return entries;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false; // missing, or a broken link
  }
};

/**
 * The folder a trashed definition goes back to: the shared one, or its venue's own when that venue still exists (an id
 * the store accepts, a folder on disk); a venue gone since: the shared folder, said (`toShared`), never a ghost venue.
 */
export function restoreDirOf(dataRoot: string, entry: TrashEntry): { dir: string; toShared: boolean } {
  const shared = path.join(dataRoot, "fixtures");
  if (entry.folder === "shared") return { dir: shared, toShared: false };
  if (!entry.venue || !ID_RE.test(entry.venue) || !isDir(path.join(dataRoot, "venues", entry.venue))) return { dir: shared, toShared: true };
  return { dir: path.join(dataRoot, "venues", entry.venue, "fixture-definitions"), toShared: false };
}

// ---- who uses a file, on the other venues of this machine

/**
 * The other venues (folders of data/venues) whose patch resolves a model to this library file, with their fixtures'
 * names and the modes they use (through their aliases).
 */
export function otherVenuesUsing(dataRoot: string, current: string, full: string): { venue: string; fixtures: string[]; modes: string[] }[] {
  const venues = path.join(dataRoot, "venues");
  if (!existsSync(venues)) return [];
  const target = path.resolve(full);
  return readdirSync(venues)
    .filter((v) => v !== current && isDir(path.join(venues, v)))
    .sort()
    .flatMap((v) => {
      const files = venueJson(path.join(venues, v));
      const lookup = aliasLookup(Object.entries(files).flatMap(([name, text]) => (name.startsWith("aliases/") ? parseOr(AliasSchema, text) : [])));
      const patched = Object.entries(files).flatMap(([name, text]) => (name.startsWith("fixtures/") ? parseOr(z.object({ name: z.string(), manufacturer: z.string(), model: z.string(), mode: z.string() }).loose(), text) : []));
      const models = patchModels(files);
      const found = resolveModels(definitionDirsFor(dataRoot, v), models);
      const hit = models.filter((_, i) => found[i] && path.resolve(found[i]!.full) === target);
      const users = patched.flatMap((f) => {
        const to = aliasTarget(lookup, f);
        return hit.some((m) => sameName(m.manufacturer, to.manufacturer) && sameName(m.model, to.model)) ? [{ name: f.name, mode: to.mode ?? f.mode }] : [];
      });
      return users.length ? [{ venue: v, fixtures: users.map((f) => f.name).sort(), modes: [...new Set(users.map((f) => f.mode))].sort() }] : [];
    });
}

/** A venue folder's patch and alias files (`fixtures/<id>.json`, `aliases/<id>.json`) as text. */
function venueJson(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sub of ["fixtures", "aliases"]) {
    const d = path.join(dir, sub);
    if (!isDir(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
      try {
        out[`${sub}/${f}`] = readFileSync(path.join(d, f), "utf8");
      } catch {
        /* unreadable: not part of that patch */
      }
    }
  }
  return out;
}

function parseOr<T>(schema: z.ZodType<T>, text: string): T[] {
  try {
    return [schema.parse(JSON.parse(text))];
  } catch {
    return [];
  }
}
