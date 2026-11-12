/**
 * Where a look, a group (DCA), a channel fader, a canvas, a patched fixture or an intention is used in the show: groups, channel faders,
 * MIDI mappings, dashboards, snapshots, songs (sections, timeline cues, overall mood), looks (a canvas, an `ambiance:` tag), rules (a fixture) and the safe state.
 * Pure: the commands pass the show's lists. Deleting something still in use is refused unless
 * forced, so a QLC+ import's look-alike objects (three DCAs all named « Master ») cannot be
 * cleaned up by mistake.
 */
import { say } from "../../../core/lang.js";
import { AMBIANCE } from "../knowledge/intentions.js";
import { normalizeMood } from "../knowledge/knowledge.js";
export type ReferenceKind = "look" | "group" | "fader" | "canvas" | "fixture" | "intention";

/**
 * A command whose `args.id` names an object of this kind (look.go, group.level, fader.level…). A
 * fixture is also named by any command's `args.fixture` or `args.fixtures` (position.set, venue.fixture.presence…).
 */
const COMMAND_PREFIX: Record<ReferenceKind, string> = { look: "look.", group: "group.", fader: "fader.", canvas: "venue.canvas.", fixture: "venue.fixture.", intention: "intention." };
/** Dashboard widgets that drive an object of this kind through `target`. */
const WIDGETS: Record<ReferenceKind, string[]> = { look: ["look"], group: ["group-fader", "xy"], fader: ["channel-fader"], canvas: [], fixture: [], intention: [] };

export interface ShowParts {
  groups: { id: string; name: string; members: { looks: string[]; groups: string[]; fixtures?: string[] }; presets?: { included: string[]; excluded: string[] } }[];
  faders: { id: string; name: string; dca?: string; channels?: { fixture: string }[] }[];
  mappings: { id: string; label?: string; on: { command: string; args: Record<string, unknown> } }[];
  dashboards: { id: string; name: string; widgets: { kind: string; target?: string }[] }[];
  snapshots: { id: string; name: string; looks: string[]; groups: Record<string, unknown>; faders: Record<string, unknown> }[];
  /** The looks play on a canvas (`look.canvas`). */
  looks: { id: string; name: string; canvas: string; move?: { group?: string }; channels?: { targets: { fixture: string }[] }; tags?: string[] }[];
  /** The canvases render onto fixtures (cell ranges → heads). */
  canvases?: { id: string; name: string; render: { targets: { fixture: string }[] }[] }[];
  songs: { id: string; title: string; mood?: string[]; sections: { id: string; name?: string; look?: string }[]; cues?: { command: string; args: Record<string, unknown> }[] }[];
  /** The show's rules, and the venue's (type and venue levels): a rule scoped to one fixture names it. */
  rules?: { id: string; name: string; scope: { fixture?: string } }[];
  venueRules?: { id: string; name: string; scope: { fixture?: string } }[];
  safeLook?: string;
  /** Snapshot recalled by the Panic, and the one recalled at startup. */
  safeSnapshot?: string;
  startupSnapshot?: string;
}

/** One line per place that uses the object (French, as the other server messages); empty when nothing does. */
export function usesOf(kind: ReferenceKind, id: string, show: ShowParts, intentionKey?: (word: string) => string): string[] {
  if (kind === "intention") return intentionUses(id, show, intentionKey);
  const uses: string[] = [];
  for (const g of show.groups) {
    if (kind === "look" && (g.members.looks.includes(id) || g.presets?.included.includes(id) || g.presets?.excluded.includes(id))) uses.push(say(`groupe « ${g.name} »`, `group “${g.name}”`));
    if (kind === "group" && g.id !== id && g.members.groups.includes(id)) uses.push(say(`groupe « ${g.name} » (sous-groupe)`, `group “${g.name}” (sub-group)`));
  }
  if (kind === "fixture") {
    for (const g of show.groups) if (g.members.fixtures?.includes(id)) uses.push(say(`groupe « ${g.name} »`, `group “${g.name}”`));
    for (const f of show.faders) if (f.channels?.some((c) => c.fixture === id)) uses.push(say(`fader de canaux « ${f.name} »`, `channel fader “${f.name}”`));
    for (const l of show.looks) if (l.channels?.targets.some((c) => c.fixture === id)) uses.push(say(`look « ${l.name} » (canaux bruts)`, `look “${l.name}” (raw channels)`));
    for (const c of show.canvases ?? []) if (c.render.some((r) => r.targets.some((t) => t.fixture === id))) uses.push(say(`canevas « ${c.name} »`, `canvas “${c.name}”`));
    for (const r of show.rules ?? []) if (r.scope.fixture === id) uses.push(say(`règle du show « ${r.name || r.id} »`, `show rule “${r.name || r.id}”`));
    for (const r of show.venueRules ?? []) if (r.scope.fixture === id) uses.push(say(`règle du lieu « ${r.name || r.id} »`, `venue rule “${r.name || r.id}”`));
  }
  if (kind === "group") for (const l of show.looks) if (l.move?.group === id) uses.push(say(`look « ${l.name} » (mouvement)`, `look “${l.name}” (move)`));
  if (kind === "group") for (const f of show.faders) if (f.dca === id) uses.push(say(`fader de canaux « ${f.name} » (DCA)`, `channel fader “${f.name}” (DCA)`));
  const canvasLooks = new Set(kind === "canvas" ? show.looks.filter((l) => l.canvas === id).map((l) => l.id) : []);
  if (kind === "canvas") for (const l of show.looks) if (l.canvas === id) uses.push(say(`look « ${l.name} »`, `look “${l.name}”`));
  const named = (command: string, args: Record<string, unknown>) =>
    (command.startsWith(COMMAND_PREFIX[kind]) && args.id === id) || (kind === "fixture" && (args.fixture === id || (Array.isArray(args.fixtures) && args.fixtures.includes(id))));
  for (const m of show.mappings) if (named(m.on.command, m.on.args)) uses.push(say(`mapping MIDI « ${m.label || m.id} »`, `MIDI mapping “${m.label || m.id}”`));
  for (const d of show.dashboards) if (d.widgets.some((w) => WIDGETS[kind].includes(w.kind) && w.target === id)) uses.push(say(`dashboard « ${d.name} »`, `dashboard “${d.name}”`));
  for (const s of show.snapshots) {
    const inIt = kind === "look" ? s.looks.includes(id) : kind === "group" ? id in s.groups : kind === "fader" ? id in s.faders : kind === "fixture" ? false : s.looks.some((l) => canvasLooks.has(l));
    if (!inIt) continue;
    // A snapshot the Panic or the startup recalls: the delete confirmation must say so.
    const roles = [s.id === show.safeSnapshot ? say("secours du Panic", "the Panic's fallback") : "", s.id === show.startupSnapshot ? say("instantané de démarrage", "the startup snapshot") : ""].filter(Boolean);
    const suffix = kind === "canvas" && roles.length ? ` (${roles.join(", ")})` : "";
    uses.push(say(`instantané « ${s.name} »${suffix}`, `snapshot “${s.name}”${suffix}`));
  }
  for (const song of show.songs) {
    const sections = kind === "look" ? song.sections.filter((s) => s.look === id) : [];
    const cues = (song.cues ?? []).filter((c) => named(c.command, c.args));
    if (sections.length) uses.push(say(`chant « ${song.title} » (${sections.map((s) => s.name ?? s.id).join(", ")})`, `song “${song.title}” (${sections.map((s) => s.name ?? s.id).join(", ")})`));
    if (cues.length) uses.push(say(`chant « ${song.title} » (${cues.length} action${cues.length > 1 ? "s" : ""} de la piste)`, `song “${song.title}” (${cues.length} track cue${cues.length > 1 ? "s" : ""})`));
  }
  if (kind === "look" && show.safeLook === id) uses.push(say("secours du Panic", "the Panic's fallback"));
  if (kind === "canvas" && show.safeLook && canvasLooks.has(show.safeLook)) uses.push(say("secours du Panic (look de secours)", "the Panic's fallback (safe look)"));
  return uses;
}

