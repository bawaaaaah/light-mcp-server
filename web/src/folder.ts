/**
 * The folder of a look is (and stays) its `dossier:<name>` tag, the convention laid down by the
 * QLC+ import (docs/specs/ui-dashboards.md): no dedicated field in the show model, no migration —
 * old shows, imports and `.lightshow` archives keep working as they are. The editor and the
 * right-click menu both write it with `look.put`, and the show list groups by it.
 */

/** The tag prefix that names a look's folder. */
export const FOLDER = "dossier:";

/** A look's folder: the first named `dossier:` tag (an empty one is ignored). */
export function folderOf(tags: string[]): string | undefined {
  for (const tag of tags) {
    if (tag.startsWith(FOLDER) && tag.slice(FOLDER.length)) return tag.slice(FOLDER.length);
  }
  return undefined;
}

/** Every folder in use, from each look's folder: named, deduped, sorted. */
export function foldersOf(looks: { tags: string[] }[]): string[] {
  return [...new Set(looks.map((l) => folderOf(l.tags)).filter((f): f is string => f !== undefined))].sort((a, b) => a.localeCompare(b));
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

/** The nested folders: « Rigging/Trappe » nests « Trappe » under « Rigging », as the QLC+ import does. */
export const SEPARATOR = "/";

/** True when a look sits in the folder `node` itself or nested under it. */
export function inTree(tags: string[], node: string): boolean {
  const f = folderOf(tags);
  return f === node || (f !== undefined && node !== "" && f.startsWith(node + SEPARATOR));
}

/** A path read as people read it: « Rigging/Trappe » shown « Rigging ▸ Trappe ». */
export const folderLabel = (path: string) => path.split(SEPARATOR).join(" ▸ ");
