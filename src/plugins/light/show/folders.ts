/**
 * The folder of a look is (and stays) its `dossier:<name>` tag, the convention laid down by the
 * QLC+ import (docs/decisions.md, T17): no field in the show model, no migration — a folder is
 * nothing of its own, it exists only while some look carries it. `show.folder.move`, `.rename` and
 * `.delete` rewrite that tag. Pure (no `say`, no I/O): the web app imports it as it is (the show list, the look editor and
 * menu), so both read a look's folder the same way.
 */

/** The tag prefix that names a look's folder. */
export const FOLDER = "dossier:";

/** A look's folder: the first named `dossier:` tag, normalised (an empty one is ignored). */
export function folderOf(tags: string[]): string | undefined {
  for (const tag of tags) {
    const name = tag.startsWith(FOLDER) ? normalizeFolder(tag.slice(FOLDER.length)) : "";
    if (name) return name;
  }
  return undefined;
}

/**
 * The tags with every `dossier:*` tag (an empty name included) replaced by exactly one, only when a
 * non-empty name is given: the folder written wins, whatever the tags carried before.
 */
export function withFolder(tags: string[], folder?: string): string[] {
  return [...tags.filter((t) => !t.startsWith(FOLDER)), ...(folder ? [FOLDER + folder] : [])];
}

/** The nested folders: « Rigging/Trappe » nests « Trappe » under « Rigging », as the QLC+ import does. */
export const SEPARATOR = "/";

/** A folder path as stored: each segment trimmed with its inner runs of spaces made one, empty segments dropped (« A / B/ » is « A/B », « Mon  dossier » is « Mon dossier »: the screen shows them alike). */
export function normalizeFolder(path: string): string {
  return path
    .split(SEPARATOR)
    .map((p) => p.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join(SEPARATOR);
}

/** The names the list gives the looks without a folder (« Sans dossier », « No folder »): a folder may not take one. */
export const RESERVED_FOLDERS = ["sans dossier", "no folder"];

/** Whether a (normalised) folder path starts with a name the list already uses for the looks without a folder (« Sans dossier/Enfant » would show a « Sans dossier » header too). */
export const isReservedFolder = (path: string): boolean => RESERVED_FOLDERS.includes((path.split(SEPARATOR)[0] ?? "").toLowerCase());

/** True when a look sits in the folder `node` itself or nested under it. */
export function inTree(tags: string[], node: string): boolean {
  const f = folderOf(tags);
  return f === node || (f !== undefined && f.startsWith(node + SEPARATOR));
}

/**
 * The path `src` takes when nested under `under` (absent: back to the top, keeping its last segment); undefined when
 * `under` is the folder's own subtree, which cannot be its parent.
 */
export function nestOf(src: string, under?: string): string | undefined {
  const tail = src.slice(src.lastIndexOf(SEPARATOR) + 1);
  if (!under) return tail;
  if (under === src || under.startsWith(src + SEPARATOR)) return undefined;
  return under + SEPARATOR + tail;
}

/** The path `f` takes when `from` is renamed to `to`: the folder itself and its whole subtree move. */
export const renamedPath = (f: string, from: string, to: string): string => (f === from ? to : f.startsWith(from + SEPARATOR) ? to + f.slice(from.length) : f);

/** The folders with every parent of a nested one: « A/B » brings « A », a header of the tree even without a look of its own. Deduped, sorted. */
export function withParents(folders: Iterable<string>): string[] {
  const all = new Set<string>();
  for (const f of folders) {
    const parts = f.split(SEPARATOR);
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join(SEPARATOR));
  }
  return [...all].sort((a, b) => a.localeCompare(b));
}

/** Every folder in use, from each look's folder, with their parents: named, deduped, sorted. */
export function foldersOf(looks: { tags: string[] }[]): string[] {
  return withParents(looks.map((l) => folderOf(l.tags)).filter((f): f is string => f !== undefined));
}

/** The tags without any `dossier:*` tag: the list row leaves it to its group header. */
export function withoutFolderTag(tags: string[]): string[] {
  return tags.filter((t) => !t.startsWith(FOLDER));
}

/** A path read as people read it: « Rigging/Trappe » shown « Rigging ▸ Trappe ». */
export const folderLabel = (path: string): string => path.split(SEPARATOR).join(" ▸ ");
