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

/** A prolog declaring a single-byte Western encoding (`<?xml … encoding="ISO-8859-1"?>`, Latin-1, Windows-1252). */
const LATIN1_PROLOG = /^(?:\uFEFF)?<\?xml[^>]*\bencoding\s*=\s*["'](?:iso-?8859-1|latin-?1|l1|windows-1252|cp1252)["']/i;

/**
 * A definition's text from its bytes: as Latin-1 byte for byte when its prolog declares ISO-8859-1 (even an all-ASCII
 * file: a retouch must be written back under that declaration) or when they are not valid UTF-8, else as UTF-8; with
 * which one it was, so that a retouch is written back alike.
 */
export function decodeDefinition(bytes: Buffer): { text: string; latin1: boolean; bytes: Buffer } {
  if (LATIN1_PROLOG.test(bytes.subarray(0, 200).toString("latin1"))) return { text: bytes.toString("latin1"), latin1: true, bytes };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), latin1: false, bytes };
  } catch {
    return { text: bytes.toString("latin1"), latin1: true, bytes };
  }
}

/**
 * A definition file's text (`decodeDefinition`), read as `fixture.definition.export` reads it. The library, the archives,
 * the import (`fixture.definition.add`) and the library commands all read a .qxf through this, so they see the same names.
 */
export function readDefinitionText(full: string): { text: string; latin1: boolean; bytes: Buffer } {
  return decodeDefinition(readFileSync(full));
}

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * A .qxf's text with its references decoded as the import reads it, in one pass: the five XML entities, the numeric
 * character references (`&#233;`, `&#x175;`; beyond Unicode kept as written, NUL and a lone surrogate dropped), and the
 * entities `declared` (a DOCTYPE's); never HTML's named entities (`&deg;`, `&nbsp;` stay as written). The import
 * (qxf-import.ts) and the export's name comparison (qxf-export.ts) share it.
 */
export function decodeXmlReferences(s: string, declared: Readonly<Record<string, string>> = {}): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z_][\w.-]*);/g, (m, e: string) => {
    if (!e.startsWith("#")) return XML_ENTITIES[e] ?? declared[e] ?? m;
    const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    if (!(cp <= 0x10ffff)) return m;
    return cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) ? "" : String.fromCodePoint(cp);
  });
}
