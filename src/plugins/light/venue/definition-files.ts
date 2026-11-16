/**
 * The .qxf files of a library folder, and the names a definition file may have. Shared by the
 * venue's library, `fixture.definition.add` and the `.lightshow` archives, so that all three see
 * the same files in the same order.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** A plain definition file name: starts with a letter or digit, ASCII, no folder, `.qxf` (lower case). */
const PLAIN_RE = /^[A-Za-z0-9][\w.() +-]{0,120}\.qxf$/;

export const isPlainQxfName = (name: string): boolean => PLAIN_RE.test(name);

/**
 * The `.qxf` files of a folder (full paths), sorted by name: the order the library reads them in,
 * the first definition of a model winning. Folders named `*.qxf` are not files.
 */
export function listQxfFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((x) => x.endsWith(".qxf"))
    .sort()
    .map((f) => path.join(dir, f))
    .filter((f) => {
      try {
        return statSync(f).isFile();
      } catch {
        return false;
      }
    });
}

/**
 * A plain file name for a definition from any name (accents dropped, other signs replaced by
 * `-`, at most 100 characters before `.qxf`): `Mon spot.qxf` → `Mon-spot.qxf`.
 */
export function definitionFileName(name: string): string {
  const stem = path
    .basename(name)
    .replace(/\.qxf$/i, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 100);
  return `${stem || "definition"}.qxf`;
}

/**
 * A definition file's text: as UTF-8, or byte for byte as Latin-1 when its bytes are not valid UTF-8 (an ISO-8859-1
 * file, read as `fixture.definition.export` reads it), with which one it was, so that a retouch is written back alike.
 * The library, the archives and the library commands all read a .qxf through this, so they see the same names.
 */
export function readDefinitionText(full: string): { text: string; latin1: boolean; bytes: Buffer } {
  const bytes = readFileSync(full);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), latin1: false, bytes };
  } catch {
    return { text: bytes.toString("latin1"), latin1: true, bytes };
  }
}
