/**
 * `.lightshow` archives (docs/specs/data-cli-sdk.md): a zip of the show folder (and optionally the
 * venue folder) plus a manifest. Never contains machine config or secrets; of data/private, only the
 * intentions the show uses, copied as the show's own (`show.extra`, T15).
 * Restoring first backs up the current folders, then writes the archive's files.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { say } from "../../../core/lang.js";
import { stableStringify } from "./store.js";
import { applyFixtures, patchModels, planFixtures, summarizeFixtures, usedDefinitions, isPlainQxfName, MAX_DEFINITION_BYTES, type FixturePolicy, type FixtureSummary } from "./archive-fixtures.js";

export interface ArchiveManifest {
  format: "lightshow";
  version: 1;
  createdAt: string;
  show?: string;
  venue?: string;
  /** Names of the fixture definitions carried under `fixtures/` (absent in older archives). */
  fixtures?: string[];
  /**
   * Keys of the intentions copied from the packing machine (personal library, private file) under
   * `show/intentions/` (T15): a restore on a machine that has them as they are leaves them there.
   */
  intentions?: string[];
}

/** Relative paths ("looks/joie.json") of the files of a folder, sorted; `json` picks JSON or the rest. */
function filesOf(dir: string, json: boolean, base = dir, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) filesOf(full, json, base, out);
    else if (name.endsWith(".json") === json) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

function walk(dir: string): Record<string, Uint8Array> {
  return Object.fromEntries(filesOf(dir, true).map((rel) => [rel, readFileSync(path.join(dir, rel))]));
}

/**
 * `definitionDirs`: the library folders (data/fixtures, then the venue's own), searched for the
 * definitions the packed venue's patch uses: they go under `fixtures/`, never the whole library.
 * Without a venue there is no patch, so no definitions. Two packs of the same folders differ only
 * by `createdAt` (sorted entries, fixed zip dates). `show.extra`: files added to the show's part
 * (path → text) when its folder has none of that path.
 */
export function packArchive(parts: { show?: { id: string; dir: string; extra?: Record<string, string> }; venue?: { id: string; dir: string }; definitionDirs?: string[] }): Uint8Array {
  const manifest: ArchiveManifest = { format: "lightshow", version: 1, createdAt: new Date().toISOString(), show: parts.show?.id, venue: parts.venue?.id };
  const files: Record<string, Uint8Array> = {};
  if (parts.show) for (const [p, d] of Object.entries(walk(parts.show.dir))) files[`show/${p}`] = d;
  // files the show uses from elsewhere, packed as its own (the intentions of this machine it names, T15);
  // what the folder holds wins, and the folder itself is never written
  const fromMachine: string[] = [];
  for (const [p, text] of Object.entries(parts.show?.extra ?? {})) {
    if (files[`show/${p}`]) continue;
    files[`show/${p}`] = strToU8(text);
    const key = /^intentions\/(.+)\.json$/.exec(p)?.[1];
    if (key) fromMachine.push(key);
  }
  if (fromMachine.length) manifest.intentions = fromMachine.sort();
  let venueFiles: Record<string, Uint8Array> = {};
  if (parts.venue) {
    venueFiles = walk(parts.venue.dir);
    for (const [p, d] of Object.entries(venueFiles)) files[`venue/${p}`] = d;
  }
  if (parts.venue && parts.definitionDirs) {
    const defs = usedDefinitions(parts.definitionDirs, patchModels(venueFiles));
    for (const [name, bytes] of defs) files[`fixtures/${name}`] = bytes;
    if (defs.length) manifest.fixtures = defs.map(([name]) => name);
  }
  return zipSync({ "manifest.json": strToU8(JSON.stringify(manifest, null, 2)), ...files }, { level: 6, mtime: new Date("2026-01-01T00:00:00Z") });
}

export interface ArchiveContent {
  manifest: ArchiveManifest;
  show: Record<string, string>;
  venue: Record<string, string>;
  /** Definitions by file name (`fixtures/<name>.qxf`, not yet checked). */
  fixtures: Record<string, string>;
  /** Entries under `fixtures/` that are not a plain `<name>.qxf`: ignored, named. */
  rejectedFixtures: string[];
  /** Definitions too big to read (MAX_DEFINITION_BYTES): not decompressed, named. */
  invalidFixtures: { file: string; error: string }[];
}

/** Largest an archive may grow to once decompressed (a show is a few MB): beyond, it is refused unread. */
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/** An entry name that could write outside its folder: a `..` segment (either separator) or an absolute path. */
const forbiddenEntry = (name: string) => name.split(/[\\/]/).includes("..") || path.isAbsolute(name) || /^[A-Za-z]:/.test(name);

