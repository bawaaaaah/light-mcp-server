/**
 * The folder of a look is (and stays) its `dossier:<name>` tag, the convention laid down by the
 * QLC+ import (docs/decisions.md, T17): no field in the show model, no migration — a folder is
 * nothing of its own, it exists only while some look carries it. `show.folder.move`, `.rename` and
 * `.delete` rewrite that tag; the web UI mirrors this module in web/src/folder.ts.
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

/**
 * The tags with every `dossier:*` tag (an empty name included) replaced by exactly one, only when a
 * non-empty name is given: the folder written wins, whatever the tags carried before.
 */
export function withFolder(tags: string[], folder?: string): string[] {
  return [...tags.filter((t) => !t.startsWith(FOLDER)), ...(folder ? [FOLDER + folder] : [])];
}
