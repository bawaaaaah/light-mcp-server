/**
 * Fixture definitions (.qxf) inside `.lightshow` archives (docs/specs/data-cli-sdk.md,
 * « Définitions dans l'archive »): packing the ones a venue's patch uses, and merging an archive's
 * into the instance library on restore. Works on folders only, no server state.
 *
 * The library is a list of folders read in order (data/fixtures, then the venue's own
 * fixture-definitions), each one's `.qxf` files sorted by name (listQxfFiles, as Venue reads them):
 * the first definition of a manufacturer/model wins, as in Venue.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { say } from "../../../core/lang.js";
import { parseQxf, sameName, type FixtureDefinition } from "../venue/qxf-import.js";
import { definitionFileName, isPlainQxfName, listQxfFiles } from "../venue/definition-files.js";

export { isPlainQxfName };

/** What a restore does with the archive's definitions. */
export const FixturePolicySchema = z.enum(["missing", "replace", "none"]);
export type FixturePolicy = z.infer<typeof FixturePolicySchema>;

/** Largest definition an archive may carry (real ones are a few kB, the biggest well under 1 MB). */
export const MAX_DEFINITION_BYTES = 4 * 1024 * 1024;

/** Where the library lives for a venue: the shared folder, then the venue's own. */
export const definitionDirsFor = (dataRoot: string, venue: string): string[] => [path.join(dataRoot, "fixtures"), path.join(dataRoot, "venues", venue, "fixture-definitions")];

interface LibraryFile {
  file: string;
  full: string;
  def: FixtureDefinition;
}

interface Model {
  manufacturer: string;
  model: string;
}

/**
 * Manufacturer and model without a full parse, to skip non-candidates cheaply in a large library.
 * Undefined (parse it) when the text is not plain: an entity (`&amp;`) or CDATA would compare wrong.
 */
function header(xml: string): Model | undefined {
  const m = /<Manufacturer>([^<]*)<\/Manufacturer>/.exec(xml);
  const n = /<Model>([^<]*)<\/Model>/.exec(xml);
  if (!m || !n || m[1]!.includes("&") || n[1]!.includes("&")) return undefined;
  return { manufacturer: m[1]!.trim(), model: n[1]!.trim() };
}

const matches = (def: Model, m: Model) => sameName(def.manufacturer, m.manufacturer) && sameName(def.model, m.model);

/**
 * The library file that defines each model, in resolution order (an unreadable or unparsable file
 * is skipped, like the library does). One pass over the library: each file is read at most once.
 */
export function resolveModels(dirs: string[], models: Model[]): (LibraryFile | undefined)[] {
  const out: (LibraryFile | undefined)[] = models.map(() => undefined);
  let left = models.length;
  for (const full of dirs.flatMap(listQxfFiles)) {
    if (!left) break;
    let xml: string;
    try {
      xml = readFileSync(full, "utf8");
    } catch {
      continue; // unreadable: not part of the library
    }
    const h = header(xml);
    const wanted = models.flatMap((m, i) => (out[i] === undefined && (!h || matches(h, m)) ? [i] : []));
    if (!wanted.length) continue;
    let def: FixtureDefinition;
    try {
      def = parseQxf(xml);
    } catch {
      continue; // unreadable definition: not part of the library
    }
    for (const i of wanted) {
      if (!matches(def, models[i]!)) continue;
      out[i] = { file: path.basename(full), full, def };
      left -= 1;
    }
  }
  return out;
}

/** The manufacturer/model pairs of the fixtures in venue files (`fixtures/<id>.json`). */
export function patchModels(venueFiles: Record<string, Uint8Array | string>): Model[] {
  const seen = new Map<string, Model>();
  for (const [name, data] of Object.entries(venueFiles)) {
    if (!/^fixtures\/[^/]+\.json$/.test(name)) continue;
    try {
      const f = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8")) as { manufacturer?: unknown; model?: unknown };
      if (typeof f.manufacturer === "string" && typeof f.model === "string") seen.set(`${f.manufacturer}|${f.model}`.toLowerCase(), { manufacturer: f.manufacturer, model: f.model });
    } catch {
      /* a damaged patch file has no model to resolve */
    }
  }
  return [...seen.values()];
}

/** `name`, or `name-2.qxf`, `-3`… : the first one `taken` (lower-cased names) does not hold. Marks it taken. */
function freeName(name: string, taken: Set<string>): string {
  let out = name;
  for (let i = 2; taken.has(out.toLowerCase()); i++) out = name.replace(/\.qxf$/, `-${i}.qxf`);
  taken.add(out.toLowerCase());
  return out;
}

/**
 * The definition files the patch uses, resolved as the library does: [name in the archive, bytes],
 * sorted by name. A library file whose name is not plain (accents, leading sign, too long) goes
 * under a plain one (definitionFileName), so that the archive restores. Models with no .qxf (the
 * generic dimmer, a missing definition) give nothing.
 */
export function usedDefinitions(dirs: string[], models: Model[]): [string, Uint8Array][] {
  const files = [...new Set(resolveModels(dirs, models).flatMap((f) => (f ? [f.full] : [])))].sort();
  const taken = new Set<string>();
  const out = files.map((full): [string, Uint8Array] => {
    const base = path.basename(full);
    return [freeName(isPlainQxfName(base) ? base : definitionFileName(base), taken), readFileSync(full)];
  });
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The parsed definition with sorted keys: what « the same definition » means (layout does not count). */
function plain(v: unknown): unknown {
  if (v instanceof Map) return Object.fromEntries([...v.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, plain(x)]));
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, plain(o[k])]));
  }
  return v;
}
export const normalisedDefinition = (def: FixtureDefinition): string => JSON.stringify(plain(def));

