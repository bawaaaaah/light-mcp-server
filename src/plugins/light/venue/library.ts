/**
 * The fixture library's files (T20b, docs/specs/venue-fixtures-stage.md, « Bibliothèque »): the one place that writes a
 * `.qxf` (`writeDefinition`, also used by `fixture.definition.add`), the trash of removed definitions, and who uses a
 * library file across the venues of this machine. The commands (library-commands.ts) are thin over this.
 *
 * A definition is named by its folder and file: `venue/<file>` (the open venue's own fixture-definitions) or
 * `shared/<file>` (data/fixtures, every venue's). The trash keeps each removed file in a folder of its own under
 * data/backups/deleted-definitions, with where it came from; nothing is purged by itself (decision Q3).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { say } from "../../../core/lang.js";
import { parseQxf, sameName, type FixtureDefinition } from "./qxf-import.js";
import { isPlainQxfName } from "./definition-files.js";
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

/** The folder and file of an id, refused unless it names a plain `.qxf` of one of the two folders. */
export function parseLibraryId(id: string): { folder: LibraryFolder; file: string } {
  const m = /^(venue|shared)\/([^/\\]+)$/.exec(id);
  if (!m || !isPlainQxfName(m[2]!)) throw new Error(say(`définition inconnue : ${id}`, `unknown definition: ${id}`));
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
 * checking it reads as a definition with a manufacturer and a model. Returns the definition read.
 */
export function writeDefinition(target: string, xml: string): FixtureDefinition {
  const def = parseQxf(xml); // throws on anything that is not a definition
  if (!def.manufacturer.trim() || !def.model.trim()) throw new Error(say("définition sans fabricant ou sans modèle", "definition without a manufacturer or a model"));
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmp, xml);
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
  return def;
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A definition's text with another manufacturer and/or model, everything else to the byte (pure): the first
 * `<Manufacturer>` and `<Model>` elements' text replaced. Refused when the file has none.
 */
export function renameDefinition(xml: string, names: { manufacturer?: string; model?: string }): string {
  let out = xml;
  for (const [tag, value] of [["Manufacturer", names.manufacturer], ["Model", names.model]] as const) {
    if (value === undefined) continue;
    const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`);
    if (!re.test(out)) throw new Error(say(`élément <${tag}> absent du fichier`, `no <${tag}> element in the file`));
    out = out.replace(re, () => `<${tag}>${escapeXml(value.trim())}</${tag}>`);
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
});
export type TrashMeta = z.infer<typeof TrashMetaSchema>;
export type TrashEntry = TrashMeta & { id: string };

const META = "meta.json";
export const trashDirOf = (dataRoot: string): string => path.join(dataRoot, "backups", "deleted-definitions");

/** Moves a library file to the trash (its own folder there, with where it came from). Returns the trash entry's id. */
export function moveToTrash(dataRoot: string, full: string, meta: Omit<TrashMeta, "file" | "deletedAt">, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const id = `${stamp}-${randomBytes(3).toString("hex")}`;
  const dir = path.join(trashDirOf(dataRoot), id);
  mkdirSync(dir, { recursive: true });
  const file = path.basename(full);
  writeFileSync(path.join(dir, META), JSON.stringify({ ...meta, file, deletedAt: new Date(now).toISOString() } satisfies TrashMeta, null, 2));
  renameSync(full, path.join(dir, file));
  return id;
}

/** The trash, newest first; an entry whose note cannot be read is left out (it stays on disk). */
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
  parseQxf(readFileSync(full, "utf8")); // still a definition: never put an unreadable file back
  const name = freeFileName(dir, path.basename(full));
  mkdirSync(dir, { recursive: true });
  renameSync(full, path.join(dir, name));
  rmSync(path.join(trashDirOf(dataRoot), id), { recursive: true, force: true });
  return name;
}

/** Empties the trash for good. Returns how many definitions were removed. */
export function emptyTrash(dataRoot: string): number {
  const n = listTrash(dataRoot).length;
  rmSync(trashDirOf(dataRoot), { recursive: true, force: true });
  return n;
}

// ---- who uses a file, on the other venues of this machine

/** The other venues (folders of data/venues) whose patch resolves a model to this library file, with their fixtures' names. */
export function otherVenuesUsing(dataRoot: string, current: string, full: string): { venue: string; fixtures: string[] }[] {
  const venues = path.join(dataRoot, "venues");
  if (!existsSync(venues)) return [];
  const target = path.resolve(full);
  return readdirSync(venues)
    .filter((v) => v !== current && statSync(path.join(venues, v)).isDirectory())
    .sort()
    .flatMap((v) => {
      const files = venueJson(path.join(venues, v));
      const lookup = aliasLookup(Object.entries(files).flatMap(([name, text]) => (name.startsWith("aliases/") ? parseOr(AliasSchema, text) : [])));
      const patched = Object.entries(files).flatMap(([name, text]) => (name.startsWith("fixtures/") ? parseOr(z.object({ name: z.string(), manufacturer: z.string(), model: z.string() }).loose(), text) : []));
      const models = patchModels(files);
      const found = resolveModels(definitionDirsFor(dataRoot, v), models);
      const hit = models.filter((_, i) => found[i] && path.resolve(found[i]!.full) === target);
      const names = patched.filter((f) => {
        const to = aliasTarget(lookup, f);
        return hit.some((m) => sameName(m.manufacturer, to.manufacturer) && sameName(m.model, to.model));
      });
      return names.length ? [{ venue: v, fixtures: names.map((f) => f.name).sort() }] : [];
    });
}

/** A venue folder's patch and alias files (`fixtures/<id>.json`, `aliases/<id>.json`) as text. */
function venueJson(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sub of ["fixtures", "aliases"]) {
    const d = path.join(dir, sub);
    if (!existsSync(d)) continue;
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