/**
 * Reads an archive. Sizes are checked from the zip directory before anything is decompressed (a
 * small zip can inflate to gigabytes): over MAX_ARCHIVE_BYTES in all, the archive is refused; a
 * definition over MAX_DEFINITION_BYTES is skipped and named. Only the entries a restore uses are
 * decompressed. A forbidden path or a name given twice refuses the archive.
 */
export function readArchive(bytes: Uint8Array): ArchiveContent {
  const show: Record<string, string> = {};
  const venue: Record<string, string> = {};
  const fixtures: Record<string, string> = {};
  const rejectedFixtures: string[] = [];
  const invalidFixtures: { file: string; error: string }[] = [];
  const seen = new Set<string>();
  let total = 0;
  const entries = unzipSync(bytes, {
    filter: (f) => {
      const name = f.name;
      if (forbiddenEntry(name)) throw new Error(say(`chemin interdit dans l'archive : ${name}`, `forbidden path in the archive: ${name}`));
      if (seen.has(name)) throw new Error(say(`entrée en double dans l'archive : ${name}`, `duplicate entry in the archive: ${name}`));
      seen.add(name);
      if (name.endsWith("/")) return false;
      if (name.startsWith("fixtures/")) {
        if (!isPlainQxfName(name.slice(9))) {
          rejectedFixtures.push(name);
          return false;
        }
        if (f.originalSize > MAX_DEFINITION_BYTES) {
          invalidFixtures.push({ file: name.slice(9), error: say(`trop gros (${f.originalSize} octets)`, `too big (${f.originalSize} bytes)`) });
          return false;
        }
      } else if (!(name === "manifest.json" || ((name.startsWith("show/") || name.startsWith("venue/")) && name.endsWith(".json")))) return false;
      total += f.originalSize;
      if (total > MAX_ARCHIVE_BYTES) throw new Error(say("archive trop grosse une fois décompressée", "archive too big once decompressed"));
      return true;
    },
  });
  const raw = entries["manifest.json"];
  if (!raw) throw new Error(say("archive .lightshow invalide : manifest.json absent", "invalid .lightshow archive: manifest.json missing"));
  const manifest = JSON.parse(strFromU8(raw)) as ArchiveManifest;
  if (manifest.format !== "lightshow") throw new Error(say("ce fichier n'est pas une archive .lightshow", "this file is not a .lightshow archive"));
  for (const [name, data] of Object.entries(entries)) {
    if (name.startsWith("fixtures/")) fixtures[name.slice(9)] = strFromU8(data);
    else if (name.startsWith("show/")) show[name.slice(5)] = strFromU8(data);
    else if (name.startsWith("venue/")) venue[name.slice(6)] = strFromU8(data);
  }
  for (const text of [...Object.values(show), ...Object.values(venue)]) JSON.parse(text); // every file must be valid JSON
  return { manifest, show, venue, fixtures, rejectedFixtures, invalidFixtures };
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

/**
 * Replaces a folder's JSON content with the archive's, after copying the current one to
 * `backupDir`. The archive carries JSON only: the folder's other files (a venue's own .qxf
 * definitions in `fixture-definitions/`) are not its to remove and are put back.
 */
export function restoreFolder(dir: string, files: Record<string, string>, backupDir: string): void {
  const kept = filesOf(dir, false);
  if (existsSync(dir)) {
    mkdirSync(path.dirname(backupDir), { recursive: true });
    cpSync(dir, backupDir, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
  }
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(dir, rel);
    if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error(say(`chemin interdit : ${rel}`, `forbidden path: ${rel}`));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }
  for (const rel of kept) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    copyFileSync(path.join(backupDir, rel), path.join(dir, rel));
  }
}

/** A new folder for a restore's copies, `backups/restore-<date>` (never one already there). */
export function restoreBackupDir(dataRoot: string, now = new Date()): string {
  const base = path.join(dataRoot, "backups", "restore-" + now.toISOString().replace(/[:.]/g, "-"));
  let dir = base;
  for (let i = 2; existsSync(dir); i++) dir = `${base}-${i}`;
  return dir;
}

/**
 * After a restore into the open show's folder: its show.json names the venue it was packed with,
 * which may be another one since (show.venue.set / detach) — or, in a hand-made archive, no id at
 * all. The venue in place is the one restored into and kept loaded: show.json is made to say so.
 * Returns the venue the archive named when it differed. An unreadable show.json is left alone.
 */
