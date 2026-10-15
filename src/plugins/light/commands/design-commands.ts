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
import type { Mapping } from "../midi/mapping.js";
import type { Song } from "../songs/songs.js";
import { deltaE, proposeLook, type Energy, type Knowledge } from "../knowledge/knowledge.js";
import type { Group, Look, Palette } from "../show/model.js";
import type { Technique } from "../engine/techniques.js";
import type { Timing } from "../engine/player.js";

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
      if (!runtime.venue.canvases.get(canvas)) throw new Error(`canevas inconnu : ${canvas}`);
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
      if (!song) throw new Error(`chant inconnu : ${songId}`);
      if (!song.mood.length) throw new Error("le chant n'a pas d'ambiance globale (mood) : c'est le garde-fou de la grille");
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
    description: "Offline checks: unknown references (canvas, palette, look, group, channel fader, rule program, fixture), channel fader channels outside the fixture's mode, sections without look, MIDI inputs used twice, low contrast in two-colour techniques, identical looks on neighbouring sections, songs without mood.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design", "setup"],
    schema: z.object({}),
    run: () => {
      const issues: { level: "erreur" | "attention"; where: string; message: string }[] = [];
      const err = (where: string, message: string) => issues.push({ level: "erreur", where, message });
      const warn = (where: string, message: string) => issues.push({ level: "attention", where, message });
      for (const l of runtime.looks.list()) {
        if (!runtime.venue.canvases.get(l.canvas)) err(`look ${l.id}`, `canevas inconnu ${l.canvas}`);
        if (l.palette && !runtime.palettes.get(l.palette)) err(`look ${l.id}`, `palette inconnue ${l.palette}`);
        const t = l.technique;
        if ((t.kind === "damier" || t.kind === "creux" || t.kind === "masques") && !l.palette) {
          const d = deltaE(t.colors[0], t.colors[1]);
          if (d < 25 && t.colors[0] !== t.colors[1]) warn(`look ${l.id}`, `contraste faible entre ${t.colors[0]} et ${t.colors[1]} (ΔE ${d.toFixed(0)})`);
        }
      }
      const seen = new Map<string, string>();
      for (const m of mappings()) {
        const key = `${m.input.type}:${m.input.channel}:${m.input.number}:${m.input.port ?? ""}`;
        if (seen.has(key)) err(`mapping ${m.id}`, `même entrée que ${seen.get(key)}`);
        seen.set(key, m.id);
        const target = m.on.args.id;
        if (typeof target === "string" && target) {
          if (m.on.command.startsWith("look.") && !runtime.looks.get(target)) err(`mapping ${m.id}`, `look inconnu ${target}`);
          if (m.on.command.startsWith("group.") && !runtime.groups.get(target)) err(`mapping ${m.id}`, `groupe inconnu ${target}`);
          if (m.on.command.startsWith("fader.") && !runtime.faders.get(target)) err(`mapping ${m.id}`, `fader de canaux inconnu ${target}`);
          if (m.on.command === "program.select" && !runtime.programs.get(target)) err(`mapping ${m.id}`, `programme inconnu ${target}`);
        }
      }
      for (const g of runtime.groups.list()) {
        for (const f of g.members.fixtures) if (!runtime.venue.fixtures.get(f)) err(`groupe ${g.id}`, `projecteur inconnu ${f}`);
        for (const l of [...g.members.looks, ...g.presets.included, ...g.presets.excluded]) if (!runtime.looks.get(l)) err(`groupe ${g.id}`, `look inconnu ${l}`);
        for (const sub of g.members.groups) if (!runtime.groups.get(sub)) err(`groupe ${g.id}`, `sous-groupe inconnu ${sub}`);
      }
      const checkChannels = (where: string, channels: { fixture: string; offset: number }[]) => {
        for (const c of channels) {
          const problem = runtime.venue.channelProblem(c);
          if (problem) err(where, problem);
        }
      };
      for (const f of runtime.faders.list()) {
        checkChannels(`fader ${f.id}`, f.channels);
        if (f.dca && !runtime.groups.get(f.dca)) err(`fader ${f.id}`, `DCA inconnu ${f.dca}`);
      }
      for (const l of runtime.looks.list()) if (l.channels) checkChannels(`look ${l.id}`, l.channels.targets);
      for (const s of songs.list()) {
        if (!s.mood.length) warn(`chant ${s.id}`, "pas d'ambiance globale");
        s.sections.forEach((sec, i) => {
          if (!sec.look) warn(`chant ${s.id}`, `section ${sec.id} sans look`);
          else if (!runtime.looks.get(sec.look)) err(`chant ${s.id}`, `section ${sec.id} : look inconnu ${sec.look}`);
          if (sec.program && !runtime.programs.get(sec.program)) err(`chant ${s.id}`, `section ${sec.id} : programme inconnu ${sec.program}`);
          const prev = s.sections[i - 1];
          if (prev?.look && prev.look === sec.look && prev.idea !== sec.idea) warn(`chant ${s.id}`, `${prev.id} et ${sec.id} ont le même look alors que l'idée change`);
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
      if (!canvas) throw new Error(canvasId ? `canevas inconnu : ${canvasId}` : "aucun canevas : définir d'abord le patch et un canevas (venue.canvas.auto)");
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
