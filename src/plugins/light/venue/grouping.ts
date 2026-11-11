/**
 * Type groups, on proposal (docs/specs/venue-fixtures-stage.md, « Groupes par type ») : a tag per
 * kind of fixture (`lyre`, `wash`, `machine`…), read from the definition (its QLC+ type, its pan/tilt,
 * its machine outputs), and a group per kind. Nothing is written here: « Vérifier le show » and the
 * Show page propose, a click applies (`venue.grouping.apply`). No group nor tag is renamed or
 * removed: a fixture only gains a tag, a group is created (or a fixed type group made earlier is
 * completed). A gained tag may bring fixtures into an existing group selecting by tags, in this show
 * or another one on the same venue (the tags live in the venue): the proposal lists those groups,
 * so the interface says it before the click. Tags stay French (`lyre`, `barre`), in any language.
 * Pure: the caller passes the fixtures with what their definition says, and the groups.
 */
import { say } from "../../../core/lang.js";

/** Generic kinds, as tags (never translated: rules and groups select by them). */
export const TYPE_TAGS = ["lyre", "wash", "barre", "gradateur", "strobe", "laser", "effet", "machine"] as const;
export type TypeTag = (typeof TYPE_TAGS)[number];

/** What the kind of a fixture is read from. */
export interface TypedFixture {
  id: string;
  name: string;
  tags: string[];
  /** Its role, for groups selecting by role and tags. */
  role?: string;
  /** The definition's QLC+ type (« Moving Head », « Color Changer », « Hazer »…); empty without a definition. */
  type: string;
  /** Carries pan or tilt. */
  moving: boolean;
  /** Has a machine output (fog, haze, bubbles…: the `machine` capability tag). */
  machine: boolean;
  /** Has colour channels (red, green, blue…). */
  colour: boolean;
}

/** The kind of a fixture, or none (« Other », no definition). */
export function typeTagOf(f: Pick<TypedFixture, "type" | "moving" | "machine" | "colour">): TypeTag | undefined {
  const t = f.type.toLowerCase();
  if (f.moving || /moving head|scanner/.test(t)) return "lyre";
  if (f.machine || /smoke|hazer|fog|bubble|snow|flame|confetti|co2|\bfan\b/.test(t)) return "machine";
  if (/laser/.test(t)) return "laser";
  if (/strobe/.test(t)) return "strobe";
  if (/led bar/.test(t)) return "barre";
  if (/color changer|colour changer/.test(t) || (f.colour && !/dimmer|effect|flower/.test(t))) return "wash";
  if (/dimmer/.test(t)) return "gradateur";
  if (/effect|flower/.test(t)) return "effet";
  return undefined;
}

/** A group's name for a kind, in the language of whoever asks. */
export function typeGroupName(tag: TypeTag): string {
  const names: Record<TypeTag, [string, string]> = {
    lyre: ["Lyres", "Moving heads"],
    wash: ["Wash", "Washes"],
    barre: ["Barres", "Bars"],
    gradateur: ["Gradateurs", "Dimmers"],
    strobe: ["Strobes", "Strobes"],
    laser: ["Lasers", "Lasers"],
    effet: ["Effets", "Effects"],
    machine: ["Machines", "Machines"],
  };
  return say(...names[tag]);
}

/** What the proposal needs of an existing group. */
export interface ExistingGroup {
  id: string;
  name: string;
  fixtures: string[];
  /** Groups it holds: it changes when one of them does. */
  groups?: string[];
  selector?: { role?: string; tags?: string[] };
}

export interface TagProposal {
  fixture: string;
  name: string;
  tag: TypeTag;
}

export interface GroupProposal {
  tag: TypeTag;
  /** Id and name it would get: free ones (an existing group is never overwritten), or the group to complete. */
  id: string;
  name: string;
  /** Its fixtures today, in patch order, and their names. */
  fixtures: string[];
  names: string[];
  /**
   * A fixed type group made earlier that no longer holds every fixture of its kind: completing it
   * (its list rewritten) is proposed rather than a second group. `missing`: the names it lacks.
   */
  complete?: { missing: string[] };
}

/** An existing group a tag would change: a live group selecting by tag gains the fixtures tagged. */
export interface AffectedGroup {
  /** The tag whose addition changes it. */
  tag: TypeTag;
  id: string;
  name: string;
  /** Names of the fixtures that would join it. */
  joins: string[];
  /** Another show on the same venue (its name): the tags live in the venue, shared by its shows. */
  show?: string;
}

