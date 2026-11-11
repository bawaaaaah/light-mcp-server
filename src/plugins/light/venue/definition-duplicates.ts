/**
 * Duplicate fixture definitions (docs/specs/venue-fixtures-stage.md, « Bibliothèque »).
 * `findDefinition` takes the first file matching a manufacturer + model, so with two files for one
 * model the folder reading order silently decides what a patched fixture gets. This finds those
 * groups, and the same structure filed under two names. Pure: works on the loaded library, each
 * definition with the name of its source file, in loading order.
 */
import { say } from "../../../core/lang.js";
import { sameName, type FixtureDefinition } from "./qxf-import.js";

export interface LibraryEntry {
  def: FixtureDefinition;
  /** The file it came from (for messages). */
  source: string;
}

/** What differs between the winning definition and another one of the same name. */
export interface DefinitionDiff {
  type?: [string, string];
  modesOnlyInWinner: string[];
  modesOnlyInOther: string[];
  /** Modes both have, with a different channel count. */
  channelCounts: { mode: string; winner: number; other: number }[];
  /** Modes both have, same channel count, but another channel meaning or capability ranges. */
  rangesDiffer: string[];
  /** Anything else (pan/tilt travel, beam angle). */
  otherDiffers: boolean;
}

export interface SameNameGroup {
  manufacturer: string;
  model: string;
  /** The file `findDefinition` returns today (first in loading order). */
  winner: string;
  /** `identical`: the decoded content is the same (formatting, comments and file name aside). */
  others: { source: string; identical: boolean; diff?: DefinitionDiff }[];
}

export interface SameSignatureGroup {
  /** Two or more different names, each with the files holding it. */
  names: { manufacturer: string; model: string; sources: string[] }[];
}

export interface DuplicateReport {
  sameName: SameNameGroup[];
  sameSignature: SameSignatureGroup[];
}

/** Below this many channels in its widest mode a structure is too common to say anything (dimmers). */
export const MIN_SIGNATURE_CHANNELS = 3;

const stable = (v: unknown): string => JSON.stringify(v);

function channelSig(def: FixtureDefinition, name: string, withName: boolean) {
  const c = def.channels.get(name);
  if (!c) return { missing: true, name };
  return {
    ...(withName ? { name: c.name } : {}),
    attribute: c.attribute,
    color: c.color,
    fine: c.fine,
    zoom: c.zoom,
    tags: [...c.tags].sort(),
    caps: c.capabilities.map((k) => [k.min, k.max, k.name, k.preset, k.color, k.hz, [...k.tags].sort()]),
  };
}

const modeSig = (def: FixtureDefinition, mode: FixtureDefinition["modes"][number], withNames: boolean) => ({
  channels: mode.channels.map((c) => channelSig(def, c, withNames)),
  heads: mode.heads,
});

const modeExtras = (m: FixtureDefinition["modes"][number]) => [m.panMax, m.tiltMax, m.beamAngle, m.beamAngleMin];
const defExtras = (d: FixtureDefinition) => [d.panMax, d.tiltMax, d.beamAngle, d.beamAngleMin];

/** Everything that can change what a fixture does, names of manufacturer and model aside. */
const fingerprint = (d: FixtureDefinition): string => stable({ type: d.type, extras: defExtras(d), modes: d.modes.map((m) => ({ name: m.name, extras: modeExtras(m), ...modeSig(d, m, true) })) });

/** Same modes (names), channels (meaning, ranges) and heads, whatever the channels are called. */
const signature = (d: FixtureDefinition): string => stable(d.modes.map((m) => ({ name: m.name, ...modeSig(d, m, false) })));

