/**
 * Patch check: fixtures whose DMX channels overlap (docs/specs/venue-fixtures-stage.md, « Patch »).
 * Two fixtures writing the same channel give a light nobody chose. Twins (same model and mode at
 * the same address) are left alone: wiring two lamps to one address on purpose is common.
 * Pure: the venue passes each fixture with its channel count (1 when its definition is missing).
 */
import { say } from "../../../core/lang.js";
export interface PatchedRange {
  id: string;
  name: string;
  universe: number;
  /** 1-based start address. */
  address: number;
  channels: number;
  /** Model and mode, to tell twins from mistakes. */
  kind: string;
}

export interface PatchOverlap {
  a: string;
  b: string;
  universe: number;
  /** The shared channels, 1-based. */
  from: number;
  to: number;
}

const last = (r: PatchedRange) => r.address + Math.max(1, r.channels) - 1;

export function patchOverlaps(ranges: PatchedRange[]): PatchOverlap[] {
  const sorted = [...ranges].sort((x, y) => x.universe - y.universe || x.address - y.address || x.id.localeCompare(y.id));
  const out: PatchOverlap[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (b.universe !== a.universe || b.address > last(a)) break; // sorted: nothing further starts inside a
      const twins = a.address === b.address && a.kind === b.kind && a.channels === b.channels;
      if (!twins) out.push({ a: a.id, b: b.id, universe: a.universe, from: b.address, to: Math.min(last(a), last(b)) });
    }
  }
  return out;
}

/** « Spot 3 » and « Spot 4 » share U1.12–1.15, as people read it. */
export function overlapMessage(o: PatchOverlap, name: (id: string) => string): string {
  const span = o.from === o.to ? `U${o.universe}.${o.from}` : `U${o.universe}.${o.from}–${o.universe}.${o.to}`;
  return say(`« ${name(o.a)} » et « ${name(o.b)} » partagent ${span}`, `“${name(o.a)}” and “${name(o.b)}” share ${span}`);
}
