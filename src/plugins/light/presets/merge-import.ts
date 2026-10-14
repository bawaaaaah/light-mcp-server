/**
 * Re-import without losing work (docs/specs/presets-songs-notes.md, « mode hybride »): what an
 * import wrote is remembered by a fingerprint; on the next import, an object untouched since is
 * updated, an object edited by hand is kept and reported. Live state (DCA and fader levels, limits)
 * and what the user added (stage position, orientation, role, notes) always survive. Pure.
 */
import { createHash } from "node:crypto";
import { stableStringify } from "../data/store.js";

/** Fields that belong to the user or to the live state: never replaced by an import, never fingerprinted. */
export const KEEP_FIELDS: Record<string, string[]> = {
  fixtures: ["position", "mount", "orientation", "role", "tags", "target", "notes"],
  canvases: ["notes"],
  looks: ["manualOnly", "noCut", "danger", "notes"],
  groups: ["master", "limits", "color", "defaultButtonMode", "notes"],
  faders: ["level", "notes"],
  mappings: ["notes", "danger"],
};

type Item = { id: string } & Record<string, unknown>;

export interface MergeOutcome<T> {
  /** what to write */
  write: T[];
  added: string[];
  updated: string[];
  /** edited by hand since the last import: kept as is */
  kept: string[];
  /** imported before fingerprints existed and different from the new import: kept, to check */
  toCheck: string[];
  unchanged: string[];
  /** fingerprints to remember for what is written or unchanged */
  fingerprints: Record<string, string>;
}

const strip = (collection: string, item: Item): Item => {
  const out: Item = { ...item };
  for (const k of KEEP_FIELDS[collection] ?? []) delete out[k];
  if (collection === "groups" && out.master !== undefined) delete out.master;
  return out;
};

/** Fingerprint of an object's design (user and live fields excluded). */
export function fingerprint(collection: string, item: Item): string {
  return createHash("sha256").update(stableStringify(strip(collection, item))).digest("hex").slice(0, 16);
}

/** Incoming design + the existing object's user/live fields. Groups keep their DCA (level, mute) if they had one. */
function carry(collection: string, incoming: Item, existing: Item): Item {
  const out: Item = { ...incoming };
  for (const k of KEEP_FIELDS[collection] ?? []) {
    if (existing[k] !== undefined) out[k] = existing[k];
    else if (collection !== "groups" || k !== "master") delete out[k]; // a group gains the DCA the import gives it
  }
  return out;
}

/**
 * Merges an import into a collection. `previous`: fingerprints remembered at the last import
 * (key = id). `replace`: overwrite hand edits too (live and user fields still survive).
 */
export function mergeImport<T extends Item>(collection: string, incoming: T[], existing: (id: string) => T | undefined, previous: Record<string, string>, replace = false): MergeOutcome<T> {
  const out: MergeOutcome<T> = { write: [], added: [], updated: [], kept: [], toCheck: [], unchanged: [], fingerprints: {} };
  for (const item of incoming) {
    const cur = existing(item.id);
    const fp = fingerprint(collection, item);
    if (!cur) {
      out.write.push(item);
      out.added.push(item.id);
      out.fingerprints[item.id] = fp;
      continue;
    }
    const curFp = fingerprint(collection, cur);
    if (curFp === fp) {
      out.unchanged.push(item.id);
      out.fingerprints[item.id] = fp;
      continue;
    }
    const before = previous[item.id];
    const untouched = before !== undefined && before === curFp;
    if (untouched || replace) {
      out.write.push(carry(collection, item, cur) as T);
      out.updated.push(item.id);
      out.fingerprints[item.id] = fp;
    } else {
      (before === undefined ? out.toCheck : out.kept).push(item.id);
      if (before !== undefined) out.fingerprints[item.id] = before; // still the last imported version
    }
  }
  return out;
}
