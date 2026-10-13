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
import type { Look } from "../show/model.js";

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
    readOnly: true,
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
    readOnly: true,
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
    description: "Offline checks: unknown references (canvas, palette, look), sections without look, MIDI inputs used twice, low contrast in two-colour techniques, identical looks on neighbouring sections, songs without mood.",
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
        if (m.on.command.startsWith("look.") && m.on.args.id && !runtime.looks.get(String(m.on.args.id))) err(`mapping ${m.id}`, `look inconnu ${String(m.on.args.id)}`);
      }
      for (const s of songs.list()) {
        if (!s.mood.length) warn(`chant ${s.id}`, "pas d'ambiance globale");
        s.sections.forEach((sec, i) => {
          if (!sec.look) warn(`chant ${s.id}`, `section ${sec.id} sans look`);
          else if (!runtime.looks.get(sec.look)) err(`chant ${s.id}`, `section ${sec.id} : look inconnu ${sec.look}`);
          const prev = s.sections[i - 1];
          if (prev?.look && prev.look === sec.look && prev.idea !== sec.idea) warn(`chant ${s.id}`, `${prev.id} et ${sec.id} ont le même look alors que l'idée change`);
        });
      }
      return { ok: !issues.some((i) => i.level === "erreur"), issues };
    },
  });
}