export interface FixturePlanEntry {
  /** Name in the archive. */
  file: string;
  manufacturer: string;
  model: string;
  /** missing: no definition of this model in the library; differs: there is one, different; same: identical. */
  status: "missing" | "differs" | "same";
  /** Where it would be written: the library file it replaces, or a new file in the shared folder. */
  target: string;
  xml: string;
}

export interface FixturePlan {
  entries: FixturePlanEntry[];
  /** Did not parse as a definition (or too big to read): skipped, named. */
  invalid: { file: string; error: string }[];
  /** Entry names that are not a plain `fixtures/<name>.qxf`: skipped, named. */
  rejected: string[];
}

/**
 * What the archive's definitions would do to the library. Reads only; every file is parsed here,
 * before any write. `invalid`: entries already found unreadable (too big) while reading the archive.
 */
export function planFixtures(fixtures: Record<string, string>, rejected: string[], dirs: string[], writeDir: string, invalid: { file: string; error: string }[] = []): FixturePlan {
  const plan: FixturePlan = { entries: [], invalid: [...invalid], rejected: [...rejected].sort() };
  const models = new Set<string>();
  const valid: { file: string; xml: string; def: FixtureDefinition }[] = [];
  for (const file of Object.keys(fixtures).sort()) {
    const xml = fixtures[file]!;
    let def: FixtureDefinition;
    try {
      def = parseQxf(xml);
      if (!def.manufacturer || !def.model) throw new Error(say("fabricant ou modèle absent", "manufacturer or model missing"));
    } catch (err) {
      plan.invalid.push({ file, error: (err as Error).message });
      continue;
    }
    const key = `${def.manufacturer}|${def.model}`.toLowerCase().replace(/[^a-z0-9|]/g, "");
    if (models.has(key)) continue; // two files for one model: the first counts, as in the library
    models.add(key);
    valid.push({ file, xml, def });
  }
  plan.invalid.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const found = resolveModels(dirs, valid.map((v) => v.def));
  // names already used in the shared folder, compared without case (a case-insensitive disk would merge them)
  const taken = new Set(existsSync(writeDir) ? readdirSync(writeDir).map((n) => n.toLowerCase()) : []);
  valid.forEach(({ file, xml, def }, i) => {
    const base = { file, manufacturer: def.manufacturer, model: def.model, xml };
    const lib = found[i];
    if (lib) plan.entries.push({ ...base, status: normalisedDefinition(lib.def) === normalisedDefinition(def) ? "same" : "differs", target: lib.full });
    // a new definition: its own name in the shared folder, unless that name is already used
    else plan.entries.push({ ...base, status: "missing", target: path.join(writeDir, freeName(file, taken)) });
  });
  return plan;
}

export interface FixtureSummary {
  policy: FixturePolicy;
  /** Definitions of the archive the library lacks, and those it has differently (archive file names). */
  missing: string[];
  differs: string[];
  unchanged: number;
  invalid: { file: string; error: string }[];
  rejected: string[];
  /** What this policy would write (preview) or wrote (restore). */
  wouldImport: string[];
  wouldReplace: string[];
}

export function summarizeFixtures(plan: FixturePlan, policy: FixturePolicy): FixtureSummary {
  const of = (s: FixturePlanEntry["status"]) => plan.entries.filter((e) => e.status === s).map((e) => e.file);
  const missing = of("missing");
  const differs = of("differs");
  return {
    policy,
    missing,
    differs,
    unchanged: of("same").length,
    invalid: plan.invalid,
    rejected: plan.rejected,
    wouldImport: policy === "none" ? [] : missing,
    wouldReplace: policy === "replace" ? differs : [],
  };
}

/**
 * Writes what the policy allows. Every replaced file is first copied to `<backupDir>/fixtures/`
 * (created only when needed; two replaced files of the same name, from two library folders, keep
 * both copies), before the first definition is written. Each file is written whole (a temporary
 * file renamed over it), so the library never reads half a definition. Nothing is parsed here: the
 * plan did.
 */
export function applyFixtures(plan: FixturePlan, policy: FixturePolicy, backupDir: string): FixtureSummary {
  const summary = summarizeFixtures(plan, policy);
  const todo = plan.entries.filter((e) => (e.status === "missing" && policy !== "none") || (e.status === "differs" && policy === "replace"));
  const replaced = todo.filter((e) => e.status === "differs");
  if (replaced.length) {
    const dir = path.join(backupDir, "fixtures");
    mkdirSync(dir, { recursive: true });
    const taken = new Set(readdirSync(dir).map((n) => n.toLowerCase()));
    for (const e of replaced) copyFileSync(e.target, path.join(dir, freeName(path.basename(e.target), taken)));
  }
  for (const e of todo) {
    mkdirSync(path.dirname(e.target), { recursive: true });
    const tmp = `${e.target}.restore-tmp`; // not a .qxf: the library never reads it
    try {
      writeFileSync(tmp, e.xml, "utf8");
      renameSync(tmp, e.target);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  return summary;
}
