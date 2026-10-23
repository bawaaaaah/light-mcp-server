/**
 * Exclusive groups as radio buttons (docs/specs/groups-masters.md, « Exclusif »): each exclusive
 * group is a set of its own, where starting a look releases only the others of that set; several
 * sets live side by side, set 1 and set 2 never touching. Putting looks in a set takes them out of
 * the other exclusive groups: from the Live, a button belongs to one set at most. Pure: the groups
 * in, the groups to save out.
 */
import type { Group } from "./model.js";

/**
 * The exclusive groups to save so that `looks` are in `target` (an exclusive group's id) and in no
 * other exclusive group; in none when `target` is undefined. Members keep their order, the new ones
 * after them.
 */
export function exclusiveMoves(groups: readonly Group[], looks: readonly string[], target?: string): Group[] {
  const moving = new Set(looks);
  const changed: Group[] = [];
  for (const g of groups) {
    if (!g.exclusive) continue;
    const before = g.members.looks;
    const after = g.id === target ? [...before, ...[...moving].filter((l) => !before.includes(l))] : before.filter((l) => !moving.has(l));
    if (after.length === before.length && after.every((l, i) => l === before[i])) continue;
    changed.push({ ...g, members: { ...g.members, looks: after } });
  }
  return changed;
}

/** A new set's name: `base` followed by the first number no group's name takes (« Exclusif 1 », « Exclusif 2 »…). */
export function nextExclusiveName(groups: readonly Group[], base: string): string {
  const names = new Set(groups.map((g) => g.name.trim().toLowerCase()));
  let n = 1;
  while (names.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
}