export function pinShowVenue(showDir: string, venue: string): string | undefined {
  const file = path.join(showDir, "show.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      settings = parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (settings.venue === venue) return undefined;
  mkdirSync(showDir, { recursive: true });
  writeFileSync(file, stableStringify({ ...settings, venue }));
  return typeof settings.venue === "string" ? settings.venue : "default";
}

/** The folders a restore reads and writes. */
export interface RestoreTargets {
  showDir: string;
  venueDir: string;
  /** Id of the venue in place (the restored show stays on it). */
  venueId: string;
  /** Library folders in resolution order, and the one new definitions are written to. */
  definitionDirs: string[];
  fixturesDir: string;
  /** The JSON this machine would pack for an intention of its own (personal library, private file), if it has it (T15). */
  machineIntention?: (key: string) => string | undefined;
}

/**
 * The show part of an archive without the intentions the packing machine copied in (manifest
 * `intentions`) that this machine has as they are: they stay in its library, not copied into the show
 * (decision of 2026-11-11). Another machine, or one whose version differs, gets them as the show's.
 */
export function showToRestore(content: ArchiveContent, t: RestoreTargets): { show: Record<string, string>; known: string[] } {
  const show = { ...content.show };
  const known: string[] = [];
  for (const key of content.manifest.intentions ?? []) {
    const path_ = `intentions/${key}.json`;
    const ours = t.machineIntention?.(key);
    if (show[path_] !== undefined && ours !== undefined && canonical(ours) === canonical(show[path_]!)) {
      delete show[path_];
      known.push(key);
    }
  }
  return { show, known };
}

export interface RestorePreview {
  dryRun: true;
  manifest: ArchiveManifest;
  show: FolderDiff | null;
  venue: FolderDiff | null;
  fixtures: FixtureSummary;
  /**
   * The show's intentions (T15), counted apart: a restore replaces them like every collection of the
   * show, so an archive without any removes the show's own. Null when the show is left untouched.
   */
  intentions: CollectionCount | null;
  /** Intentions of the packing machine this one has as they are: left in its library, not copied into the show. */
  intentionsKnown: string[];
}

export interface CollectionCount {
  added: number;
  changed: number;
  removed: number;
}

/** How many objects of one collection of a folder (`<name>/…json`) a restore adds, changes and removes. */
export function countCollection(diff: FolderDiff, name: string): CollectionCount {
  const of = (paths: string[]) => paths.filter((p) => p.startsWith(`${name}/`)).length;
  return { added: of(diff.added), changed: of(diff.changed), removed: of(diff.removed) };
}

/** What restoring would change, definitions included. Writes nothing. The one function behind HTTP, commands, CLI and SDK previews. */
export function previewRestore(content: ArchiveContent, t: RestoreTargets, policy: FixturePolicy = "missing"): RestorePreview {
  const plan = planFixtures(content.fixtures, content.rejectedFixtures, t.definitionDirs, t.fixturesDir, content.invalidFixtures);
  const { show: files, known } = showToRestore(content, t);
  const show = Object.keys(content.show).length ? diffFolder(t.showDir, files) : null;
  return {
    dryRun: true,
    manifest: content.manifest,
    show,
    venue: Object.keys(content.venue).length ? diffFolder(t.venueDir, content.venue) : null,
    fixtures: summarizeFixtures(plan, policy),
    intentions: show && countCollection(show, "intentions"),
    intentionsKnown: known,
  };
}

export interface RestoreResult {
  files: { show: number; venue: number };
  fixtures: FixtureSummary;
  /** Folder (under backups) holding the copies of what was replaced. */
  backup: string;
}

/**
 * Restores an archive: the definitions are checked first (an invalid one is reported and skipped,
 * never fatal), then the show and venue folders are replaced after a copy to `backups`, then the
 * definitions the policy allows are written (a replaced one is copied to `backups/fixtures` first).
 * The caller reloads the venue afterwards (its library re-reads changed .qxf files by itself).
 */
export function applyRestore(content: ArchiveContent, t: RestoreTargets, policy: FixturePolicy, backups: string): RestoreResult {
  const plan = planFixtures(content.fixtures, content.rejectedFixtures, t.definitionDirs, t.fixturesDir, content.invalidFixtures);
  if (Object.keys(content.show).length) {
    restoreFolder(t.showDir, showToRestore(content, t).show, path.join(backups, "show"));
    pinShowVenue(t.showDir, t.venueId); // the show stays on the venue it was restored with
  }
  // the venue's own definitions (fixture-definitions/) are not JSON: restoreFolder keeps them
  if (Object.keys(content.venue).length) restoreFolder(t.venueDir, content.venue, path.join(backups, "venue"));
  const fixtures = applyFixtures(plan, policy, backups);
  return { files: { show: Object.keys(content.show).length, venue: Object.keys(content.venue).length }, fixtures, backup: path.basename(backups) };
}
