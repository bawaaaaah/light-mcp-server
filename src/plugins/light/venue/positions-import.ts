/**
 * Copying where fixtures stand from one venue onto another (docs/specs/venue-fixtures-stage.md,
 * « Reprendre les positions d'un autre lieu »). Pure: pairs the fixtures of two patches, then says
 * what moving each one would change. Only the placement travels (position, mount, orientation,
 * target); addresses, modes, names and roles stay those of the venue that receives.
 */
import type { PatchedFixture } from "./venue.js";

export type PairedBy = "id" | "name" | "model";
export interface FixturePair {
  from: PatchedFixture;
  to: PatchedFixture;
  by: PairedBy;
}
export interface Pairing {
  pairs: FixturePair[];
  /** In the source, with no equivalent in the receiving venue. */
  unmatchedSource: PatchedFixture[];
  /** In the receiving venue, that nothing in the source matched: they stay where they are. */
  unmatchedTarget: PatchedFixture[];
}

const PLACEMENT = ["position", "mount", "orientation", "target"] as const;
export type Placement = Partial<Pick<PatchedFixture, (typeof PLACEMENT)[number]>>;

const norm = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
const byAddress = (a: PatchedFixture, b: PatchedFixture): number => a.universe - b.universe || a.address - b.address || a.id.localeCompare(b.id);

/**
 * Pairs by identical id, then by name (case, accents and punctuation ignored), then by make, model
 * and mode in address order (the first bar of the source goes to the first bar of the target).
 * A fixture is paired once.
 */
export function pairFixtures(source: readonly PatchedFixture[], target: readonly PatchedFixture[]): Pairing {
  const pairs: FixturePair[] = [];
  let src = [...source].sort(byAddress);
  let dst = [...target].sort(byAddress);
  const take = (by: PairedBy, key: (f: PatchedFixture) => string): void => {
    const free = new Map<string, PatchedFixture[]>();
    for (const t of dst) free.set(key(t), [...(free.get(key(t)) ?? []), t]);
    const used = new Set<PatchedFixture>();
    const left: PatchedFixture[] = [];
    for (const f of src) {
      const t = free.get(key(f))?.shift();
      if (t) {
        pairs.push({ from: f, to: t, by });
        used.add(t);
      } else left.push(f);
    }
    src = left;
    dst = dst.filter((t) => !used.has(t));
  };
  take("id", (f) => f.id);
  take("name", (f) => norm(f.name));
  take("model", (f) => `${norm(f.manufacturer)}|${norm(f.model)}|${norm(f.mode)}`);
  return { pairs, unmatchedSource: src, unmatchedTarget: dst };
}

/** The placement of `from`, taken where it differs from `to` (nothing: already there). A source with no placement of its own changes nothing. */
export function placementChange(from: PatchedFixture, to: PatchedFixture): { fields: Placement; changed: string[] } {
  const fields: Placement = {};
  const changed: string[] = [];
  for (const k of PLACEMENT) {
    if (from[k] === undefined) continue;
    if (JSON.stringify(from[k]) !== JSON.stringify(to[k])) {
      (fields as Record<string, unknown>)[k] = from[k];
      changed.push(k);
    }
  }
  return { fields, changed };
}
