/**
 * Patch check: fixtures whose DMX channels overlap (docs/specs/venue-fixtures-stage.md, « Patch »).
 * Two fixtures writing the same channel give a light nobody chose. Twins (same model and mode at
 * the same address) are left alone: wiring two lamps to one address on purpose is common.
 * Also: fixtures ending past channel 512 (a warning), and, for information, unused gaps, fixtures
 * of one model sharing a name, and moving heads or placed fixtures without a stage position.
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

/** The last DMX slot of a universe: channels past it are never sent. */
export const UNIVERSE_SLOTS = 512;

/** A fixture whose channels run past the end of its universe (the venue's DMX conversion drops them). */
export interface PatchBeyond {
  id: string;
  universe: number;
  address: number;
  /** Its last channel, past 512. */
  last: number;
}

/** Fixtures ending past channel 512: their last channels are never sent. A real warning. */
export function patchBeyondUniverse(ranges: PatchedRange[]): PatchBeyond[] {
  return ranges.filter((r) => last(r) > UNIVERSE_SLOTS).map((r) => ({ id: r.id, universe: r.universe, address: r.address, last: last(r) }));
}

/** « Spot 3 » (U1.510) ends at channel 515: its last 3 channels are not sent. */
export function beyondMessage(b: PatchBeyond, name: (id: string) => string): string {
  const lost = b.last - UNIVERSE_SLOTS;
  return say(
    `« ${name(b.id)} » (U${b.universe}.${b.address}) finit au canal ${b.last} : ses ${lost} dernier(s) canal(aux) dépassent 512 et ne sont pas envoyés`,
    `“${name(b.id)}” (U${b.universe}.${b.address}) ends at channel ${b.last}: its last ${lost} channel(s) run past 512 and are not sent`,
  );
}

/** Free channels between two fixtures of one universe (never before the first one or after the last). */
export interface PatchGap {
  universe: number;
  /** The free channels, 1-based. */
  from: number;
  to: number;
  /** The fixture ending just before the gap, and the one starting after it. */
  after: string;
  before: string;
}

/**
 * Unused gaps between two patched fixtures: often an address typed wrong, or a mode counted wider
 * than it is. Information only: a gap may be kept on purpose (room for a fixture to come).
 */
export function patchGaps(ranges: PatchedRange[]): PatchGap[] {
  const sorted = [...ranges].sort((x, y) => x.universe - y.universe || x.address - y.address || x.id.localeCompare(y.id));
  const out: PatchGap[] = [];
  // the furthest channel reached so far in the universe, and by whom: a fixture inside a wider one leaves no gap
  let reach: { universe: number; end: number; id: string } | undefined;
  for (const r of sorted) {
    if (reach?.universe !== r.universe) reach = undefined;
    if (reach && r.address > reach.end + 1) out.push({ universe: r.universe, from: reach.end + 1, to: r.address - 1, after: reach.id, before: r.id });
    if (!reach || last(r) > reach.end) reach = { universe: r.universe, end: last(r), id: r.id };
  }
  return out;
}

/** U1.31–1.40 free between « Bar 2 » and « Spot 1 ». */
export function gapMessage(g: PatchGap, name: (id: string) => string): string {
  const span = g.from === g.to ? `U${g.universe}.${g.from}` : `U${g.universe}.${g.from}–${g.universe}.${g.to}`;
  const n = g.to - g.from + 1;
  return say(
    `${span} libre(s) entre « ${name(g.after)} » et « ${name(g.before)} » (${n} canal(aux)) : adresse à vérifier, ou place gardée exprès`,
    `${span} free between “${name(g.after)}” and “${name(g.before)}” (${n} channel(s)): check the address, or room kept on purpose`,
  );
}

/** What the name and position checks need to know of a patched fixture. */
export interface PatchedLook {
  id: string;
  name: string;
  /** Manufacturer and model: fixtures of one model are told apart by their names only. */
  model: string;
  /** Carries pan or tilt. */
  moving: boolean;
  hasPosition: boolean;
  /** Said to be somewhere on the stage (a mount, a zone it aims at) yet without coordinates. */
  placed: boolean;
}

/** Fixtures of one model sharing one name (or none): in a list, a menu or to the AI they look alike. */
export function sameModelSameName(fixtures: PatchedLook[]): { model: string; name: string; ids: string[] }[] {
  const byKey = new Map<string, { model: string; name: string; ids: string[] }>();
  for (const f of fixtures) {
    const key = `${f.model.toLowerCase()}\n${f.name.trim().toLocaleLowerCase("fr")}`;
    const entry = byKey.get(key) ?? { model: f.model, name: f.name.trim(), ids: [] };
    entry.ids.push(f.id);
    byKey.set(key, entry);
  }
  return [...byKey.values()].filter((e) => e.ids.length > 1);
}

/** 2 Acme Spot are called « Spot » (a, b). */
export function sameModelNameMessage(s: { model: string; name: string; ids: string[] }): string {
  const name = s.name || say("sans nom", "unnamed");
  return say(
    `${s.ids.length} ${s.model} s'appellent « ${name} » (${s.ids.join(", ")}) : donner à chacun un nom distinct (place, côté) pour les reconnaître`,
    `${s.ids.length} ${s.model} are called “${name}” (${s.ids.join(", ")}): give each a distinct name (place, side) to tell them apart`,
  );
}

/**
 * Fixtures without a stage position where the position matters: a moving head (aiming, its beam on
 * the plan) or a fixture said to be on the stage (a mount, a zone it aims at). A fixed PAR without a
 * position is left alone: nothing depends on it.
 */
export function missingPositions(fixtures: PatchedLook[]): { id: string; moving: boolean }[] {
  return fixtures.filter((f) => !f.hasPosition && (f.moving || f.placed)).map((f) => ({ id: f.id, moving: f.moving }));
}

export function noPositionMessage(p: { id: string; moving: boolean }, name: (id: string) => string): string {
  return p.moving
    ? say(`« ${name(p.id)} » est une lyre sans position sur la scène : pas de visée, et son faisceau est faux dans l'aperçu`, `“${name(p.id)}” is a moving head with no stage position: no aiming, and its beam is wrong in the preview`)
    : say(`« ${name(p.id)} » est placé sur la scène sans coordonnées : l'aperçu ne peut pas le montrer`, `“${name(p.id)}” is placed on the stage without coordinates: the preview cannot show it`);
}
