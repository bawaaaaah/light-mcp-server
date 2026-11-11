/**
 * Design commands for the AI and the UI (docs/specs/mcp.md, « conception d'abord »): look from an
 * intention, song grid fill, show lint, knowledge base. Proposals are returned without writing
 * unless `save` is true.
 */
import { z } from "zod";
import { CommandError, type CommandRegistry } from "./registry.js";
import type { ShowRuntime } from "../show/runtime.js";
import type { Collection } from "../data/store.js";
import { slugify } from "../data/store.js";
import { mappingInputKey, type Mapping } from "../midi/mapping.js";
import type { Song } from "../songs/songs.js";
import { deltaE, EnergySchema, LOW_CONTRAST, normalizeMood, proposeLook, type Energy, type Knowledge, type KnowledgeLayers } from "../knowledge/knowledge.js";
import { embeddedIntentions, IntentionSchema, MAX_FAMILY, MAX_INTENTION_COLORS, MAX_LABEL, MAX_NOTES, mergeKnowledge, stackIntentions, type Intention, type IntentionEntry } from "../knowledge/intentions.js";
import { inUseMessage, intentionUses, intentionUsesByKey } from "../show/references.js";
import type { ShowRef } from "../show/other-shows.js";
import type { Group, Look, Palette } from "../show/model.js";
import type { Technique } from "../engine/techniques.js";
import type { Timing } from "../engine/player.js";
import { flashesPerSecond, MAX_FLASHES_PER_SECOND } from "../show/flashes.js";
import { applyRules, ruleApplies } from "../rules/rules.js";
import { zoneOf } from "../venue/stage.js";
import { groupingMessage } from "../venue/grouping.js";
import { holdAtRest, isBuiltinRule, powerOnResets, unprotectable } from "../rules/reset-protection.js";
import { crossManufacturer, duplicatesUsedBy, sameNameMessage, sameSignatureMessage } from "../venue/definition-duplicates.js";
import { canvasIssues } from "../venue/canvas-edit.js";
import { say } from "../../../core/lang.js";

/**
 * Automatic presets (docs/specs/presets-songs-notes.md, Wolfmix): base palettes from the knowledge
 * base and one look per main technique, so a new venue lights up at once. Moods, techniques and
 * cadences are chosen to cover the energies: posé, dynamique, survolté.
 */
const AUTO: { id: string; name: string; mood: string; technique: (n: number) => Technique; timing: Partial<Timing> }[] = [
  { id: "blanc-chaud", name: "Blanc chaud", mood: "lumiere", technique: () => ({ kind: "plat", color: "#fff1d6" }), timing: { every: { beats: 4 }, attack: 1 } },
  { id: "intime", name: "Intime", mood: "intimite", technique: () => ({ kind: "respiration", colors: ["#2a2f9e", "#7b3fbf"], steps: 4, depth: 0.3 }), timing: { every: { beats: 2 }, attack: 1 } },
  { id: "calme", name: "Calme", mood: "calme", technique: () => ({ kind: "onde", colors: ["#3a6ff7", "#46c8d8"], wave: "sine", depth: 0.6, spread: 1, blocks: 1, wings: false, reverse: false, resolution: 16 }), timing: { every: { beats: 0.25 }, attack: 0 } },
  { id: "joie", name: "Joie", mood: "joie", technique: (n) => ({ kind: "palette", colors: ["#ffcc1a", "#ff8a1f", "#ffffff"], block: Math.max(1, Math.round(n / 4)) }), timing: { every: { beats: 1 }, attack: 0 } },
  { id: "fete", name: "Fête", mood: "fete", technique: (n) => ({ kind: "damier", colors: ["#ff2fb3", "#18d4ff"], block: Math.max(1, Math.round(n / 4)) }), timing: { every: { beats: 0.5 }, attack: 0 } },
  { id: "force", name: "Force", mood: "force", technique: (n) => ({ kind: "creux", colors: ["#e01a1a", "#ffb000"], block: Math.max(1, Math.round(n / 4)), width: 1, floor: 0 }), timing: { every: { beats: 0.5 }, attack: 0 } },
];

const energyOfSection = (name: string): Energy => {
  const n = name.toLowerCase();
  if (/drop|vamp|final|explos|jericho|fete|fête/.test(n)) return "survolte";
  if (/refrain|chorus|declaration|déclaration|pont|bridge|groov/.test(n)) return "dynamique";
  return "pose";
};

/**
 * The layers of the colour knowledge base (T15): the files read once (generic, private), and the
 * intentions of the personal library and of the open show, read at every call (a change is seen at
 * once, without a restart; opening another show brings its own).
 */
export interface IntentionStores {
  base: () => KnowledgeLayers;
  personal: Collection<Intention>;
  show: Collection<Intention>;
  /**
   * For every key, the shows of this machine (the open one included) whose songs or looks name it
   * without an intention of their own of that key: they take it from the machine. Every show read once.
   */
  machineUsers?: () => Map<string, ShowRef[]>;
  /** The open show's id: left out of the « other shows ». */
  current?: () => string;
  /** Files of the two collections their schema refused (left out): said by show.lint. */
  loadErrors?: () => string[];
}

/** What `intention.put` and `intention.preview` take. */
const IntentionInputSchema = z.object({
  id: z.string().optional(),
  label: z.string().max(MAX_LABEL),
  colors: z.array(z.string()).min(1).max(MAX_INTENTION_COLORS),
  energy: EnergySchema.default("dynamique"),
  family: z.string().max(MAX_FAMILY).default(""),
  notes: z.string().max(MAX_NOTES).optional(),
  /** A mask (show only, a key known below): what intention.delete writes, put back by history.restore and proposals. */
  hidden: z.boolean().optional(),
});

