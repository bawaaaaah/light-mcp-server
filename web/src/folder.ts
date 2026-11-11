/**
 * The folder of a look is (and stays) its `dossier:<name>` tag, the convention laid down by the
 * QLC+ import (docs/specs/ui-dashboards.md): no dedicated field in the show model, no migration —
 * old shows, imports and `.lightshow` archives keep working as they are. The editor and the
 * right-click menu both write it with `look.put`, and the show list groups by it.
 */

/** The tag prefix that names a look's folder. */
export const FOLDER = "dossier:";

/** The nested folders: « Rigging/Trappe » nests « Trappe » under « Rigging », as the QLC+ import does. */
export const SEPARATOR = "/";

/** A folder path as stored: each segment trimmed with its inner runs of spaces made one, empty segments dropped (« A / B/ » is « A/B »), as the server does. */
export function normalizeFolder(path: string): string {
  return path
    .split(SEPARATOR)
    .map((p) => p.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join(SEPARATOR);
}

/** A look's folder: the first named `dossier:` tag, normalised (an empty one is ignored). */
export function folderOf(tags: string[]): string | undefined {
  for (const tag of tags) {
    const name = tag.startsWith(FOLDER) ? normalizeFolder(tag.slice(FOLDER.length)) : "";
    if (name) return name;
  }
  return undefined;
}

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

/**
 * The tags with every `dossier:*` tag (an empty name included) replaced by exactly one, only when a
 * non-empty name is given: a folder typed into the free tags field is dropped, the dedicated
 * field's folder always wins, whatever was typed first.
 */
export function withFolder(tags: string[], folder?: string): string[] {
  return [...tags.filter((t) => !t.startsWith(FOLDER)), ...(folder ? [FOLDER + folder] : [])];
}

/** The tags without any `dossier:*` tag: the list row leaves it to its group header. */
export function withoutFolderTag(tags: string[]): string[] {
  return tags.filter((t) => !t.startsWith(FOLDER));
}

/** True when a look sits in the folder `node` itself or nested under it. */
export function inTree(tags: string[], node: string): boolean {
  const f = folderOf(tags);
  return f === node || (f !== undefined && node !== "" && f.startsWith(node + SEPARATOR));
}

/** A path read as people read it: « Rigging/Trappe » shown « Rigging ▸ Trappe ». */
export const folderLabel = (path: string): string => path.split(SEPARATOR).join(" ▸ ");
