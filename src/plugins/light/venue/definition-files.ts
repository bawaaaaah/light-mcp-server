/**
 * The .qxf files of a library folder, and the names a definition file may have. Shared by the
 * venue's library, `fixture.definition.add` and the `.lightshow` archives, so that all three see
 * the same files in the same order.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { sameName } from "./names.js";

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

/** How a definition's bytes are text: UTF-8, ISO-8859-1, or Windows-1252 (ISO-8859-1 with ’ œ € … in 0x80-0x9F). */
export type DefinitionEncoding = "utf8" | "latin1" | "windows-1252";

/** The single-byte encoding a prolog declares (`<?xml … encoding="ISO-8859-1"?>`), if any. */
export function declaredEncoding(head: string): "latin1" | "windows-1252" | undefined {
  const m = /^(?:\uFEFF)?<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
  const name = m?.[1]?.toLowerCase();
  if (!name) return undefined;
  if (/^(?:windows-1252|cp1252|x-cp1252)$/.test(name)) return "windows-1252";
  return /^(?:iso-?8859-1|iso_8859-1|latin-?1|l1)$/.test(name) ? "latin1" : undefined;
}

const WINDOWS_1252 = new TextDecoder("windows-1252");
/** The five bytes Windows-1252 leaves undefined: decoded as the control character of the same value, written back as is. */
const CP1252_UNDEFINED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);
/** The characters Windows-1252 puts in 0x80-0x9F, back to their byte. */
const CP1252_BYTES = new Map<number, number>(
  Array.from({ length: 32 }, (_, i): [number, number] => [WINDOWS_1252.decode(Uint8Array.of(0x80 + i)).codePointAt(0)!, 0x80 + i]).filter(([cp, b]) => cp !== b),
);

/**
 * A definition's text from its bytes. Valid UTF-8 with any byte beyond ASCII is UTF-8, whatever its prolog says (a file
 * saved as UTF-8 under an old declaration keeps its names). Otherwise — all ASCII, or not valid UTF-8 — the prolog's
 * single-byte encoding is followed (ISO-8859-1, Windows-1252), Latin-1 when it says none: byte for byte, so that a
 * retouch is written back the same way (`encoding`, `encodeDefinition`). `latin1`: any single-byte encoding.
 */
export function decodeDefinition(bytes: Buffer): { text: string; latin1: boolean; encoding: DefinitionEncoding; bytes: Buffer } {
  const declared = declaredEncoding(bytes.subarray(0, 200).toString("latin1"));
  const ascii = bytes.every((b) => b < 0x80);
  if (!ascii) {
    try {
      return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), latin1: false, encoding: "utf8", bytes };
    } catch {
      /* not UTF-8: a single-byte file */
    }
  } else if (!declared) return { text: bytes.toString("latin1"), latin1: false, encoding: "utf8", bytes };
  const encoding = declared ?? "latin1";
  return { text: encoding === "windows-1252" ? WINDOWS_1252.decode(bytes) : bytes.toString("latin1"), latin1: true, encoding, bytes };
}

/**
 * A definition's text as bytes in `encoding`. In a single-byte one, a character it cannot hold goes as a character
 * reference (`&#x175;`): only names the library writes can hold one (library.duplicate, an import given as text).
 */
export function encodeDefinition(text: string, encoding: DefinitionEncoding): Buffer {
  if (encoding === "utf8") return Buffer.from(text, "utf8");
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const byte = encoding === "windows-1252" ? (CP1252_BYTES.get(cp) ?? (cp <= 0xff && (!(cp >= 0x80 && cp <= 0x9f) || CP1252_UNDEFINED.has(cp)) ? cp : undefined)) : cp <= 0xff ? cp : undefined;
    if (byte !== undefined) out.push(byte);
    else for (const c of `&#x${cp.toString(16)};`) out.push(c.charCodeAt(0));
  }
  return Buffer.from(out);
}

/**
 * A definition file's text (`decodeDefinition`), read as `fixture.definition.export` reads it. The library, the archives,
 * the import (`fixture.definition.add`) and the library commands all read a .qxf through this, so they see the same names.
 */
export function readDefinitionText(full: string): { text: string; latin1: boolean; encoding: DefinitionEncoding; bytes: Buffer } {
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

/** A name as the library read it when it decoded a single-byte file as UTF-8: each byte beyond ASCII became U+FFFD. */
export const misreadName = (s: string, encoding: DefinitionEncoding = "latin1"): string => encodeDefinition(s, encoding).toString("utf8");

/**
 * The names a single-byte definition answered to before the library read it in its own encoding (T20b review 3), when
 * they differ from its own: the « legacy » names fixtures patched then still carry. Undefined for any other file.
 */
export function legacyNamesOf(def: { manufacturer: string; model: string }, encoding: DefinitionEncoding): { manufacturer: string; model: string } | undefined {
  if (encoding === "utf8") return undefined;
  // the file's own bytes, read as UTF-8 (a Windows-1252 ’ was its byte 0x92, not U+2019's Latin-1 truncation)
  const legacy = { manufacturer: misreadName(def.manufacturer, encoding), model: misreadName(def.model, encoding) };
  return sameName(legacy.manufacturer, def.manufacturer) && sameName(legacy.model, def.model) ? undefined : legacy;
}

/**
 * Whether a definition answers to a manufacturer + model: by its own names, else — `legacy` — by the names a
 * single-byte file had when it was read as UTF-8. The one rule the venue, the library's usage counts, the archives and
 * the other venues' checks share; a direct match always comes before a legacy one.
 */
export function answersTo(def: { manufacturer: string; model: string }, m: { manufacturer: string; model: string }, legacy?: { manufacturer: string; model: string }): "direct" | "legacy" | undefined {
  if (sameName(def.manufacturer, m.manufacturer) && sameName(def.model, m.model)) return "direct";
  return legacy && sameName(legacy.manufacturer, m.manufacturer) && sameName(legacy.model, m.model) ? "legacy" : undefined;
}