/**
 * What names an intention (T15): the songs whose overall mood holds it and the looks tagged
 * `ambiance:<it>`. `keyOf` turns a word into the intention it names: its key by default (« Joie »,
 * « joie ! » are « joie »); the commands pass `refKey` (T15b), which also finds one by its label or
 * a former one, so a word written by name counts for the intention's id.
 */
export function intentionUses(id: string, show: Pick<ShowParts, "songs" | "looks">, keyOf: (word: string) => string = normalizeMood): string[] {
  // the intention's id (or, without keyOf, a word made a key): what the words of the show are compared to
  const key = normalizeMood(id);
  const names = (w: string) => key !== "" && keyOf(w) === key;
  const uses: string[] = [];
  for (const s of show.songs) if (s.mood?.some(names)) uses.push(say(`chant « ${s.title} »`, `song “${s.title}”`));
  for (const l of show.looks) if (l.tags?.some((t) => t.startsWith(AMBIANCE) && names(t.slice(AMBIANCE.length)))) uses.push(say(`look « ${l.name} »`, `look “${l.name}”`));
  return uses;
}

/** Every intention the show names, by `keyOf` (its id, T15b), with what names it (one pass, the same lines as `intentionUses`). */
export function intentionUsesByKey(show: Pick<ShowParts, "songs" | "looks">, keyOf: (word: string) => string = normalizeMood): Map<string, string[]> {
  const uses = new Map<string, string[]>();
  const add = (word: string, line: string) => {
    const key = keyOf(word);
    const lines = uses.get(key) ?? [];
    if (key && !lines.includes(line)) uses.set(key, [...lines, line]);
  };
  for (const s of show.songs) for (const m of s.mood ?? []) add(m, say(`chant « ${s.title} »`, `song “${s.title}”`));
  for (const l of show.looks) for (const t of l.tags ?? []) if (t.startsWith(AMBIANCE)) add(t.slice(AMBIANCE.length), say(`look « ${l.name} »`, `look “${l.name}”`));
  return uses;
}

/** The refusal of a delete: what still uses the object, and how to delete it anyway. */
export function inUseMessage(name: string, uses: string[], sharedWith: string[] = []): string {
  if (!uses.length) return say(`« ${name} » appartient à un lieu partagé avec d'autres shows (${sharedWith.join(", ")}) : le supprimer le supprime aussi pour eux. Le supprimer quand même : force: true`, `“${name}” belongs to a venue shared with other shows (${sharedWith.join(", ")}): deleting it deletes it for them too. Delete it anyway: force: true`);
  const shown = uses.slice(0, 6).join(", ");
  return say(`« ${name} » est encore utilisé : ${shown}${uses.length > 6 ? ` et ${uses.length - 6} autre(s)` : ""}. Le supprimer quand même : force: true`, `“${name}” is still used: ${shown}${uses.length > 6 ? ` and ${uses.length - 6} more` : ""}. Delete it anyway: force: true`) + (sharedWith.length ? say(` Attention : ce lieu est partagé avec d'autres shows (${sharedWith.join(", ")}), qui perdent aussi cet appareil.`, ` Warning: this venue is shared with other shows (${sharedWith.join(", ")}), which lose this fixture too.`) : "");
}
