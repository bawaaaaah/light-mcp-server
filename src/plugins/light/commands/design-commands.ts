/**
 * Design commands for the AI and the UI (docs/specs/mcp.md, « conception d'abord »): look from an
 * intention, song grid fill, show lint, knowledge base. Proposals are returned without writing
 * unless `save` is true.
 */
import { z } from "zod";
import type { CommandRegistry } from "./registry.js";
import type { ShowRuntime } from "../show/runtime.js";
import type { Collection } from "../data/store.js";
import { slugify } from "../data/store.js";
import { mappingInputKey, type Mapping } from "../midi/mapping.js";
import type { Song } from "../songs/songs.js";
import { deltaE, proposeLook, type Energy, type Knowledge } from "../knowledge/knowledge.js";
import type { Group, Look, Palette } from "../show/model.js";
import type { Technique } from "../engine/techniques.js";
import type { Timing } from "../engine/player.js";
import { flashesPerSecond, MAX_FLASHES_PER_SECOND } from "../show/flashes.js";
import { applyRules, ruleApplies } from "../rules/rules.js";
import { zoneOf } from "../venue/stage.js";
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

export function registerDesignCommands(reg: CommandRegistry, runtime: ShowRuntime, songs: Collection<Song>, mappings: () => Mapping[], knowledge: () => Knowledge): void {
  reg.register({
    name: "knowledge.get",
    title: "Base de connaissances couleur",
    description: "Mood keywords → colours, energy and family, plus the design rules (generic base, merged with the user's private one if present).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design"],
    schema: z.object({}),
    run: () => knowledge(),
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
    schema: z.object({ song: z.string(), canvas: z.string(), energies: z.record(z.string(), z.enum(["pose", "dynamique", "survolte"])).default({}), save: z.boolean().default(false) }),
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
    description: "Offline checks: unknown references (canvas, palette, look, group, channel fader, rule program, fixture), channel fader channels outside the fixture's mode, sections without look, MIDI inputs used twice, low contrast in two-colour techniques, identical looks on neighbouring sections, songs without mood, looks, groups or channel faders sharing a name, MIDI mappings with one label for different targets, fixtures whose DMX channels overlap, fixtures without a definition, looks flashing faster than 3 times a second (photosensitive safety, at the show's fastest tempo), raw channels of looks that the rules bound, channel faders at 0 that darken the fixtures whose dimmer they dose.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design", "setup"],
    schema: z.object({}),
    run: () => {
      const issues: { level: "erreur" | "attention"; where: string; message: string }[] = [];
      const err = (where: string, message: string) => issues.push({ level: "erreur", where, message });
      const warn = (where: string, message: string) => issues.push({ level: "attention", where, message });
      for (const l of runtime.looks.list()) {
        if (!runtime.venue.canvases.get(l.canvas)) err(`look ${l.id}`, say(`canevas inconnu ${l.canvas}`, `unknown canvas ${l.canvas}`));
        if (l.palette && !runtime.palettes.get(l.palette)) err(`look ${l.id}`, say(`palette inconnue ${l.palette}`, `unknown palette ${l.palette}`));
        const t = l.technique;
        if ((t.kind === "damier" || t.kind === "creux" || t.kind === "masques") && !l.palette) {
          const d = deltaE(t.colors[0], t.colors[1]);
          if (d < 25 && t.colors[0] !== t.colors[1]) warn(`look ${l.id}`, say(`contraste faible entre ${t.colors[0]} et ${t.colors[1]} (ΔE ${d.toFixed(0)})`, `low contrast between ${t.colors[0]} and ${t.colors[1]} (ΔE ${d.toFixed(0)})`));
        }
      }
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
      // Raw channels the rules bound (UV, strobe, machines): the look does not do what it says, and
      // nobody would know why. Rules that always apply (no program); each written value is tried.
      const zones = runtime.zones.list();
      const zoneById = (id: string) => {
        const f = runtime.venue.fixtures.get(id);
        return f ? zoneOf(f, zones)?.id : undefined;
      };
      const always = runtime.rulesInForce().filter((r) => !r.program);
      if (always.length) {
        for (const l of runtime.looks.list()) {
          if (!l.channels) continue;
          const said = new Set<string>();
          l.channels.targets.forEach((t, k) => {
            const r = runtime.venue.resolve(t.fixture);
            if ("error" in r) return;
            const name = r.mode.channels[t.offset];
            for (const value of new Set(l.channels!.steps.map((row) => row[k] ?? 0))) {
              const buf = new Uint8Array(512);
              const index = r.patch.address - 1 + t.offset;
              if (index < 0 || index >= 512) continue;
              buf[index] = value;
              const c = applyRules(always, r, buf, zoneById).find((x) => x.channel === name);
              if (!c || said.has(`${t.fixture}/${name}`)) continue;
              said.add(`${t.fixture}/${name}`);
              warn(`look ${l.id}`, say(`écrit ${r.patch.name} · ${name} à ${c.from}, mais la règle ${c.rule || "du lieu"} le ramène à ${c.to} : le look ne rend pas ce qu'il dit`, `writes ${r.patch.name} · ${name} at ${c.from}, but rule ${c.rule || "of the venue"} brings it to ${c.to}: the look does not show what it says`));
            }
          });
        }
      }
      // a « Hz max » only bounds strobes whose definition gives their frequencies: say where it does nothing
      for (const rule of [...runtime.venueRules.list(), ...runtime.rules.list()].filter((r) => r.maxHz !== undefined)) {
        const blind = new Set<string>();
        for (const f of runtime.venue.fixtures.list()) {
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
        const rate = flashesPerSecond(steps, stepSeconds, l.timing.attack);
        if (rate > MAX_FLASHES_PER_SECOND) warn(`look ${l.id}`, say(`jusqu'à ${rate.toFixed(1)} éclats par seconde${"beats" in every ? ` à ${bpm} BPM` : ""} : au-delà de ${MAX_FLASHES_PER_SECOND}, un risque pour les personnes photosensibles (WCAG 2.3.1) ; ralentir la cadence ou adoucir l'attaque`, `up to ${rate.toFixed(1)} flashes a second${"beats" in every ? ` at ${bpm} BPM` : ""}: above ${MAX_FLASHES_PER_SECOND}, a risk for photosensitive people (WCAG 2.3.1); slow the rate down or soften the attack`));
      }
      // once per model: the same .qxf fixes them all
      const missing = new Map<string, string[]>();
      for (const m of runtime.venue.missingDefinitions()) missing.set(m.model, [...(missing.get(m.model) ?? []), m.name]);
      for (const [model, names] of missing) warn(say(`projecteur ${names.join(", ")}`, `fixture ${names.join(", ")}`), say(`définition manquante : ${model} — canaux non décodés, ajouter son .qxf (page Import)`, `missing definition: ${model} — channels not decoded, add its .qxf (Import page)`));
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
      for (const s of songs.list()) {
        if (!s.mood.length) warn(say(`chant ${s.id}`, `song ${s.id}`), say("pas d'ambiance globale", "no overall mood"));
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
      "Wolfmix-like first lighting: base palettes from the colour knowledge (warm white, intimate, calm, joy, celebration, strength) and one look per main technique on a canvas, in an exclusive group; the warm white becomes the safe look if the show has none. Proposal unless apply is true; existing auto-* items are never overwritten.",
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
          timing: { every: { beats: 1 }, attack: 0, order: "loop", entryFade: 1, ...a.timing },
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