export interface TypeGrouping {
  /** Fixtures lacking the tag of their kind. */
  tags: TagProposal[];
  /** Kinds of at least two fixtures that no group gathers yet, or whose fixed type group is incomplete. */
  groups: GroupProposal[];
  /** Existing groups whose content a proposed tag would change: said before the click. */
  affected: AffectedGroup[];
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const nameKey = (name: string) => name.trim().toLocaleLowerCase("fr");

/** The fixtures of each group, its live selection and its sub-groups included. */
function membersOf(groups: ExistingGroup[], fixtures: Pick<TypedFixture, "id" | "tags" | "role">[]): Map<string, Set<string>> {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out = new Map<string, Set<string>>();
  const of = (id: string, seen: Set<string>): Set<string> => {
    const g = byId.get(id);
    if (!g || seen.has(id)) return new Set();
    seen.add(id);
    const set = new Set(g.fixtures);
    if (g.selector) for (const f of fixtures) if ((!g.selector.role || f.role === g.selector.role) && (g.selector.tags ?? []).every((t) => f.tags.includes(t))) set.add(f.id);
    for (const sub of g.groups ?? []) for (const f of of(sub, seen)) set.add(f);
    return set;
  };
  for (const g of groups) out.set(g.id, of(g.id, new Set()));
  return out;
}

/**
 * The existing groups that adding each proposed tag would change: a live group selecting by that
 * tag (alone or with others), or a group holding one of those. Per kind, as the tags are applied.
 */
export function affectedGroups(fixtures: Pick<TypedFixture, "id" | "name" | "tags" | "role">[], tags: TagProposal[], groups: ExistingGroup[]): AffectedGroup[] {
  const before = membersOf(groups, fixtures);
  const out: AffectedGroup[] = [];
  for (const tag of TYPE_TAGS) {
    const gaining = new Set(tags.filter((t) => t.tag === tag).map((t) => t.fixture));
    if (!gaining.size) continue;
    const after = membersOf(
      groups,
      fixtures.map((f) => (gaining.has(f.id) ? { ...f, tags: [...f.tags, tag] } : f)),
    );
    for (const g of groups) {
      const joins = [...after.get(g.id)!].filter((f) => !before.get(g.id)!.has(f));
      if (joins.length) out.push({ tag, id: g.id, name: g.name, joins: joins.map((id) => fixtures.find((f) => f.id === id)?.name ?? id) });
    }
  }
  return out;
}

/**
 * Tags and groups to propose. A kind is already gathered by a group that selects exactly its tag
 * (a live group) or holds exactly its fixtures (a fixed one): no group is proposed for it then. A
 * fixed type group made earlier (id `type-<tag>`) that lacks fixtures of its kind is proposed for
 * completion instead of a second one.
 */
export function proposeTypeGrouping(fixtures: TypedFixture[], groups: ExistingGroup[]): TypeGrouping {
  const byTag = new Map<TypeTag, TypedFixture[]>();
  const tags: TagProposal[] = [];
  for (const f of fixtures) {
    const tag = typeTagOf(f);
    if (!tag) continue;
    byTag.set(tag, [...(byTag.get(tag) ?? []), f]);
    if (!f.tags.includes(tag)) tags.push({ fixture: f.id, name: f.name, tag });
  }
  const ids = new Set(groups.map((g) => g.id));
  const names = new Set(groups.map((g) => nameKey(g.name)));
  const nameOf = (id: string) => fixtures.find((f) => f.id === id)?.name ?? id;
  const out: GroupProposal[] = [];
  for (const tag of TYPE_TAGS) {
    const members = (byTag.get(tag) ?? []).map((f) => f.id);
    if (members.length < 2) continue; // a group of one is the fixture itself
    const gathered = groups.some((g) => (g.selector?.tags?.length === 1 && g.selector.tags[0] === tag && !g.selector.role) || (!g.selector && sameSet(g.fixtures, members)));
    if (gathered) continue;
    // a fixed list made by this proposal earlier, a fixture of its kind patched since: complete it
    const stale = groups.find((g) => !g.selector && !g.groups?.length && new RegExp(`^type-${tag}(-\\d+)?$`).test(g.id) && g.fixtures.every((f) => members.includes(f)));
    if (stale) {
      out.push({ tag, id: stale.id, name: stale.name, fixtures: members, names: members.map(nameOf), complete: { missing: members.filter((f) => !stale.fixtures.includes(f)).map(nameOf) } });
      continue;
    }
    let id = `type-${tag}`;
    for (let k = 2; ids.has(id); k++) id = `type-${tag}-${k}`;
    const base = typeGroupName(tag);
    let name = base;
    for (let k = 1; names.has(nameKey(name)); k++) name = k === 1 ? `${base} (${tag})` : `${base} (${tag} ${k})`;
    ids.add(id);
    names.add(nameKey(name));
    out.push({ tag, id, name, fixtures: members, names: members.map(nameOf) });
  }
  return { tags, groups: out, affected: affectedGroups(fixtures, tags, groups) };
}

/** One line for « Vérifier le show »: what is proposed, what it would change, and where to apply it. */
export function groupingMessage(g: TypeGrouping): string {
  const kinds = [...new Set(g.tags.map((t) => t.tag))];
  const parts: string[] = [];
  if (g.tags.length) parts.push(say(`étiquette de type à ajouter sur ${g.tags.length} projecteur(s) (${kinds.join(", ")})`, `type tag to add on ${g.tags.length} fixture(s) (${kinds.join(", ")})`));
  const created = g.groups.filter((x) => !x.complete);
  const completed = g.groups.filter((x) => x.complete);
  if (created.length) parts.push(say(`groupe(s) à créer : ${created.map((x) => `${x.name} (${x.fixtures.length})`).join(", ")}`, `group(s) to create: ${created.map((x) => `${x.name} (${x.fixtures.length})`).join(", ")}`));
  if (completed.length) parts.push(say(`groupe(s) à compléter : ${completed.map((x) => `${x.name} (+${x.complete!.missing.length})`).join(", ")}`, `group(s) to complete: ${completed.map((x) => `${x.name} (+${x.complete!.missing.length})`).join(", ")}`));
  const where = (a: AffectedGroup) => (a.show ? say(` du show « ${a.show} »`, ` of show “${a.show}”`) : "");
  if (g.affected.length) parts.push(say(`ces étiquettes changeraient des groupes existants : ${g.affected.map((a) => `« ${a.name} »${where(a)} (+${a.joins.length})`).join(", ")}`, `these tags would change existing groups: ${g.affected.map((a) => `“${a.name}”${where(a)} (+${a.joins.length})`).join(", ")}`));
  return say(`proposé : ${parts.join(" ; ")} — rien n'est écrit sans votre accord (page Show, ou venue.grouping.apply)`, `proposed: ${parts.join("; ")} — nothing is written without your consent (Show page, or venue.grouping.apply)`);
}
