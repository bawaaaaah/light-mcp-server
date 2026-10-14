/**
 * `.lightshow` archives (docs/specs/data-cli-sdk.md): a zip of the show folder (and optionally the
 * venue folder) plus a manifest. Never contains machine config, secrets or private files.
 * Restoring first backs up the current folders, then writes the archive's files.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export interface ArchiveManifest {
  format: "lightshow";
  version: 1;
  createdAt: string;
  show?: string;
  venue?: string;
}

function walk(dir: string, base = dir, out: Record<string, Uint8Array> = {}): Record<string, Uint8Array> {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else if (name.endsWith(".json")) out[path.relative(base, full).split(path.sep).join("/")] = readFileSync(full);
  }
  return out;
}

export function packArchive(parts: { show?: { id: string; dir: string }; venue?: { id: string; dir: string } }): Uint8Array {
  const manifest: ArchiveManifest = { format: "lightshow", version: 1, createdAt: new Date().toISOString(), show: parts.show?.id, venue: parts.venue?.id };
  const files: Record<string, Uint8Array> = { "manifest.json": strToU8(JSON.stringify(manifest, null, 2)) };
  if (parts.show) for (const [p, d] of Object.entries(walk(parts.show.dir))) files[`show/${p}`] = d;
  if (parts.venue) for (const [p, d] of Object.entries(walk(parts.venue.dir))) files[`venue/${p}`] = d;
  return zipSync(files, { level: 6, mtime: new Date("2026-01-01T00:00:00Z") });
}

export interface ArchiveContent {
  manifest: ArchiveManifest;
  show: Record<string, string>;
  venue: Record<string, string>;
}

export function readArchive(bytes: Uint8Array): ArchiveContent {
  const entries = unzipSync(bytes);
  const raw = entries["manifest.json"];
  if (!raw) throw new Error("archive .lightshow invalide : manifest.json absent");
  const manifest = JSON.parse(strFromU8(raw)) as ArchiveManifest;
  if (manifest.format !== "lightshow") throw new Error("ce fichier n'est pas une archive .lightshow");
  const show: Record<string, string> = {};
  const venue: Record<string, string> = {};
  for (const [name, data] of Object.entries(entries)) {
    if (name.includes("..") || path.isAbsolute(name)) throw new Error(`chemin interdit dans l'archive : ${name}`);
    if (!name.endsWith(".json")) continue;
    if (name.startsWith("show/")) show[name.slice(5)] = strFromU8(data);
    else if (name.startsWith("venue/")) venue[name.slice(6)] = strFromU8(data);
  }
  for (const text of [...Object.values(show), ...Object.values(venue)]) JSON.parse(text); // every file must be valid JSON
  return { manifest, show, venue };
}

export interface FolderDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
}

/** Stable form of a JSON text: key order and layout do not count as a change. */
function canonical(text: string): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  try {
    return JSON.stringify(sort(JSON.parse(text)));
  } catch {
    return text;
  }
}

/** What restoring `files` into `dir` would change (paths like "looks/joie.json"). Reads only. */
export function diffFolder(dir: string, files: Record<string, string>): FolderDiff {
  const current = Object.fromEntries(Object.entries(walk(dir)).map(([p, d]) => [p, strFromU8(d)]));
  const diff: FolderDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  for (const [p, text] of Object.entries(files)) {
    if (!(p in current)) diff.added.push(p);
    else if (canonical(current[p]!) !== canonical(text)) diff.changed.push(p);
    else diff.unchanged += 1;
  }
  for (const p of Object.keys(current)) if (!(p in files)) diff.removed.push(p);
  for (const list of [diff.added, diff.removed, diff.changed]) list.sort();
  return diff;
}

/** Replaces a folder's JSON content with the archive's, after copying the current one to `backupDir`. */
export function restoreFolder(dir: string, files: Record<string, string>, backupDir: string): void {
  if (existsSync(dir)) {
    mkdirSync(path.dirname(backupDir), { recursive: true });
    cpSync(dir, backupDir, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
  }
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(dir, rel);
    if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error(`chemin interdit : ${rel}`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }
}
