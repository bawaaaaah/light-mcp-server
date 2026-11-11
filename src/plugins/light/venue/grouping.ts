/**
 * Type groups, on proposal (docs/specs/venue-fixtures-stage.md, « Groupes par type ») : a tag per
 * kind of fixture (`lyre`, `wash`, `machine`…), read from the definition (its QLC+ type, its pan/tilt,
 * its machine outputs), and a group per kind. Nothing is written here: « Vérifier le show » and the
 * Show page propose, a click applies (`venue.grouping.apply`). Existing groups and tags are never
 * renamed nor changed: a fixture only gains a tag, a group is only created.
 * Pure: the caller passes the fixtures with what their definition says, and the show's groups.
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
  selector?: { role?: string; tags?: string[] };
}

export interface TagProposal {
  fixture: string;
  name: string;
  tag: TypeTag;
}

export interface GroupProposal {
  tag: TypeTag;
  /** Id and name it would get: free ones (an existing group is never overwritten). */
  id: string;
  name: string;
  /** Its fixtures today, in patch order. */
  fixtures: string[];
}

export interface TypeGrouping {
  /** Fixtures lacking the tag of their kind. */
  tags: TagProposal[];
  /** Kinds of at least two fixtures that no group gathers yet. */
  groups: GroupProposal[];
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Tags and groups to propose. A kind is already gathered by a group that selects exactly its tag
 * (a live group) or holds exactly its fixtures (a fixed one): no group is proposed for it then.
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
  const names = new Set(groups.map((g) => g.name.trim().toLocaleLowerCase("fr")));
  const out: GroupProposal[] = [];
  for (const tag of TYPE_TAGS) {
    const members = (byTag.get(tag) ?? []).map((f) => f.id);
    if (members.length < 2) continue; // a group of one is the fixture itself
    const gathered = groups.some((g) => (g.selector?.tags?.length === 1 && g.selector.tags[0] === tag && !g.selector.role) || (!g.selector && sameSet(g.fixtures, members)));
    if (gathered) continue;
    let id = `type-${tag}`;
    for (let k = 2; ids.has(id); k++) id = `type-${tag}-${k}`;
    let name = typeGroupName(tag);
    if (names.has(name.toLocaleLowerCase("fr"))) name = `${name} (${tag})`;
    out.push({ tag, id, name, fixtures: members });
  }
  return { tags, groups: out };
}

/** One line for « Vérifier le show »: what is proposed, and where to apply it. */
export function groupingMessage(g: TypeGrouping): string {
  const kinds = [...new Set(g.tags.map((t) => t.tag))];
  const parts: string[] = [];
  if (g.tags.length) parts.push(say(`étiquette de type à ajouter sur ${g.tags.length} projecteur(s) (${kinds.join(", ")})`, `type tag to add on ${g.tags.length} fixture(s) (${kinds.join(", ")})`));
  if (g.groups.length) parts.push(say(`groupe(s) à créer : ${g.groups.map((x) => `${x.name} (${x.fixtures.length})`).join(", ")}`, `group(s) to create: ${g.groups.map((x) => `${x.name} (${x.fixtures.length})`).join(", ")}`));
  return say(`proposé : ${parts.join(" ; ")} — rien n'est écrit sans votre accord (page Show, ou venue.grouping.apply)`, `proposed: ${parts.join("; ")} — nothing is written without your consent (Show page, or venue.grouping.apply)`);
}