/** A schema's refusal as a command error, its issues on one line. */
const parsedOr = <T>(parse: () => T): T => {
  try {
    return parse();
  } catch (err) {
    if (err instanceof z.ZodError) throw new CommandError("invalid", err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
    throw err;
  }
};

/** A line of the uses of an intention: another show of this machine names it. */
const otherShowLine = (show: string): string => say(`show « ${show} » (autre show de cette machine)`, `show “${show}” (another show of this machine)`);

/** The other shows that lose a personal intention with nothing below when it goes (another one does not: they fall back on it). */
const othersOf = (stores: IntentionStores, key: string, entry: IntentionEntry | undefined): string[] =>
  entry?.origin === "personal" && !entry.over ? (stores.machineUsers?.().get(key) ?? []).filter((s) => s.id !== stores.current?.()).map((s) => s.name) : [];

/**
 * Where an intention is used, for show.references and intention.delete: the open show's songs and
 * looks, and, for a personal one with nothing below (it serves every show), the other shows naming it.
 */
export function intentionReferences(stores: IntentionStores, show: { songs: Song[]; looks: Look[] }, word: string): string[] {
  const key = normalizeMood(word);
  const entry = key ? stackIntentions(stores.base(), stores.personal.list(), stores.show.list()).get(key) : undefined;
  return [...intentionUses(key, show), ...othersOf(stores, key, entry).map(otherShowLine)];
}

export function registerDesignCommands(reg: CommandRegistry, runtime: ShowRuntime, songs: Collection<Song>, mappings: () => Mapping[], intentions: IntentionStores): void {
  const stack = () => stackIntentions(intentions.base(), intentions.personal.list(), intentions.show.list());
  const knowledge = (): Knowledge => mergeKnowledge(intentions.base(), intentions.personal.list(), intentions.show.list());
  const showParts = () => ({ songs: songs.list(), looks: runtime.looks.list() });
  const usesOfIntention = (key: string) => intentionUses(key, showParts());
  /** The key of a new intention (from its label) or of one named (`given`: must already be a key). */
  const keyOf = (word: string, given: boolean): string => {
    const key = normalizeMood(word);
    if (!key) throw new CommandError("invalid", say("libellé vide : une intention a besoin d'au moins une lettre ou un chiffre", "empty label: an intention needs at least a letter or a number"));
    if (given && key !== word) throw new CommandError("invalid", say(`clé invalide : « ${word} » (attendu « ${key} »)`, `invalid key: “${word}” (expected “${key}”)`), { expected: key });
    if (key.length > 64) throw new CommandError("invalid", say("libellé trop long : sa clé dépasse 64 caractères", "label too long: its key is over 64 characters"));
    return key;
  };

  reg.register({
    name: "knowledge.get",
    title: "Base de connaissances couleur",
    description:
      "Mood keywords (intentions) → colours, energy and family, plus the design rules. Layers, the most specific winning key by key: shipped (generic) < the user's private file < personal library (this machine, every show) < the open show. Each mood says its origin (generic, private, personal, show), what a show or personal one replaces (over) and what uses it in the open show (usedBy: songs by their mood, looks by their ambiance: tag); `hidden` lists the intentions the show masks. machine: true leaves the open show out (what this machine has, for the library section).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design"],
    schema: z.object({ machine: z.boolean().default(false) }),
    run: ({ machine }) => {
      const uses = machine ? new Map<string, string[]>() : intentionUsesByKey(showParts());
      const layers = machine ? stackIntentions(intentions.base(), intentions.personal.list(), []) : stack();
      const all = [...layers.values()].map((e) => ({ ...e, usedBy: uses.get(e.id) ?? [] }));
      return { ...knowledge(), moods: Object.fromEntries(all.filter((e) => !e.hidden).map(({ id, hidden: _h, ...e }) => [id, e])), hidden: all.filter((e) => e.hidden) };
    },
  });

  reg.register({
    name: "intention.put",
    title: "Intention",
    description: `Creates or changes an intention (a mood of the colour knowledge base): label (${MAX_LABEL} characters at most), 1 to ${MAX_INTENTION_COLORS} colours (#rrggbb, the first one leads), energy (pose, dynamique, survolte), family, notes. scope "show" (default) stores it in the open show: it travels in the show's .lightshow archives and backups. scope "personal" stores it in the personal library of this machine: every show sees it, and a show's archive carries a copy of the ones it uses. Without id: a creation, the key made from the label (« Lever de rideau » → lever-de-rideau), refused when that place already has the key (detail.exists); a key of the shipped base or the private file is not taken: the new one replaces it (for the show, or for every show from the personal library). With id: that key is written (an edit; the key never follows the label: songs and ambiance: tags name it). hidden: true (show only, a key known below) writes a mask as intention.delete does, but without its guard (history.restore and show.revert put a mask back this way): songs and looks still naming it are returned in usedBy, they now name an unknown intention. Precedence: show > personal > private file > shipped.`,
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ intention: IntentionInputSchema, scope: z.enum(["show", "personal"]).default("show") }),
    run: ({ intention: input, scope }) => {
      const target = scope === "personal" ? intentions.personal : intentions.show;
      const label = input.label.trim();
      const id = input.id !== undefined ? keyOf(input.id, true) : keyOf(label, false);
      if (input.hidden) {
        // only a mask of something below, in the show: what intention.delete wrote, coming back
        const below = stackIntentions(intentions.base(), intentions.personal.list(), []).get(id);
        if (scope !== "show" || !below) throw new CommandError("invalid", say(`un masque ne se pose que dans le show, sur une intention connue plus bas : ${id}`, `a mask goes in the show only, over an intention known below: ${id}`));
      }
      const taken = input.id === undefined ? target.get(id) : undefined;
      // a mask of the show is no intention: creating over it shows the key again, with these colours
      if (taken && !taken.hidden) throw new CommandError("invalid", say(`l'intention « ${taken.label || id} » existe déjà (${id}) : choisir un autre libellé, ou la modifier`, `the intention “${taken.label || id}” already exists (${id}): choose another label, or edit it`), { exists: id });
      const saved = parsedOr(() => target.put({ ...input, id, label: label || id, ...(input.hidden ? { hidden: true } : { hidden: undefined }) }));
      const entry = stack().get(id);
      // a mask is not refused while used (a version or a proposal taken back puts it back as it was): said instead
      return { intention: saved, scope, ...(input.hidden ? { usedBy: usesOfIntention(id) } : {}), origin: entry?.origin, ...(entry?.over ? { over: entry.over } : {}), ...(scope === "personal" && entry?.origin === "show" ? { shadowedBy: "show" } : {}) };
    },
  });

  reg.register({
    name: "intention.delete",
    title: "Supprimer une intention",
    description:
      "Removes an intention, by key. scope, as for intention.put: \"personal\" takes the personal library's, whatever the open show has of that key; \"show\" the show's own only; none, the one in use. One of the show: its file goes (a touch-up gives the one below back: reverted; a mask shows the masked one again: restored). One of the personal library (the show having none of that key): removed for every show of this machine. Shipped, or from the private file: masked for this show (hidden; deleting the mask brings it back). Refused while songs (mood) or looks (ambiance: tag) of the open show use it and it would become unknown, unless force: the error names them (detail.uses). A personal one with nothing below is also refused, unless force, while other shows of this machine name it: the same error names them (detail.otherShows), as show.references does. Returns what was done: deleted, reverted, hidden or restored.",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ id: z.string(), force: z.boolean().default(false), scope: z.enum(["show", "personal"]).optional() }),
    run: ({ id: word, force, scope }) => {
      const key = normalizeMood(word);
      // scope "personal": the library's own, whatever the open show has of that key (the library section)
      const entry = !key ? undefined : scope === "personal" ? stackIntentions(intentions.base(), intentions.personal.list(), []).get(key) : stack().get(key);
      if (!entry || (scope !== undefined && entry.origin !== scope)) throw new CommandError("unknown", say(`intention inconnue : ${word}`, `unknown intention: ${word}`));
      const name = entry.label || key;
      // only what would become unknown is guarded: a touch-up removed leaves the one below. A personal
      // one with nothing below serves the other shows of the machine too: named in the same question
      const guard = (): string[] => {
        // the open show loses nothing when it has its own of that key
        const own = scope === "personal" && stack().get(key)?.origin === "show";
        const uses = own ? [] : usesOfIntention(key);
        const others = othersOf(intentions, key, entry);
        const all = [...uses, ...others.map(otherShowLine)];
        if (all.length && !force) throw new CommandError("invalid", inUseMessage(name, all), { uses, ...(others.length ? { otherShows: others } : {}) });
        return all;
      };
      const remove = (from: Collection<Intention>) => {
        if (!from.delete(key)) throw new CommandError("failed", say(`intention déjà supprimée : ${key}`, `intention already deleted: ${key}`));
      };
      if (entry.origin === "show" && entry.hidden) {
        remove(intentions.show);
        return { id: key, action: "restored" as const, origin: entry.over };
      }
      if (entry.origin === "show" || entry.origin === "personal") {
        const uses = entry.over ? [] : guard();
        remove(entry.origin === "show" ? intentions.show : intentions.personal);
        return entry.over ? { id: key, action: "reverted" as const, origin: entry.over, usedBy: uses } : { id: key, action: "deleted" as const, usedBy: uses };
      }
      // shipped or from the private file: not the show's to remove, masked for this show
      const usedBy = guard();
      intentions.show.put({ id: key, label: entry.label ?? key, colors: entry.colors, energy: entry.energy, family: entry.family, hidden: true });
      return { id: key, action: "hidden" as const, origin: entry.origin, usedBy };
    },
  });

  reg.register({
    name: "intention.library",
    title: "Bibliothèque d'intentions",
    description: "The intentions of the personal library of this machine (every show sees them), whatever show is open: each with what it replaces below (over: generic or private) and the shows of this machine naming it without an intention of their own of that key (shows).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design"],
    schema: z.object({}),
    run: () => {
      const machine = stackIntentions(intentions.base(), intentions.personal.list(), []);
      const users = intentions.machineUsers?.() ?? new Map<string, ShowRef[]>();
      return [...machine.values()].filter((e) => e.origin === "personal").map((e) => ({ ...e, shows: (users.get(e.id) ?? []).map((s) => s.name) }));
    },
  });

  reg.register({
    name: "intention.preview",
    title: "Aperçu d'une intention",
    description: `What look.from_intent would propose for an intention as typed, before it is saved: technique, timing, energy, explanation, the contrast (ΔE) between its first two colours and whether it is low (lowContrast, below ${LOW_CONTRAST}). Writes nothing; no canvas needed.`,
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design"],
    schema: z.object({ intention: IntentionInputSchema }),
    run: ({ intention: input }) => {
      const parsed = parsedOr(() => IntentionSchema.parse({ ...input, id: "apercu", hidden: undefined }));
      const label = input.label.trim() || say("cette intention", "this intention");
      const p = proposeLook({ ...knowledge(), moods: { apercu: { label, colors: parsed.colors, energy: parsed.energy, family: parsed.family } } }, { mood: ["apercu"] });
      const [a, b] = parsed.colors;
      const contrast = a && b ? Math.round(deltaE(a, b)) : undefined;
      return { technique: p.technique, timing: p.timing, energy: p.energy, explanation: p.explanation, ...(contrast !== undefined ? { contrast, lowContrast: contrast < LOW_CONTRAST } : {}) };
    },
  });

  reg.register({
    name: "look.from_intent",
    title: "Look par intention",
    description:
      "Proposes a look from an intention: mood keywords (e.g. intimite, joie, victoire), optional energy (pose, dynamique, survolte), extra colours, cut (true = claque, false = respire). Returns the look and an explanation; saved only if save is true.",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ name: z.string(), canvas: z.string(), mood: z.array(z.string()).min(1), energy: z.enum(["pose", "dynamique", "survolte"]).optional(), colors: z.array(z.string()).optional(), cut: z.boolean().optional(), id: z.string().optional(), save: z.boolean().default(false) }),
    run: ({ name, canvas, mood, energy, colors, cut, id, save }) => {
      if (!runtime.venue.canvases.get(canvas)) throw new Error(say(`canevas inconnu : ${canvas}`, `unknown canvas: ${canvas}`));
      const p = proposeLook(knowledge(), { mood, energy, colors, cut });
      const look = { id: id ?? slugify(name), name, canvas, technique: p.technique, timing: p.timing, manualOnly: false, noCut: false, danger: false, tags: mood.map((m) => `ambiance:${m}`), notes: p.explanation.join(" ; ") } as Look;
      if (save) runtime.looks.put(look);
      return { saved: save, look, explanation: p.explanation, unknownMoods: p.unknownMoods };
    },
  });

  reg.register({
    name: "song.grid_fill",
    title: "Remplir la grille d'un chant",
    description:
      "Gives every section without a look a proposed one, following the method: the song's mood is the guard rail, energy from the section (or its name: intro/couplet posé, refrain/pont dynamique, final/vamp survolté), dominant/accent swapped between neighbours for contrast. Also creates the song's exclusive group. Saved only if save is true.",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ song: z.string(), canvas: z.string(), energies: z.record(z.string(), z.enum(["pose", "dynamique", "survolte"])).prefault({}), save: z.boolean().default(false) }),
    run: ({ song: songId, canvas, energies, save }) => {
      const song = songs.get(songId);
      if (!song) throw new Error(say(`chant inconnu : ${songId}`, `unknown song: ${songId}`));
      if (!song.mood.length) throw new Error(say("le chant n'a pas d'ambiance globale (mood) : c'est le garde-fou de la grille", "the song has no overall mood: the grid relies on it"));
      const proposals: { section: string; look: Look; explanation: string[] }[] = [];
      let flip = false;
      for (const sec of song.sections) {
        if (sec.look) continue;
        const energy = energies[sec.id] ?? energyOfSection(sec.name);
        const p = proposeLook(knowledge(), { mood: song.mood, energy });
        const colors = flip ? [...p.colors].reverse() : p.colors; // neighbours swap dominant and accent
        flip = !flip;
        const again = proposeLook(knowledge(), { mood: [], energy, colors });
        const look = { id: `${song.id}-${sec.id}`, name: `${song.title} · ${sec.name}`, canvas, technique: again.technique, timing: again.timing, manualOnly: false, noCut: false, danger: false, tags: [`chant:${song.id}`, ...song.mood.map((m) => `ambiance:${m}`)], notes: [...p.explanation, sec.idea ? `idée : ${sec.idea}` : ""].filter(Boolean).join(" ; ") } as Look;
        proposals.push({ section: sec.id, look, explanation: again.explanation });
      }
      if (save) {
        for (const p of proposals) runtime.looks.put(p.look);
        songs.put({ ...song, sections: song.sections.map((s) => ({ ...s, look: s.look ?? proposals.find((p) => p.section === s.id)?.look.id })) });
        const looks = [...new Set([...song.sections.map((s) => s.look).filter((x): x is string => Boolean(x)), ...proposals.map((p) => p.look.id)])];
        const g = runtime.groups.get(`sections-${song.id}`);
        runtime.groups.put({ id: `sections-${song.id}`, name: `Sections · ${song.title}`, exclusive: true, members: { fixtures: g?.members.fixtures ?? [], looks, groups: [] } });
      }
      return { saved: save, proposals };
    },
  });

  reg.register({
    name: "show.lint",
    title: "Vérifier le show",
    description: "Offline checks: unknown references (canvas, palette, look, group, channel fader, rule program, fixture), channel fader channels outside the fixture's mode, sections without look, MIDI inputs used twice, low contrast in two-colour techniques, identical looks on neighbouring sections, songs without mood, songs naming an unknown (or masked) intention, keywords of the private intentions file that make one key, intention files left out unreadable, looks, groups or channel faders sharing a name, MIDI mappings with one label for different targets, fixtures whose DMX channels overlap or run past channel 512, fixtures without a definition, looks flashing faster than 3 times a second (photosensitive safety, at the show's fastest tempo), raw channels of looks that the rules bound, channel faders at 0 that darken the fixtures whose dimmer they dose, Reset channels made of maintenance ranges only (the built-in Reset protection cannot hold them at rest), canvases with reversed or out-of-bounds ranges, fixtures or heads not in the patch, looks of exact steps whose rows do not have one column per cell. Level info (nothing wrong, worth knowing): songs naming an intention of this machine (personal library, private file: the show's archives carry a copy), unused gaps in the patch, fixtures of one model sharing a name, moving heads or placed fixtures without a stage position, definitions without <Head> repeating a colour component out of any head (only one zone gets the colour), canvas cells that render nothing or one head on several cells, and the type tags and groups venue.grouping.propose proposes.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design", "setup"],
    schema: z.object({}),
    run: () => {
      const issues: { level: "erreur" | "attention" | "info"; where: string; message: string }[] = [];
      const err = (where: string, message: string) => issues.push({ level: "erreur", where, message });
      const warn = (where: string, message: string) => issues.push({ level: "attention", where, message });
      // worth knowing, nothing wrong: a gap kept on purpose, a proposal
      const note = (where: string, message: string) => issues.push({ level: "info", where, message });
      for (const l of runtime.looks.list()) {
        if (!runtime.venue.canvases.get(l.canvas)) err(`look ${l.id}`, say(`canevas inconnu ${l.canvas}`, `unknown canvas ${l.canvas}`));
        if (l.palette && !runtime.palettes.get(l.palette)) err(`look ${l.id}`, say(`palette inconnue ${l.palette}`, `unknown palette ${l.palette}`));
        const t = l.technique;
        if ((t.kind === "damier" || t.kind === "creux" || t.kind === "masques") && !l.palette) {
          const d = deltaE(t.colors[0], t.colors[1]);
          if (d < LOW_CONTRAST && t.colors[0] !== t.colors[1]) warn(`look ${l.id}`, say(`contraste faible entre ${t.colors[0]} et ${t.colors[1]} (ΔE ${d.toFixed(0)})`, `low contrast between ${t.colors[0]} and ${t.colors[1]} (ΔE ${d.toFixed(0)})`));
        }
      }
      issues.push(...canvasIssues(runtime.venue.canvases.list(), runtime.looks.list(), { headsOf: (f) => runtime.venue.canvasHeads(f) }));
      const seen = new Map<string, string>();
      for (const m of mappings()) {
        const key = mappingInputKey(m);
        // The mapper fires every mapping of an input, as QLC+ fires every widget bound to it: one CC
        // driving a DCA and a channel fader is by design, so this is worth a look, not an error.
        if (seen.has(key)) warn(`mapping ${m.id}`, say(`même entrée que ${seen.get(key)} : les deux se déclenchent ensemble`, `same input as ${seen.get(key)}: both fire together`));
        seen.set(key, m.id);
        const target = m.on.args.id;
        if (typeof target === "string" && target) {
          if (m.on.command.startsWith("look.") && !runtime.looks.get(target)) err(`mapping ${m.id}`, say(`look inconnu ${target}`, `unknown look ${target}`));
          if (m.on.command.startsWith("group.") && !runtime.groups.get(target)) err(`mapping ${m.id}`, say(`groupe inconnu ${target}`, `unknown group ${target}`));
          if (m.on.command.startsWith("fader.") && !runtime.faders.get(target)) err(`mapping ${m.id}`, say(`fader de canaux inconnu ${target}`, `unknown channel fader ${target}`));
          if (m.on.command === "program.select" && !runtime.programs.get(target)) err(`mapping ${m.id}`, say(`programme inconnu ${target}`, `unknown program ${target}`));
        }
      }
      for (const g of runtime.groups.list()) {
        for (const f of g.members.fixtures) if (!runtime.venue.fixtures.get(f)) err(say(`groupe ${g.id}`, `group ${g.id}`), say(`projecteur inconnu ${f}`, `unknown fixture ${f}`));
        for (const l of [...g.members.looks, ...g.presets.included, ...g.presets.excluded]) if (!runtime.looks.get(l)) err(say(`groupe ${g.id}`, `group ${g.id}`), say(`look inconnu ${l}`, `unknown look ${l}`));
        for (const sub of g.members.groups) if (!runtime.groups.get(sub)) err(say(`groupe ${g.id}`, `group ${g.id}`), say(`sous-groupe inconnu ${sub}`, `unknown sub-group ${sub}`));
      }
      // Same name, different objects (a QLC+ workspace often has several « Master » sliders): on the
      // Live, in the MIDI page and to the AI they look alike, and one can be taken for a duplicate.
      const sameName = (kind: string, list: { id: string; name: string }[]) => {
        const first = new Map<string, string>();
        for (const x of list) {
          const key = x.name.trim().toLocaleLowerCase("fr");
          const other = first.get(key);
          if (other) warn(`${kind} ${x.id}`, say(`même nom que ${other} (« ${x.name} ») : renommer l'un des deux pour les distinguer`, `same name as ${other} (“${x.name}”): rename one of them to tell them apart`));
          else first.set(key, x.id);
        }
      };
      for (const o of runtime.venue.patchProblems()) warn(say(`projecteur ${o.b}`, `fixture ${o.b}`), say(`${o.message} : deux projecteurs écrivent les mêmes canaux`, `${o.message}: two fixtures write the same channels`));
      for (const b of runtime.venue.patchBeyond()) warn(say(`projecteur ${b.id}`, `fixture ${b.id}`), b.message);
      const notes = runtime.venue.patchNotes();
      for (const g of notes.gaps) note(say(`univers ${g.universe}`, `universe ${g.universe}`), g.message);
      for (const s of notes.sameNames) note(say(`projecteur ${s.ids.join(", ")}`, `fixture ${s.ids.join(", ")}`), s.message);
      for (const p of notes.noPosition) note(say(`projecteur ${p.id}`, `fixture ${p.id}`), p.message);
      // a channel with nothing but Reset and Lamp off ranges: the built-in protection has nowhere to hold it
      for (const f of runtime.venue.installed()) {
        const r = runtime.venue.resolve(f.id);
        if ("error" in r) continue;
        for (const ch of unprotectable(r))
          warn(
            say(`projecteur ${f.id}`, `fixture ${f.id}`),
            say(
              `« ${f.name} » · ${ch} n'a que des plages Reset et « Lamp off » : la protection Reset ne peut pas le tenir au repos ; ne pas le piloter par un look ni un fader`,
              `“${f.name}” · ${ch} has Reset and « Lamp off » ranges only: the Reset protection cannot hold it at rest; do not drive it from a look or a fader`,
            ),
          );
        // a Reset range holding 0 and more: the protection keeps the channel at 0, its power-on value
        for (const p of powerOnResets(r))
          warn(
            say(`projecteur ${f.id}`, `fixture ${f.id}`),
            say(
              `« ${f.name} » · ${p.channel} : la plage ${p.range} commence à 0, où le canal est à l'allumage ; la protection Reset ramène à 0 toute valeur de cette plage : un look ou un fader ne peut pas l'envoyer (vérifier dans le manuel ce que fait cette plage)`,
              `“${f.name}” · ${p.channel}: range ${p.range} starts at 0, where the channel sits from power-on; the Reset protection brings any value of this range back to 0: a look or a fader cannot send it (check in the manual what this range does)`,
            ),
          );
      }
      const grouping = runtime.typeGrouping();
      if (grouping.tags.length || grouping.groups.length) note(say("groupes par type", "type groups"), groupingMessage(grouping));
      // Raw channels the rules bound (UV, strobe, machines): the look does not do what it says, and
      // nobody would know why. Rules that always apply (no program); each written value is tried.
      const zones = runtime.zones.list();
      const zoneById = (id: string) => {
        const f = runtime.venue.fixtures.get(id);
        return f ? zoneOf(f, zones)?.id : undefined;
      };
      const always = runtime.rulesInForce().filter((r) => !r.program);
      const ruleName = new Map(always.map((r) => [r.id, r.name || r.id]));
      // the built-in Reset protection holds at rest, not at the nearest value (rules/reset-protection.ts)
      const ordinary = always.filter((r) => !isBuiltinRule(r.id));
      if (always.length) {
        for (const l of runtime.looks.list()) {
          if (!l.channels) continue;
          const said = new Set<string>();
          l.channels.targets.forEach((t, k) => {
            const r = runtime.venue.resolve(t.fixture);
            if ("error" in r || runtime.venue.absent.has(t.fixture)) return; // absent: nothing is sent, nothing is bounded
            const name = r.mode.channels[t.offset];
            for (const value of new Set(l.channels!.steps.map((row) => row[k] ?? 0))) {
              const buf = new Uint8Array(512);
              const index = r.patch.address - 1 + t.offset;
              if (index < 0 || index >= 512) continue;
              buf[index] = value;
              const moved = [...applyRules(ordinary, r, buf, zoneById), ...(ordinary.length < always.length ? holdAtRest(r, buf, new Map()) : [])].filter((x) => x.channel === name);
              const c = moved.at(-1);
              if (!c || buf[index] === value || said.has(`${t.fixture}/${name}`)) continue;
              said.add(`${t.fixture}/${name}`);
              const rule = c.rule ? `« ${ruleName.get(c.rule) ?? c.rule} »` : say("du lieu", "of the venue");
              const ruleEn = c.rule ? `“${ruleName.get(c.rule) ?? c.rule}”` : "of the venue";
              warn(`look ${l.id}`, say(`écrit ${r.patch.name} · ${name} à ${value}, mais la règle ${rule} le ramène à ${buf[index]} : le look ne rend pas ce qu'il dit`, `writes ${r.patch.name} · ${name} at ${value}, but rule ${ruleEn} brings it to ${buf[index]}: the look does not show what it says`));
            }
          });
        }
      }
      // a « Hz max » only bounds strobes whose definition gives their frequencies: say where it does nothing
      for (const rule of [...runtime.venueRules.list(), ...runtime.rules.list()].filter((r) => r.maxHz !== undefined)) {
        const blind = new Set<string>();
        for (const f of runtime.venue.installed()) {
          const r = runtime.venue.resolve(f.id);
          if ("error" in r) continue;
          for (const name of r.mode.channels) {
            const ch = r.def.channels.get(name);
            if (ch && ruleApplies(rule, r, ch, zoneById) && !ch.capabilities.some((c) => c.hz)) blind.add(f.name);
          }
        }
        if (blind.size) warn(say(`règle ${rule.id}`, `rule ${rule.id}`), say(`Hz max sans effet sur ${[...blind].join(", ")} : leur définition ne donne pas les fréquences du strobe ; les borner par une valeur max`, `Hz max has no effect on ${[...blind].join(", ")}: their definition gives no strobe frequencies; bound them with a max value`));
      }
      // photosensitive safety (WCAG 2.3.1): a look timed in beats flashes fastest on the show's fastest song
      const bpm = Math.max(120, ...songs.list().map((x) => x.bpm ?? 0));
      for (const l of runtime.looks.list()) {
        let steps;
        try {
          steps = runtime.stepsOf(l);
        } catch {
          continue; // an unknown canvas is reported above
        }
        const every = l.timing.every;
        const stepSeconds = "seconds" in every ? every.seconds : (every.beats * 60) / bpm;
        const rate = flashesPerSecond(steps, stepSeconds, l.timing.attack, l.timing.order);
        if (rate > MAX_FLASHES_PER_SECOND) warn(`look ${l.id}`, say(`jusqu'à ${rate.toFixed(1)} éclats par seconde${"beats" in every ? ` à ${bpm} BPM` : ""} : au-delà de ${MAX_FLASHES_PER_SECOND}, un risque pour les personnes photosensibles (WCAG 2.3.1) ; ralentir la cadence ou adoucir l'attaque`, `up to ${rate.toFixed(1)} flashes a second${"beats" in every ? ` at ${bpm} BPM` : ""}: above ${MAX_FLASHES_PER_SECOND}, a risk for photosensitive people (WCAG 2.3.1); slow the rate down or soften the attack`));
      }
      // once per model: the same .qxf fixes them all
      const missing = new Map<string, string[]>();
      for (const m of runtime.venue.missingDefinitions()) missing.set(m.model, [...(missing.get(m.model) ?? []), m.name]);
      for (const [model, names] of missing) warn(say(`projecteur ${names.join(", ")}`, `fixture ${names.join(", ")}`), say(`définition manquante : ${model} — canaux non décodés, ajouter son .qxf (page Import)`, `missing definition: ${model} — channels not decoded, add its .qxf (Import page)`));
      // colour components a definition without <Head> repeats out of any head (names the deduction cannot split): only
      // one zone gets the colour. Info: a mono-colour pixel or an extra channel is often meant so
      const escaping = new Map<string, { names: string[]; channels: Set<string> }>();
      for (const f of runtime.venue.installed()) {
        const r = runtime.venue.resolve(f.id);
        if ("error" in r || !r.escapedColours.length) continue;
        const key = `${f.manufacturer} ${f.model} (${f.mode})`;
        const found = escaping.get(key) ?? { names: [], channels: new Set<string>() };
        found.names.push(f.name);
        for (const o of r.escapedColours) found.channels.add(r.mode.channels[o]!); // every fixture of the model counted, none overwriting another
        escaping.set(key, found);
      }
      for (const [model, { names, channels }] of escaping)
        note(
          say(`projecteur ${names.join(", ")}`, `fixture ${names.join(", ")}`),
          say(
            `${model} : les canaux ${[...channels].join(", ")} répètent une couleur hors de toute tête et ne reçoivent pas la couleur peinte ; pour en faire des zones, déclarer ses têtes (<Head>) dans la définition ou numéroter les canaux de chaque zone (« … 1 », « … 2 »)`,
            `${model}: channels ${[...channels].join(", ")} repeat a colour out of any head and do not get the painted colour; to make them zones, declare its heads (<Head>) in the definition or number each zone's channels (“… 1”, “… 2”)`,
          ),
        );
      // duplicate definitions: only those of a model the venue patches, and only when they change what it gets
      // (identical copies are harmless; an unused duplicate in the library is not this show's business)
      const dups = duplicatesUsedBy(runtime.venue.duplicateDefinitions(), runtime.venue.fixtures.list());
      for (const g of dups.sameName.filter((x) => x.others.some((o) => !o.identical))) warn(say(`définition ${g.manufacturer} ${g.model}`, `definition ${g.manufacturer} ${g.model}`), sameNameMessage(g));
      for (const g of dups.sameSignature.filter(crossManufacturer)) warn(say("définitions", "definitions"), sameSignatureMessage(g));
      sameName("look", runtime.looks.list());
      sameName(say("groupe", "group"), runtime.groups.list());
      sameName("fader", runtime.faders.list());
      // mappings: the same label for different targets (three QLC+ sliders all called « Master »)
      const labels = new Map<string, { id: string; target: string }>();
      for (const m of mappings()) {
        if (!m.label.trim()) continue;
        // the object, not the command: a fader and a button for one thing (a DCA and a look sharing its id) are a pair
        const target = typeof m.on.args.id === "string" ? m.on.args.id : m.on.command;
        const key = m.label.trim().toLocaleLowerCase("fr");
        const other = labels.get(key);
        if (other && other.target !== target) warn(`mapping ${m.id}`, say(`même libellé que ${other.id} (« ${m.label} ») pour une autre cible : renommer l'un des deux pour les distinguer`, `same label as ${other.id} (“${m.label}”) for another target: rename one of them to tell them apart`));
        else if (!other) labels.set(key, { id: m.id, target });
      }
      const checkChannels = (where: string, channels: { fixture: string; offset: number }[]) => {
        for (const c of channels) {
          const problem = runtime.venue.channelProblem(c);
          if (problem) err(where, problem);
        }
      };
      for (const f of runtime.faders.list()) {
        checkChannels(`fader ${f.id}`, f.channels);
        if (f.dca && !runtime.groups.get(f.dca)) err(`fader ${f.id}`, say(`DCA inconnu ${f.dca}`, `unknown DCA ${f.dca}`));
        // a fader on dimmers doses them: left at 0, those fixtures stay dark whatever plays
        const darkened = [...new Set(f.channels.filter((c) => runtime.dosesDimmer(c.fixture, c.offset)).map((c) => runtime.venue.fixtures.get(c.fixture)?.name ?? c.fixture))];
        if (darkened.length && f.level === 0 && (f.range?.min ?? 0) === 0)
          warn(`fader ${f.id}`, say(`à 0, il éteint ${darkened.length} projecteur(s) (${darkened.slice(0, 4).join(", ")}${darkened.length > 4 ? "…" : ""}) tant qu'on ne le monte pas`, `at 0 it darkens ${darkened.length} fixture(s) (${darkened.slice(0, 4).join(", ")}${darkened.length > 4 ? "…" : ""}) until it is raised`));
      }
      for (const l of runtime.looks.list()) if (l.channels) checkChannels(`look ${l.id}`, l.channels.targets);
      // the intentions a song names: known; one of this machine is copied into the show's archives
      const intentionsNow = stack();
      // one of this machine the show names but the schema refuses: the backups go without it
      for (const r of embeddedIntentions(intentionsNow, intentionUsesByKey(showParts()).keys()).refused)
        warn(
          say(`intention ${r.id}`, `intention ${r.id}`),
          say(`« ${r.label} » vient de cette machine et ne sera pas emportée par les sauvegardes du show : ${r.why} ; la corriger`, `“${r.label}” comes from this machine and will not be carried by the show's backups: ${r.why}; fix it`),
        );
      for (const m of intentions.base().privateMerged ?? []) warn(say("fichier privé des intentions", "private intentions file"), say(`${m.words.map((w) => `« ${w} »`).join(", ")} donnent la même clé « ${m.key} » : seule la dernière compte ; renommer les autres`, `${m.words.map((w) => `“${w}”`).join(", ")} make the same key “${m.key}”: only the last one counts; rename the others`));
      for (const e of intentions.loadErrors?.() ?? []) warn("intentions", say(`fichier ignoré, illisible : ${e}`, `file left out, unreadable: ${e}`));
      for (const s of songs.list()) {
        if (!s.mood.length) warn(say(`chant ${s.id}`, `song ${s.id}`), say("pas d'ambiance globale", "no overall mood"));
        for (const word of s.mood) {
          const e = intentionsNow.get(normalizeMood(word));
          if (!e || e.hidden) warn(say(`chant ${s.id}`, `song ${s.id}`), say(`intention inconnue « ${word} »${e?.hidden ? " (masquée dans ce show)" : ""} : la grille ne sait pas quelles couleurs prendre`, `unknown intention “${word}”${e?.hidden ? " (hidden in this show)" : ""}: the grid does not know which colours to take`));
          else if (e.origin === "personal" || e.origin === "private") {
            // worth knowing: it lives on this machine, the show's archives carry a copy of it
            const from = e.origin === "personal" ? say("de la bibliothèque personnelle", "of the personal library") : say("du fichier privé", "of the private file");
            note(say(`chant ${s.id}`, `song ${s.id}`), say(`intention « ${e.label ?? word} » ${from} : les sauvegardes du show en emportent une copie, rendue comme intention du show à la restauration`, `intention “${e.label ?? word}” ${from}: the show's backups carry a copy of it, restored as an intention of the show`));
          }
        }
        s.sections.forEach((sec, i) => {
          if (!sec.look) warn(say(`chant ${s.id}`, `song ${s.id}`), say(`section ${sec.id} sans look`, `section ${sec.id} without a look`));
          else if (!runtime.looks.get(sec.look)) err(say(`chant ${s.id}`, `song ${s.id}`), say(`section ${sec.id} : look inconnu ${sec.look}`, `section ${sec.id}: unknown look ${sec.look}`));
          if (sec.program && !runtime.programs.get(sec.program)) err(say(`chant ${s.id}`, `song ${s.id}`), say(`section ${sec.id} : programme inconnu ${sec.program}`, `section ${sec.id}: unknown program ${sec.program}`));
          const prev = s.sections[i - 1];
          if (prev?.look && prev.look === sec.look && prev.idea !== sec.idea) warn(say(`chant ${s.id}`, `song ${s.id}`), say(`${prev.id} et ${sec.id} ont le même look alors que l'idée change`, `${prev.id} and ${sec.id} have the same look though the idea changes`));
        });
      }
      return { ok: !issues.some((i) => i.level === "erreur"), issues };
    },
  });

  reg.register({
    name: "show.autopresets",
    title: "Presets automatiques",
    description:
      "Wolfmix-like first lighting: base palettes from the colour knowledge (warm white, intimate, calm, joy, celebration, strength) and one look per main technique on a canvas, in an exclusive group; the warm white becomes the safe look if the show has none. Proposal unless apply is true; existing auto-* items are never overwritten. The colours follow the knowledge base as merged for the show: an intention touched up in the show changes them, a masked one falls back to the built-in colours.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ canvas: z.string().optional(), apply: z.boolean().default(false) }),
    run: ({ canvas: canvasId, apply }) => {
      const canvas = canvasId ? runtime.venue.canvases.get(canvasId) : runtime.venue.canvases.list()[0];
      if (!canvas) throw new Error(canvasId ? say(`canevas inconnu : ${canvasId}`, `unknown canvas: ${canvasId}`) : say("aucun canevas : définir d'abord le patch et un canevas (venue.canvas.auto)", "no canvas: set up the patch and a canvas first (venue.canvas.auto)"));
      const kb = knowledge();
      const palettes: Palette[] = [];
      const looks: Look[] = [];
      for (const a of AUTO) {
        const mood = kb.moods[a.mood];
        const technique = a.technique(canvas.cells);
        const base = "colors" in technique ? technique.colors : "color" in technique ? [technique.color] : [];
        const colors = mood?.colors.length ? (mood.colors.length >= base.length ? mood.colors : [...mood.colors, ...base.slice(mood.colors.length)]) : base;
        palettes.push({ id: `auto-${a.id}`, name: a.name, colors, tags: ["auto", `ambiance:${a.mood}`] });
        looks.push({
          id: `auto-${a.id}`,
          name: a.name,
          canvas: canvas.id,
          technique,
          palette: `auto-${a.id}`,
          timing: { every: { beats: 1 }, attack: 0, order: "loop", entryFade: 1, exitFade: 0, ...a.timing },
          manualOnly: false,
          noCut: false,
          danger: false,
          tags: ["auto", `technique:${technique.kind}`, `ambiance:${a.mood}`],
        });
      }
      const group: Group = { id: "auto", name: "Presets automatiques", members: { fixtures: [], looks: looks.map((l) => l.id), groups: [] }, exclusive: true, presets: { included: [], excluded: [] } };
      const created: string[] = [];
      const kept: string[] = [];
      const keep = <T extends { id: string }>(col: Collection<T>, item: T, kind: string) => {
        if (col.get(item.id)) return void kept.push(`${kind} ${item.id}`);
        created.push(`${kind} ${item.id}`);
        if (apply) col.put(item);
      };
      for (const p of palettes) keep(runtime.palettes, p, "palette");
      for (const l of looks) keep(runtime.looks, l, "look");
      keep(runtime.groups, group, "groupe");
      const safeLook = runtime.settings.safeLook ? undefined : "auto-blanc-chaud";
      if (apply && safeLook) runtime.saveSettings({ safeLook });
      return { applied: apply, canvas: canvas.id, created, kept, safeLook, looks: looks.map((l) => ({ id: l.id, name: l.name, technique: l.technique.kind })) };
    },
  });
}
