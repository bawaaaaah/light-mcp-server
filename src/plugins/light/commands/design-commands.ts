/**
 * Design commands for the AI and the UI (docs/specs/mcp.md, « conception d'abord »): look from an
 * intention, song grid fill, show lint (show-lint.ts), knowledge base. Proposals are returned without writing
 * unless `save` is true.
 */
import { z } from "zod";
import { CommandError, type CommandRegistry } from "./registry.js";
import type { ShowRuntime } from "../show/runtime.js";
import type { Collection } from "../data/store.js";
import { slugify } from "../data/store.js";
import type { Mapping } from "../midi/mapping.js";
import type { Song } from "../songs/songs.js";
import { deltaE, EnergySchema, LOW_CONTRAST, normalizeMood, proposeLook, type Energy, type Knowledge, type KnowledgeLayers } from "../knowledge/knowledge.js";
import {
  AMBIANCE,
  IntentionSchema,
  MAX_ALIASES,
  MAX_FAMILY,
  MAX_INTENTION_COLORS,
  MAX_LABEL,
  MAX_NOTES,
  mergeKnowledge,
  migrateMood,
  newIntentionId,
  INTENTION_REFS_HELP,
  originWord,
  refFor,
  refKey,
  resolveIntention,
  stackIntentions,
  type Intention,
  type IntentionEntry,
} from "../knowledge/intentions.js";
import { inUseMessage, intentionUses, intentionUsesByKey } from "../show/references.js";
import type { ShowRef } from "../show/other-shows.js";
import type { Group, Look, Palette } from "../show/model.js";
import type { Technique } from "../engine/techniques.js";
import type { Timing } from "../engine/player.js";
import { say } from "../../../core/lang.js";
import { registerShowLint } from "./show-lint.js";

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
  /** The id of a new intention (T15b): `newIntentionId` at the time of the call by default (injectable). */
  newId?: () => string;
  /** Why the private file could not be read (its layer left out, T15b): nothing migrates meanwhile. */
  privateUnreadable?: () => string | undefined;
}

/** A new intention's id (T15b), never one already taken in a layer (intention.put, show.propose). */
export function freshIntentionId(stores: IntentionStores): string {
  const st = showStack(stores);
  const taken = (id: string) => st.has(id) || stores.personal.has(id) || stores.show.has(id);
  for (let tries = 0; tries < 100; tries++) {
    const id = stores.newId?.() ?? newIntentionId(Date.now());
    if (!taken(id)) return id;
  }
  throw new CommandError("failed", say("pas d'id libre pour une nouvelle intention", "no free id for a new intention"));
}

/** The intentions the open show sees, every layer stacked (T15). */
export const showStack = (stores: IntentionStores): Map<string, IntentionEntry> => stackIntentions(stores.base(), stores.personal.list(), stores.show.list());

