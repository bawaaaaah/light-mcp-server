/**
 * Where a look, a group (DCA) or a channel fader is used in the show: groups, channel faders,
 * MIDI mappings, dashboards, snapshots, songs (sections and timeline cues) and the safe state.
 * Pure: the commands pass the show's lists. Deleting something still in use is refused unless
 * forced, so a QLC+ import's look-alike objects (three DCAs all named « Master ») cannot be
 * cleaned up by mistake.
 */
export type ReferenceKind = "look" | "group" | "fader";

/** A command whose `args.id` names an object of this kind (look.go, group.level, fader.level…). */
const COMMAND_PREFIX: Record<ReferenceKind, string> = { look: "look.", group: "group.", fader: "fader." };
/** Dashboard widgets that drive an object of this kind through `target`. */
const WIDGETS: Record<ReferenceKind, string[]> = { look: ["look"], group: ["group-fader", "xy"], fader: ["channel-fader"] };

export interface ShowParts {
  groups: { id: string; name: string; members: { looks: string[]; groups: string[] }; presets?: { included: string[]; excluded: string[] } }[];
  faders: { id: string; name: string; dca?: string }[];
  mappings: { id: string; label?: string; on: { command: string; args: Record<string, unknown> } }[];
  dashboards: { id: string; name: string; widgets: { kind: string; target?: string }[] }[];
  snapshots: { id: string; name: string; looks: string[]; groups: Record<string, unknown>; faders: Record<string, unknown> }[];
  songs: { id: string; title: string; sections: { id: string; name?: string; look?: string }[]; cues?: { command: string; args: Record<string, unknown> }[] }[];
  safeLook?: string;
}

/** One line per place that uses the object (French, as the other server messages); empty when nothing does. */
export function usesOf(kind: ReferenceKind, id: string, show: ShowParts): string[] {
  const uses: string[] = [];
  for (const g of show.groups) {
    if (kind === "look" && (g.members.looks.includes(id) || g.presets?.included.includes(id) || g.presets?.excluded.includes(id))) uses.push(`groupe « ${g.name} »`);
    if (kind === "group" && g.id !== id && g.members.groups.includes(id)) uses.push(`groupe « ${g.name} » (sous-groupe)`);
  }
  if (kind === "group") for (const f of show.faders) if (f.dca === id) uses.push(`fader de canaux « ${f.name} » (DCA)`);
  const named = (args: Record<string, unknown>) => args.id === id;
  for (const m of show.mappings) if (m.on.command.startsWith(COMMAND_PREFIX[kind]) && named(m.on.args)) uses.push(`mapping MIDI « ${m.label || m.id} »`);
  for (const d of show.dashboards) if (d.widgets.some((w) => WIDGETS[kind].includes(w.kind) && w.target === id)) uses.push(`dashboard « ${d.name} »`);
  for (const s of show.snapshots) {
    const inIt = kind === "look" ? s.looks.includes(id) : kind === "group" ? id in s.groups : id in s.faders;
    if (inIt) uses.push(`instantané « ${s.name} »`);
  }
  for (const song of show.songs) {
    const sections = kind === "look" ? song.sections.filter((s) => s.look === id) : [];
    const cues = (song.cues ?? []).filter((c) => c.command.startsWith(COMMAND_PREFIX[kind]) && named(c.args));
    if (sections.length) uses.push(`chant « ${song.title} » (${sections.map((s) => s.name ?? s.id).join(", ")})`);
    if (cues.length) uses.push(`chant « ${song.title} » (${cues.length} action${cues.length > 1 ? "s" : ""} de la piste)`);
  }
  if (kind === "look" && show.safeLook === id) uses.push("secours du Panic");
  return uses;
}

/** The refusal of a delete: what still uses the object, and how to delete it anyway. */
export function inUseMessage(name: string, uses: string[]): string {
  const shown = uses.slice(0, 6).join(", ");
  return `« ${name} » est encore utilisé : ${shown}${uses.length > 6 ? ` et ${uses.length - 6} autre(s)` : ""}. Le supprimer quand même : force: true`;
}
