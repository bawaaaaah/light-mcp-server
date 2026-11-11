/**
 * Who doses what (docs/specs/groups-masters.md, « DCA », T35): a snapshot of the groups at one instant
 * that answers, for a fixture, a look or a channel fader's DCA, which DCAs dose it — each DCA counted
 * once, however many paths reach it (a parent over two sub-groups holding the same fixture is still
 * one fader). Pure: the caller hands over the groups, how to read a group's fixtures and its own level.
 * The engine builds one per frame (a cache that never outlives it); dmx.explain builds one on demand:
 * the same rule, run at two moments.
 */
import type { Group } from "./model.js";

export interface DcaSource {
  groups: readonly Group[];
  /** A group doses now: it has a master, or a flash is held on it. A group that does not dose counts 1. */
  isDca(g: Group): boolean;
  /** Every fixture of a group: direct members, its selector, and its sub-groups' fixtures. */
  fixturesOf(groupId: string): ReadonlySet<string>;
  /** A group's own factor now (its master within its limits, mute, flash, smoothing). */
  own(g: Group): number;
}

export class DcaIndex {
  private readonly byId: Map<string, Group>;
  private readonly parents = new Map<string, string[]>();
  private readonly chains = new Map<string, ReadonlySet<string>>();
  private readonly levels = new Map<string, number>();
  private covers: Map<string, string[]> | undefined;

  constructor(private readonly source: DcaSource) {
    this.byId = new Map(source.groups.map((g) => [g.id, g]));
    for (const g of source.groups) for (const sub of g.members.groups) pushTo(this.parents, sub, g.id);
  }

  group(id: string): Group | undefined {
    return this.byId.get(id);
  }

  /** The groups of these ids that exist, in the same order. */
  groups(ids: Iterable<string>): Group[] {
    return [...ids].flatMap((id) => this.byId.get(id) ?? []);
  }

  /** A group's own factor, read once per snapshot: 1 for a group that does not dose (no master, no flash). */
  own(id: string): number {
    let level = this.levels.get(id);
    if (level === undefined) {
      const g = this.byId.get(id);
      level = g && this.source.isDca(g) ? this.source.own(g) : 1;
      this.levels.set(id, level);
    }
    return level;
  }

  /** A group and every group above it, each once (a cycle refused by the editor cannot loop here either). */
  chain(groupId: string): ReadonlySet<string> {
    const known = this.chains.get(groupId);
    if (known) return known;
    const out = new Set<string>();
    const todo = [groupId];
    while (todo.length) {
      const id = todo.pop()!;
      if (out.has(id) || !this.byId.has(id)) continue;
      out.add(id);
      todo.push(...(this.parents.get(id) ?? []));
    }
    this.chains.set(groupId, out);
    return out;
  }

  /** The DCAs covering a fixture: those holding it directly, by selector or through any sub-group (with or without a master). */
  covering(fixtureId: string): readonly string[] {
    if (!this.covers) {
      const covers = new Map<string, string[]>();
      for (const g of this.source.groups) if (this.source.isDca(g)) for (const f of this.source.fixturesOf(g.id)) pushTo(covers, f, g.id);
      this.covers = covers;
    }
    return this.covers.get(fixtureId) ?? [];
  }

  /** The groups given and every group above them, each once, without those in `except`. */
  above(groupIds: Iterable<string>, except: ReadonlySet<string> = new Set()): Set<string> {
    const out = new Set<string>();
    for (const id of groupIds) for (const g of this.chain(id)) if (!except.has(g)) out.add(g);
    return out;
  }

  /** The product of the own factors of these groups. */
  product(ids: Iterable<string>): number {
    let level = 1;
    for (const id of ids) level *= this.own(id);
    return level;
  }

  /** A group's effective level: its own factor × every group above it, each once. */
  effective(groupId: string): number {
    return this.byId.has(groupId) ? this.product(this.chain(groupId)) : 1;
  }
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