/** What `intention.put` and `intention.preview` take. */
const IntentionInputSchema = z.object({
  id: z.string().optional(),
  label: z.string().max(MAX_LABEL),
  colors: z.array(z.string()).min(1).max(MAX_INTENTION_COLORS),
  energy: EnergySchema.default("dynamique"),
  family: z.string().max(MAX_FAMILY).default(""),
  notes: z.string().max(MAX_NOTES).optional(),
  /** Former labels (T15b); absent, a rename adds the label it leaves to the ones it had. */
  aliases: z.array(z.string().max(MAX_LABEL)).max(MAX_ALIASES).optional(),
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

/** Where an intention lives, as people say it (show.lint). */

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
  const stack = showStack(stores);
  const keyOf = refKey(stack);
  // an id given as such is that one (a row of the list); a word, the one it names
  const key = stack.has(word) ? word : keyOf(word);
  return [...intentionUses(key, show, keyOf), ...othersOf(stores, key, stack.get(key)).map(otherShowLine)];
}

/**
 * The former labels an intention keeps when it is renamed (T15b): the ones given (history, proposals
 * and archives write them back as they were), else the ones it had plus the label it leaves. Without
 * those that are now its label or its id (a word of that key finds it anyway), once each, the latest kept.
 */
export function aliasesAfter(id: string, label: string, before: { label?: string; aliases?: string[] } | undefined, given?: string[]): string[] | undefined {
  const list = given ?? [...(before?.aliases ?? []), ...(before?.label ? [before.label] : [])];
  const seen = new Set([normalizeMood(label), normalizeMood(id), ""]);
  const kept: string[] = [];
  for (const a of [...list].reverse()) {
    const k = normalizeMood(a);
    if (seen.has(k)) continue;
    seen.add(k);
    kept.unshift(a.trim());
  }
  const out = kept.slice(-MAX_ALIASES);
  return out.length ? out : undefined;
}

/** `colourKnown` (T41): whether a colour preset id is one the open show sees, for show.lint. */
export function registerDesignCommands(reg: CommandRegistry, runtime: ShowRuntime, songs: Collection<Song>, mappings: () => Mapping[], intentions: IntentionStores, colourKnown?: (id: string) => boolean): void {
  const stack = () => showStack(intentions);
  const machineStack = () => stackIntentions(intentions.base(), intentions.personal.list(), []);
  const knowledge = (): Knowledge => mergeKnowledge(intentions.base(), intentions.personal.list(), intentions.show.list());
  const showParts = () => ({ songs: songs.list(), looks: runtime.looks.list() });
  const usesOfIntention = (key: string) => intentionUses(key, showParts(), refKey(stack()));
  /** An id given (`intention.put` with id): must already be one (its own key). */
  const givenId = (word: string): string => {
    const key = normalizeMood(word);
    if (!key) throw new CommandError("invalid", say("id vide : une intention a besoin d'au moins une lettre ou un chiffre", "empty id: an intention needs at least a letter or a number"));
    if (key !== word) throw new CommandError("invalid", say(`id invalide : « ${word} » (attendu « ${key} »)`, `invalid id: “${word}” (expected “${key}”)`), { expected: key });
    if (key.length > 64) throw new CommandError("invalid", say("id trop long : plus de 64 caractères", "id too long: over 64 characters"));
    return key;
  };
  /** A new intention's id (T15b), never one already taken in a layer. */
  const freshId = (): string => freshIntentionId(intentions);
  /** The other visible intentions of that label (T15b): allowed, said so. */
  const sameLabel = (id: string, label: string) => {
    const key = normalizeMood(label);
    return [...stack().values()].filter((e) => !e.hidden && e.id !== id && key !== "" && normalizeMood(e.label || e.id) === key).map((e) => ({ id: e.id, label: e.label || e.id, origin: e.origin }));
  };

  reg.register({
    name: "knowledge.get",
    title: "Base de connaissances couleur",
    titleEn: "Colour knowledge base",
    description:
      "Mood intentions → colours, energy and family, plus the design rules, by id (moods: id → mood). Layers, the most specific winning id by id: shipped (generic) < the user's private file < personal library (this machine, every show) < the open show. Each mood says its label (what to show: a new intention's id is generated, i-…), its former labels (aliases), its origin (generic, private, personal, show), what a show or personal one replaces (over) and what uses it in the open show (usedBy: songs by their mood, looks by their ambiance: tag, whether they name it by id or by name); `hidden` lists the intentions the show masks. A word names an intention by its id, else by its label or a former one (several may share a label: show > personal > private file > shipped). machine: true leaves the open show out (what this machine has, for the library section). " + INTENTION_REFS_HELP,
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design"],
    schema: z.object({ machine: z.boolean().default(false) }),
    run: ({ machine }) => {
      const layers = machine ? machineStack() : stack();
      const uses = machine ? new Map<string, string[]>() : intentionUsesByKey(showParts(), refKey(layers));
      const all = [...layers.values()].map((e) => ({ ...e, usedBy: uses.get(e.id) ?? [] }));
      return { ...knowledge(), moods: Object.fromEntries(all.filter((e) => !e.hidden).map(({ id, hidden: _h, ...e }) => [id, e])), hidden: all.filter((e) => e.hidden) };
    },
  });

  reg.register({
    name: "intention.put",
    title: "Intention",
    titleEn: "Intention",
    hints: "DI",
    changes: ["intentions"],
    description: `Creates or changes an intention (a mood of the colour knowledge base): label (${MAX_LABEL} characters at most), 1 to ${MAX_INTENTION_COLORS} colours (#rrggbb, the first one leads), energy (pose, dynamique, survolte), family, notes. scope "show" (default) stores it in the open show: it travels in the show's .lightshow archives and backups. scope "personal" stores it in the personal library of this machine: every show sees it, and a show's archive carries a copy of the ones it uses. Without id: a creation, with a generated id (i-…, returned): several intentions may share a label (the other ones are returned in duplicates; a word naming that label goes to the most specific: show > personal > private file > shipped). With id: that id is written: an edit, a touch-up of a shipped or private one for the show (or for every show from the personal library), a copy into the show or into the library; the id never follows the label, which is free to change (songs and ambiance: tags name the id). A renamed one keeps its former labels in aliases (given aliases replace them), so that a word typed before still finds it. hidden: true (show only, an id known below) writes a mask as intention.delete does, but without its guard (history.restore and show.revert put a mask back this way): songs and looks still naming it are returned in usedBy, they now name an unknown intention. Intentions of the private file (data/private/knowledge.json) have their keyword's key as id: renaming a keyword there breaks what names it.`,
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ intention: IntentionInputSchema, scope: z.enum(["show", "personal"]).default("show") }),
    run: ({ intention: input, scope }) => {
      const target = scope === "personal" ? intentions.personal : intentions.show;
      const label = input.label.trim();
      if (input.id === undefined && !normalizeMood(label)) throw new CommandError("invalid", say("libellé vide : une intention a besoin d'au moins une lettre ou un chiffre", "empty label: an intention needs at least a letter or a number"));
      const id = input.id !== undefined ? givenId(input.id) : freshId();
      if (input.hidden) {
        // only a mask of something below, in the show: what intention.delete wrote, coming back
        const below = machineStack().get(id);
        if (scope !== "show" || !below) throw new CommandError("invalid", say(`un masque ne se pose que dans le show, sur une intention connue plus bas : ${id}`, `a mask goes in the show only, over an intention known below: ${id}`));
      }
      // what it was before (its own place, else what it touches up or copies): a renamed one keeps its former label
      const before = target.get(id) ?? stack().get(id);
      const name = label || before?.label || id;
      const aliases = aliasesAfter(id, name, before, input.aliases);
      const saved = parsedOr(() => target.put({ ...input, id, label: name, aliases, ...(input.hidden ? { hidden: true } : { hidden: undefined }) }));
      const entry = stack().get(id);
      const duplicates = input.hidden ? [] : sameLabel(id, name);
      // a mask is not refused while used (a version or a proposal taken back puts it back as it was): said instead
      return {
        intention: saved,
        scope,
        ...(input.hidden ? { usedBy: usesOfIntention(id) } : {}),
        origin: entry?.origin,
        ...(entry?.over ? { over: entry.over } : {}),
        ...(scope === "personal" && entry?.origin === "show" ? { shadowedBy: "show" } : {}),
        ...(duplicates.length ? { duplicates } : {}),
      };
    },
  });

  reg.register({
    name: "intention.delete",
    title: "Supprimer une intention",
    titleEn: "Delete an intention",
    hints: "DI",
    changes: ["intentions"],
    description:
      "Removes an intention, by id (or by a name: the one that name goes to, as songs read it). scope, as for intention.put: \"personal\" takes the personal library's, whatever the open show has of that key; \"show\" the show's own only; none, the one in use. One of the show: its file goes (a touch-up gives the one below back: reverted; a mask shows the masked one again: restored). One of the personal library (the show having none of that key): removed for every show of this machine. Shipped, or from the private file: masked for this show (hidden; deleting the mask brings it back). Refused while songs (mood) or looks (ambiance: tag) of the open show use it and it would become unknown, unless force: the error names them (detail.uses). A personal one with nothing below is also refused, unless force, while other shows of this machine name it: the same error names them (detail.otherShows), as show.references does. Returns what was done: deleted, reverted, hidden or restored.",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ id: z.string(), force: z.boolean().default(false), scope: z.enum(["show", "personal"]).optional() }),
    run: ({ id: word, force, scope }) => {
      // scope "personal": the library's own, whatever the open show has of that id (the library section)
      const layers = scope === "personal" ? machineStack() : stack();
      // an id given as such is that one (a row of the list); a word, the one it names
      const exact = layers.get(word);
      const found = exact ? { entry: exact, by: "id" as const, candidates: [exact] } : resolveIntention(layers, word);
      // a name several intentions answer to: which one is not guessed (T15b)
      if (found && found.by !== "id" && found.candidates.length > 1)
        throw new CommandError("invalid", say(`« ${word} » nomme ${found.candidates.length} intentions (${found.candidates.map((c) => `${c.label || c.id} : ${originWord(c.origin)}, ${c.id}`).join(" ; ")}) : la désigner par son id`, `“${word}” names ${found.candidates.length} intentions (${found.candidates.map((c) => `${c.label || c.id}: ${originWord(c.origin)}, ${c.id}`).join("; ")}): name it by its id`), { candidates: found.candidates.map((c) => ({ id: c.id, label: c.label || c.id, origin: c.origin })) });
      const entry = found?.entry;
      if (!entry || (scope !== undefined && entry.origin !== scope)) throw new CommandError("unknown", say(`intention inconnue : ${word}`, `unknown intention: ${word}`));
      const key = entry.id;
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
      intentions.show.put({ id: key, label: entry.label ?? key, colors: entry.colors, energy: entry.energy, family: entry.family, ...(entry.aliases?.length ? { aliases: entry.aliases } : {}), hidden: true });
      return { id: key, action: "hidden" as const, origin: entry.origin, usedBy };
    },
  });

  reg.register({
    name: "intention.library",
    title: "Bibliothèque d'intentions",
    titleEn: "Intention library",
    description: "The intentions of the personal library of this machine (every show sees them), whatever show is open: each with what it replaces below (over: generic or private) and the shows of this machine naming it without an intention of their own of that key (shows).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design"],
    schema: z.object({}),
    run: () => {
      const machine = machineStack();
      const users = intentions.machineUsers?.() ?? new Map<string, ShowRef[]>();
      return [...machine.values()].filter((e) => e.origin === "personal").map((e) => ({ ...e, shows: (users.get(e.id) ?? []).map((s) => s.name) }));
    },
  });

  reg.register({
    name: "intention.preview",
    title: "Aperçu d'une intention",
    titleEn: "Intention preview",
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
    titleEn: "Look from an intent",
    hints: "I",
    changes: ["looks"],
    description:
      "Proposes a look from an intention: intentions by id or by name (e.g. intimite, joie, or a label as knowledge.get gives it), optional energy (pose, dynamique, survolte), extra colours, cut (true = claque, false = respire). Returns the look and an explanation; saved only if save is true. Its ambiance: tags name each intention by id when one intention only answers to the name (an unknown word stays as typed); a name several answer to stays a name (show.lint says it). " + INTENTION_REFS_HELP,
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ name: z.string(), canvas: z.string(), mood: z.array(z.string()).min(1), energy: z.enum(["pose", "dynamique", "survolte"]).optional(), colors: z.array(z.string()).optional(), cut: z.boolean().optional(), id: z.string().optional(), save: z.boolean().default(false) }),
    run: ({ name, canvas, mood, energy, colors, cut, id, save }) => {
      if (!runtime.venue.canvases.get(canvas)) throw new Error(say(`canevas inconnu : ${canvas}`, `unknown canvas: ${canvas}`));
      const st = stack();
      const p = proposeLook(knowledge(), { mood, energy, colors, cut }, refKey(st));
      const look = { id: id ?? slugify(name), name, canvas, technique: p.technique, timing: p.timing, manualOnly: false, noCut: false, danger: false, tags: migrateMood(st, mood).mood.map((m) => `${AMBIANCE}${m}`), notes: p.explanation.join(" ; ") } as Look;
      if (save) runtime.looks.put(look);
      return { saved: save, look, explanation: p.explanation, unknownMoods: p.unknownMoods };
    },
  });

  reg.register({
    name: "song.grid_fill",
    title: "Remplir la grille d'un chant",
    titleEn: "Fill a song's grid",
    hints: "I",
    changes: ["songs", "groups", "looks"],
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
      const st = stack();
      const tags = migrateMood(st, song.mood).mood.map((m) => `${AMBIANCE}${m}`);
      for (const sec of song.sections) {
        if (sec.look) continue;
        const energy = energies[sec.id] ?? energyOfSection(sec.name);
        const p = proposeLook(knowledge(), { mood: song.mood, energy }, refKey(st));
        const colors = flip ? [...p.colors].reverse() : p.colors; // neighbours swap dominant and accent
        flip = !flip;
        const again = proposeLook(knowledge(), { mood: [], energy, colors });
        const look = { id: `${song.id}-${sec.id}`, name: `${song.title} · ${sec.name}`, canvas, technique: again.technique, timing: again.timing, manualOnly: false, noCut: false, danger: false, tags: [`chant:${song.id}`, ...tags], notes: [...p.explanation, sec.idea ? `idée : ${sec.idea}` : ""].filter(Boolean).join(" ; ") } as Look;
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

  registerShowLint(reg, { runtime, songs, mappings, intentions, stack, colourKnown });

  reg.register({
    name: "show.autopresets",
    title: "Presets automatiques",
    titleEn: "Automatic presets",
    hints: "I",
    changes: ["looks", "groups", "settings"],
    description:
      "Wolfmix-like first lighting: base palettes from the colour knowledge (warm white, intimate, calm, joy, celebration, strength) and one look per main technique on a canvas, in an exclusive group; the warm white becomes the safe look if the show has none. Proposal unless apply is true; existing auto-* items are never overwritten. The colours follow the knowledge base as merged for the show: an intention touched up in the show changes them, a masked one falls back to the built-in colours.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ canvas: z.string().optional(), apply: z.boolean().default(false) }),
    run: ({ canvas: canvasId, apply }) => {
      const canvas = canvasId ? runtime.venue.canvases.get(canvasId) : runtime.venue.canvases.list()[0];
      if (!canvas) throw new Error(canvasId ? say(`canevas inconnu : ${canvasId}`, `unknown canvas: ${canvasId}`) : say("aucun canevas : définir d'abord le patch et un canevas (venue.canvas.auto)", "no canvas: set up the patch and a canvas first (venue.canvas.auto)"));
      const kb = knowledge();
      const autoStack = stack();
      const palettes: Palette[] = [];
      const looks: Look[] = [];
      for (const a of AUTO) {
        const mood = kb.moods[a.mood];
        // the tag names the intention whose colours were taken, even when a nearer one bears its label (T15b)
        const named = refFor(autoStack, a.mood);
        const technique = a.technique(canvas.cells);
        const base = "colors" in technique ? technique.colors : "color" in technique ? [technique.color] : [];
        const colors = mood?.colors.length ? (mood.colors.length >= base.length ? mood.colors : [...mood.colors, ...base.slice(mood.colors.length)]) : base;
        palettes.push({ id: `auto-${a.id}`, name: a.name, colors, tags: ["auto", `ambiance:${named}`] });
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
          tags: ["auto", `technique:${technique.kind}`, `ambiance:${named}`],
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
