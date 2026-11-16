/**
 * Model aliases (T20b, docs/specs/venue-fixtures-stage.md, « Bibliothèque », decision Q2 of 2026-11-16): a venue
 * may say that one manufacturer + model is now another one (two names of one fixture, merged). Its fixtures keep
 * their manufacturer, model and mode as patched (nothing is rewritten: removing the alias undoes it), and resolve
 * the target's definition, their mode through the alias' mode table. Pure: the venue calls `aliasTarget` from one
 * hook (Venue.definitionFor / Venue.resolve); the archive packing and the QLC+ import read the same functions.
 *
 * One hop only: a target is never itself an alias (`retargetAliases` points the aliases that named a merged model at
 * its new target), so resolution never loops.
 */
import { z } from "zod";
import { say } from "../../../core/lang.js";
import { findMode, type FixtureDefinition } from "./qxf-import.js";
import { modelKeyOrUndefined } from "./overrides.js";

const ModelNameSchema = z.object({ manufacturer: z.string().min(1), model: z.string().min(1) });
export type ModelName = z.infer<typeof ModelNameSchema>;

/** One alias, stored in the venue (collection « aliases »), keyed by `modelKey` of its `from`. */
export const AliasSchema = z.object({
  id: z.string(),
  from: ModelNameSchema,
  to: ModelNameSchema,
  /** The old model's mode names → the target's (only those whose name differs). */
  modes: z.record(z.string(), z.string()).default({}),
});
export type Alias = z.infer<typeof AliasSchema>;

/** Something aliases are read from: the venue's collection, or a plain list (an archive's files). */
export interface AliasLookup {
  get(id: string): Alias | undefined;
}

export const aliasLookup = (aliases: readonly Alias[]): AliasLookup => {
  const byId = new Map(aliases.map((a) => [a.id, a]));
  return { get: (id) => byId.get(id) };
};

/** The alias a model is under in this venue, if any. */
export function aliasOf(aliases: AliasLookup, manufacturer: string, model: string): Alias | undefined {
  const key = modelKeyOrUndefined(manufacturer, model);
  return key ? aliases.get(key) : undefined;
}

/**
 * What a patched model + mode resolves to through the venue's aliases: the target's names and mode (the mode table
 * first, else the same name, which `findMode` then compares loosely), or the patch's own when it is not aliased.
 */
export function aliasTarget(aliases: AliasLookup, patch: { manufacturer: string; model: string; mode?: string }): { manufacturer: string; model: string; mode?: string; alias?: Alias } {
  const alias = aliasOf(aliases, patch.manufacturer, patch.model);
  if (!alias) return patch;
  return { manufacturer: alias.to.manufacturer, model: alias.to.model, ...(patch.mode !== undefined ? { mode: alias.modes[patch.mode] ?? patch.mode } : {}), alias };
}

export interface ModeTable {
  /** Old mode name → target mode name, for every mode of the old model that has an equivalent. */
  modes: Record<string, string>;
  /** Modes in use (by the venue's fixtures) without an equivalent: the alias is refused while any is left. */
  unmapped: string[];
  /** Mapped modes in use whose channel count differs (the fixture's DMX footprint changes). */
  channelChanges: { mode: string; to: string; from: number; channels: number }[];
}

/**
 * The mode table of an alias: each mode of the old definition (or each mode in use when it has none any more) to
 * the target's, as `findMode` finds it (name, loose name, then the only mode with as many channels), unless `given`
 * says otherwise. `given` may only name modes the target has: refused otherwise.
 */
export function modeTable(from: FixtureDefinition | undefined, to: FixtureDefinition, used: readonly { mode: string; channels?: number }[], given: Record<string, string> = {}): ModeTable {
  for (const [old, target] of Object.entries(given))
    if (!to.modes.some((m) => m.name === target)) throw new Error(say(`mode inconnu de ${to.manufacturer} ${to.model} : ${target} (pour ${old})`, `${to.manufacturer} ${to.model} has no mode ${target} (for ${old})`));
  const counts = new Map<string, number | undefined>();
  for (const m of from?.modes ?? []) counts.set(m.name, m.channels.length);
  for (const u of used) if (!counts.has(u.mode)) counts.set(u.mode, u.channels);
  const table: ModeTable = { modes: {}, unmapped: [], channelChanges: [] };
  const usedModes = new Set(used.map((u) => u.mode));
  for (const [name, channels] of counts) {
    const target = given[name] !== undefined ? to.modes.find((m) => m.name === given[name]) : findMode(to, name, channels);
    if (!target) {
      if (usedModes.has(name)) table.unmapped.push(name);
      continue;
    }
    table.modes[name] = target.name;
    if (usedModes.has(name) && channels !== undefined && channels !== target.channels.length) table.channelChanges.push({ mode: name, to: target.name, from: channels, channels: target.channels.length });
  }
  table.unmapped.sort();
  return table;
}

/** The table as stored: only the modes whose name changes (a same name resolves by itself). */
export const storedModes = (modes: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(modes).filter(([a, b]) => a !== b));

/**
 * The aliases once `from` is merged into `to`: the new alias, and every alias that named `from` as its target now
 * naming `to` (its mode table composed through the new one), so that no target is ever an alias itself.
 */
export function retargetAliases(existing: readonly Alias[], alias: Alias): Alias[] {
  const fromKey = alias.id;
  return existing
    .filter((a) => a.id !== fromKey && modelKeyOrUndefined(a.to.manufacturer, a.to.model) === fromKey)
    .map((a) => ({ ...a, to: alias.to, modes: storedModes(Object.fromEntries([...new Set([...Object.keys(a.modes), ...Object.keys(alias.modes)])].map((m) => [m, alias.modes[a.modes[m] ?? m] ?? a.modes[m] ?? m]))) }));
}

/**
 * The library as seen through the aliases, for code that looks definitions up by name in a list (the QLC+ import): for
 * each alias whose target is in `defs`, a view of the target under the old names, its modes also reachable by their
 * old names; put first, as the alias is consulted before a definition of the old name.
 */
export function aliasedDefinitions(defs: readonly FixtureDefinition[], aliases: readonly Alias[], find: (manufacturer: string, model: string) => FixtureDefinition | undefined): FixtureDefinition[] {
  const views = aliases.flatMap((a) => {
    const target = find(a.to.manufacturer, a.to.model);
    if (!target) return [];
    const renamed = Object.entries(a.modes).flatMap(([old, name]) => {
      const m = target.modes.find((x) => x.name === name);
      return m && !target.modes.some((x) => x.name === old) ? [{ ...m, name: old }] : [];
    });
    return [{ ...target, manufacturer: a.from.manufacturer, model: a.from.model, modes: [...target.modes, ...renamed] }];
  });
  return [...views, ...defs];
}
