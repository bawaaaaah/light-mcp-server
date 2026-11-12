/**
 * The intentions of a `.lightshow` archive against this machine's (T15b, docs/specs/data-cli-sdk.md
 * « Archives », decision of 2026-11-12). Ids are generated: « the same » intention made apart on two
 * machines has two ids, so restoring the archive of one on the other brings a second intention of
 * that label (a duplicate, not a replacement). The restore preview says it, and the restore can keep
 * this machine's instead: the archive's copy is then left out and what named it in the restored show
 * names this machine's. Pure: texts in, texts out.
 */
import { normalizeMood } from "../knowledge/knowledge.js";
import { AMBIANCE } from "../knowledge/intentions.js";
import { stableStringify } from "./store.js";

/** A JSON object of a show's folder, or undefined when the text is not one. */
const objectOf = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Stable form of a value: key order does not count. */
const stable = (v: unknown): string => {
  const sort = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sort) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(sort(v));
};

/**
 * Whether the archive's copy of an intention is this machine's as it is (T15b): everything the same
 * but the former labels, of which the archive's may only be some of this machine's (the machine renamed
 * it again since: it knows more names, the copy brings none). Then the restore leaves it in the library.
 */
export function sameIntention(ours: string, theirs: string): boolean {
  const a = objectOf(ours);
  const b = objectOf(theirs);
  if (!a || !b) return ours === theirs;
  const { aliases: aa, ...restA } = a;
  const { aliases: ab, ...restB } = b;
  if (stable(restA) !== stable(restB)) return false;
  const known = new Set(strings(aa).map(normalizeMood));
  return strings(ab).every((x) => known.has(normalizeMood(x)));
}

/** An intention of this machine (shipped, private file, personal library) as a restore compares it. */
export interface MachineIntention {
  id: string;
  label: string;
  origin: "generic" | "private" | "personal";
  colors: string[];
}

/** An intention the archive brings whose label one of this machine's has under another id. */
export interface IntentionTwin {
  /** The archive's (the show's after the restore). */
  id: string;
  label: string;
  /** The archive's colours, to tell the two apart. */
  colors: string[];
  /** This machine's of that label (the most specific when several: personal > private file > shipped). */
  machine: MachineIntention;
}

const RANK = { personal: 0, private: 1, generic: 2 } as const;

/**
 * The intentions of the show part to restore whose label one of this machine's has under another id:
 * two machines made « the same » apart (T15b). Only those the packing machine copied in (`fromMachine`,
 * the manifest's `intentions`): an intention of the show itself is the show's, never a twin. A machine
 * intention the archive masks is not one to keep either. Masks are left out.
 */
export function intentionTwins(show: Readonly<Record<string, string>>, machine: readonly MachineIntention[], fromMachine: readonly string[]): IntentionTwin[] {
  const twins: IntentionTwin[] = [];
  const ids = new Set(machine.map((m) => m.id));
  const files = Object.entries(show).flatMap(([p, text]) => {
    const id = /^intentions\/(.+)\.json$/.exec(p)?.[1];
    const o = id === undefined ? undefined : objectOf(text);
    return id && o ? [{ id, o }] : [];
  });
  const masked = new Set(files.filter((f) => f.o.hidden === true).map((f) => f.id));
  const candidates = machine.filter((m) => !masked.has(m.id));
  for (const { id, o } of files) {
    if (o.hidden === true || ids.has(id) || !fromMachine.includes(id)) continue;
    const label = typeof o.label === "string" && o.label ? o.label : id;
    const key = normalizeMood(label);
    const same = key ? candidates.filter((m) => normalizeMood(m.label || m.id) === key).sort((a, b) => RANK[a.origin] - RANK[b.origin] || a.id.localeCompare(b.id)) : [];
    if (same[0]) twins.push({ id, label, colors: strings(o.colors), machine: same[0] });
  }
  return twins.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/**
 * The show part to restore keeping this machine's intention for the twins named in `keep` (archive ids):
 * the archive's copy is left out, and the songs' mood and the looks' ambiance: tags that named it by id
 * name this machine's. A file that is not JSON is left as it is.
 */
export function keepMachineTwins(show: Readonly<Record<string, string>>, twins: readonly IntentionTwin[], keep: readonly string[]): Record<string, string> {
  const to = new Map(twins.filter((t) => keep.includes(t.id)).map((t) => [t.id, t.machine.id]));
  if (!to.size) return { ...show };
  const out: Record<string, string> = {};
  const swap = (w: string) => to.get(w) ?? w;
  for (const [p, text] of Object.entries(show)) {
    const id = /^intentions\/(.+)\.json$/.exec(p)?.[1];
    if (id !== undefined && to.has(id)) continue;
    const o = /^(songs|looks)\//.test(p) ? objectOf(text) : undefined;
    const next =
      o && p.startsWith("songs/") && Array.isArray(o.mood)
        ? { ...o, mood: o.mood.map((w: unknown) => (typeof w === "string" ? swap(w) : w)) }
        : o && p.startsWith("looks/") && Array.isArray(o.tags)
          ? { ...o, tags: o.tags.map((t: unknown) => (typeof t === "string" && t.startsWith(AMBIANCE) ? `${AMBIANCE}${swap(t.slice(AMBIANCE.length))}` : t)) }
          : undefined;
    out[p] = next && stable(next) !== stable(o) ? stableStringify(next) : text;
  }
  return out;
}