const nameKey = (d: FixtureDefinition): string => `${d.manufacturer.toLowerCase().replace(/[^a-z0-9]/g, "")}|${d.model.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

export function diffDefinitions(winner: FixtureDefinition, other: FixtureDefinition): DefinitionDiff {
  const diff: DefinitionDiff = { modesOnlyInWinner: [], modesOnlyInOther: [], channelCounts: [], rangesDiffer: [], otherDiffers: false };
  if (winner.type !== other.type) diff.type = [winner.type, other.type];
  const otherModes = new Map(other.modes.map((m) => [m.name, m]));
  const winnerModes = new Set(winner.modes.map((m) => m.name));
  for (const m of winner.modes) {
    const o = otherModes.get(m.name);
    if (!o) diff.modesOnlyInWinner.push(m.name);
    else if (o.channels.length !== m.channels.length) diff.channelCounts.push({ mode: m.name, winner: m.channels.length, other: o.channels.length });
    else if (stable(modeSig(winner, m, true)) !== stable(modeSig(other, o, true))) diff.rangesDiffer.push(m.name);
    else if (stable(modeExtras(m)) !== stable(modeExtras(o))) diff.otherDiffers = true;
  }
  diff.modesOnlyInOther = other.modes.filter((m) => !winnerModes.has(m.name)).map((m) => m.name);
  if (stable(defExtras(winner)) !== stable(defExtras(other))) diff.otherDiffers = true;
  return diff;
}

export function findDuplicateDefinitions(library: LibraryEntry[]): DuplicateReport {
  const byName = new Map<string, LibraryEntry[]>();
  for (const e of library) {
    const k = nameKey(e.def);
    byName.set(k, [...(byName.get(k) ?? []), e]);
  }
  const report: DuplicateReport = { sameName: [], sameSignature: [] };
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const [win, ...rest] = group as [LibraryEntry, ...LibraryEntry[]];
    const fp = fingerprint(win.def);
    report.sameName.push({
      manufacturer: win.def.manufacturer,
      model: win.def.model,
      winner: win.source,
      others: rest.map((o) => (fingerprint(o.def) === fp ? { source: o.source, identical: true } : { source: o.source, identical: false, diff: diffDefinitions(win.def, o.def) })),
    });
  }
  // same structure under different names: the winner of each name speaks for it
  const bySig = new Map<string, LibraryEntry[]>();
  for (const group of byName.values()) {
    const rep = group[0]!;
    if (Math.max(0, ...rep.def.modes.map((m) => m.channels.length)) < MIN_SIGNATURE_CHANNELS) continue;
    const s = signature(rep.def);
    bySig.set(s, [...(bySig.get(s) ?? []), ...group]);
  }
  for (const entries of bySig.values()) {
    const names = new Map<string, { manufacturer: string; model: string; sources: string[] }>();
    for (const e of entries) {
      const n = names.get(nameKey(e.def)) ?? { manufacturer: e.def.manufacturer, model: e.def.model, sources: [] };
      n.sources.push(e.source);
      names.set(nameKey(e.def), n);
    }
    if (names.size > 1) report.sameSignature.push({ names: [...names.values()] });
  }
  return report;
}

/** The difference said as people read it. */
export function describeDiff(d: DefinitionDiff): string {
  const fr: string[] = [];
  const en: string[] = [];
  if (d.type) {
    fr.push(`type ${d.type[1]} au lieu de ${d.type[0]}`);
    en.push(`type ${d.type[1]} instead of ${d.type[0]}`);
  }
  if (d.modesOnlyInWinner.length) {
    fr.push(`mode(s) absent(s) : ${d.modesOnlyInWinner.join(", ")}`);
    en.push(`missing mode(s): ${d.modesOnlyInWinner.join(", ")}`);
  }
  if (d.modesOnlyInOther.length) {
    fr.push(`mode(s) en plus : ${d.modesOnlyInOther.join(", ")}`);
    en.push(`extra mode(s): ${d.modesOnlyInOther.join(", ")}`);
  }
  for (const c of d.channelCounts) {
    fr.push(`mode ${c.mode} : ${c.other} canaux au lieu de ${c.winner}`);
    en.push(`mode ${c.mode}: ${c.other} channels instead of ${c.winner}`);
  }
  if (d.rangesDiffer.length) {
    fr.push(`canaux ou plages différents (mode ${d.rangesDiffer.join(", ")})`);
    en.push(`other channels or ranges (mode ${d.rangesDiffer.join(", ")})`);
  }
  if (d.otherDiffers) {
    fr.push("autres réglages (débattement, ouverture)");
    en.push("other settings (travel, beam)");
  }
  return say(fr.join(" ; "), en.join("; "));
}

/** One sentence for a same-name group: which file wins and how the others differ. */
export function sameNameMessage(g: SameNameGroup): string {
  const others = g.others.map((o) => (o.identical ? say(`${o.source} (identique)`, `${o.source} (identical)`) : `${o.source} (${describeDiff(o.diff!)})`)).join(" ; ");
  return say(
    `${g.others.length + 1} fichiers pour ${g.manufacturer} ${g.model} : ${g.winner} est utilisé (premier dans l'ordre de lecture), les autres sont ignorés : ${others}`,
    `${g.others.length + 1} files for ${g.manufacturer} ${g.model}: ${g.winner} is used (first in reading order), the others are ignored: ${others}`,
  );
}

export function sameSignatureMessage(g: SameSignatureGroup): string {
  const names = g.names.map((n) => `${n.manufacturer} ${n.model} (${n.sources.join(", ")})`).join(" ; ");
  return say(`même structure (modes, canaux, plages) sous plusieurs noms : ${names} — doublon probable, à fusionner`, `same structure (modes, channels, ranges) under several names: ${names}: probably a duplicate, to merge`);
}

/** The groups that matter to a venue: those of a model it patches. */
export function duplicatesUsedBy(report: DuplicateReport, patched: { manufacturer: string; model: string }[]): DuplicateReport {
  const used = (m: string, n: string) => patched.some((p) => sameName(p.manufacturer, m) && sameName(p.model, n));
  return {
    sameName: report.sameName.filter((g) => used(g.manufacturer, g.model)),
    sameSignature: report.sameSignature.filter((g) => g.names.some((n) => used(n.manufacturer, n.model))),
  };
}
