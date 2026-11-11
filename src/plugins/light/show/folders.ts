/**
 * The folder of a look is (and stays) its `dossier:<name>` tag, the convention laid down by the
 * QLC+ import (docs/decisions.md, T17): no field in the show model, no migration — a folder is
 * nothing of its own, it exists only while some look carries it. `show.folder.move`, `.rename` and
 * `.delete` rewrite that tag; the web UI mirrors this module in web/src/folder.ts.
 */
import { say } from "../../../core/lang.js";

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

/** Whether a (normalised) folder path is one the list already uses for the looks without a folder. */
export const isReservedFolder = (path: string): boolean => RESERVED_FOLDERS.includes(path.toLowerCase());

/** True when a look sits in the folder `node` itself or nested under it. */
export function inTree(tags: string[], node: string): boolean {
  const f = folderOf(tags);
  return f === node || (f !== undefined && f.startsWith(node + SEPARATOR));
}

/** The path `src` takes when nested under `under` (absent: back to the top, keeping its last segment). Refuses the folder's own subtree as a parent. */
export function nestOf(src: string, under?: string): string {
  const tail = src.slice(src.lastIndexOf(SEPARATOR) + 1);
  if (!under) return tail;
  if (under === src || under.startsWith(src + SEPARATOR)) throw new Error(say(`« ${src} » ne peut pas se placer sous « ${under} » : sa propre branche`, `“${src}” cannot be nested under “${under}”: its own branch`));
  return under + SEPARATOR + tail;
}

/** The path `f` takes when `from` is renamed to `to`: the folder itself and its whole subtree move. */
export const renamedPath = (f: string, from: string, to: string): string => (f === from ? to : f.startsWith(from + SEPARATOR) ? to + f.slice(from.length) : f);
