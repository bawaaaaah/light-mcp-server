/**
 * Exports: Ableton MIDI Effect Rack named after the show's note mappings (cloned from the user's
 * shell rack), and the notes/CC table (Markdown or CSV). Files are read from and written to the
 * data folders only (shell: data/private or data/imports; output: data/exports).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CommandRegistry } from "./registry.js";
import type { Mapping } from "../midi/mapping.js";
import type { ShowRuntime } from "../show/runtime.js";
import { buildRackXml, readAdg, writeAdg } from "../ableton/midi-effect-rack.js";
import { slugify } from "../data/store.js";
import { readAls, writeAls } from "../ableton/live-set.js";
import { cloneProgramClip, programClipName } from "../ableton/live-clip.js";
import { say } from "../../../core/lang.js";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** Live names note 60 "C3" (note 0 = C-2). */
export const liveNoteName = (n: number) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 2}`;

export function registerExportCommands(reg: CommandRegistry, runtime: ShowRuntime, mappings: () => Mapping[], dataRoot: string): void {
  const inside = (base: string, file: string) => {
    const resolved = path.resolve(base, file);
    if (!resolved.startsWith(path.resolve(base) + path.sep)) throw new Error(say("chemin hors du dossier autorisé", "path outside the allowed folder"));
    return resolved;
  };
  const label = (m: Mapping) => {
    if (m.label) return m.label;
    const id = String(m.on.args.id ?? "");
    return runtime.looks.get(id)?.name ?? runtime.groups.get(id)?.name ?? `${m.on.command} ${id}`.trim();
  };
  const isDanger = (m: Mapping) => m.danger || Boolean(runtime.looks.get(String(m.on.args.id ?? ""))?.danger) || Boolean(runtime.looks.get(String(m.on.args.id ?? ""))?.manualOnly);

  reg.register({
    name: "export.notes",
    title: "Table des notes et CC",
    description: "The show's MIDI table: note (with Live's name), channel, action, mode; then the CCs. Markdown or CSV.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({ format: z.enum(["markdown", "csv"]).default("markdown") }),
    run: ({ format }) => {
      const rows = mappings()
        .slice()
        .sort((a, b) => a.input.type.localeCompare(b.input.type) || a.input.channel - b.input.channel || a.input.number - b.input.number)
        .map((m) => ({
          type: m.input.type,
          canal: m.input.channel,
          numero: m.input.number,
          live: m.input.type === "note" ? liveNoteName(m.input.number) : "",
          action: label(m),
          mode: m.mode,
          danger: isDanger(m) ? "oui" : "",
        }));
      if (format === "csv") return ["type;canal;numero;note_live;action;mode;danger", ...rows.map((r) => [r.type, r.canal, r.numero, r.live, `"${r.action.replace(/"/g, '""')}"`, r.mode, r.danger].join(";"))].join("\n");
      return ["| Type | Canal | N° | Note Live | Action | Mode | ⚠ |", "|---|--:|--:|---|---|---|---|", ...rows.map((r) => `| ${r.type} | ${r.canal} | ${r.numero} | ${r.live} | ${r.action} | ${r.mode} | ${r.danger ? "❌" : ""} |`)].join("\n");
    },
  });

  reg.register({
    name: "export.ableton.rack",
    title: "Rack Ableton",
    description:
      "Builds a MIDI Effect Rack (.adg) with one chain per note mapping, named after its action, on a one-key zone; danger/manual actions in red. Clones the shell rack exported by your Live (file inside data/private). Writes data/exports/<name>.adg.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ shell: z.string().default("shell.adg"), name: z.string().default("light-rack"), channel: z.number().int().min(1).max(16).optional(), color: z.number().int().min(0).max(69).default(12) }),
    run: ({ shell, name, channel, color }) => {
      const shellPath = inside(path.join(dataRoot, "private"), shell);
      if (!existsSync(shellPath)) throw new Error(say(`coquille introuvable : data/private/${shell} (exporter un MIDI Effect Rack à une chaîne depuis Live)`, `shell not found: data/private/${shell} (export a one-chain MIDI Effect Rack from Live)`));
      const notes = mappings().filter((m) => m.input.type === "note" && (channel === undefined || m.input.channel === channel));
      const byNote = new Map<number, Mapping>();
      const skipped: string[] = [];
      for (const m of notes) {
        if (byNote.has(m.input.number)) skipped.push(say(`note ${m.input.number} (${label(m)}) : déjà prise par « ${label(byNote.get(m.input.number)!)} »`, `note ${m.input.number} (${label(m)}): already taken by “${label(byNote.get(m.input.number)!)}”`));
        else byNote.set(m.input.number, m);
      }
      const ccs = mappings().filter((m) => m.input.type === "cc");
      const xml = buildRackXml(readAdg(readFileSync(shellPath)), {
        userName: `${runtime.settings.name} · ch ${channel ?? "tous"}`,
        annotation: [`Généré par light-mcp-server. Un rack = une piste : ne pas empiler.`, ccs.length ? `Faders en CC : ${ccs.map((m) => `${label(m)} = CC ${m.input.number}`).join(", ")}.` : ""].join(" ").trim(),
        chains: [...byNote.entries()].sort((a, b) => a[0] - b[0]).map(([note, m]) => ({ name: `${isDanger(m) ? "❌ " : ""}${label(m)}`, note, color: isDanger(m) ? 0 : color })),
      });
      const outDir = path.join(dataRoot, "exports");
      mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, `${slugify(name)}.adg`);
      writeFileSync(file, writeAdg(xml));
      return { file: path.relative(dataRoot, file), chains: byNote.size, skipped };
    },
  });

  reg.register({
    name: "export.ableton.programs",
    title: "Clips des programmes",
    description:
      "One Ableton clip (.alc) per rule program that has a Program Change: launching it in Live sends that Program Change, which activates the program (« Prière #100 »). Clones the shell clip exported by your Live (data/private), changing only the clip name and Program Change. Writes data/exports/programmes/.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ shell: z.string().default("shell.alc") }),
    run: ({ shell }) => {
      const shellPath = inside(path.join(dataRoot, "private"), shell);
      if (!existsSync(shellPath)) throw new Error(say(`coquille introuvable : data/private/${shell} (glisser un clip MIDI de Live dans le navigateur, puis copier le .alc)`, `shell not found: data/private/${shell} (drag a MIDI clip from Live into the browser, then copy the .alc)`));
      const xml = readAls(readFileSync(shellPath));
      const outDir = path.join(dataRoot, "exports", "programmes");
      mkdirSync(outDir, { recursive: true });
      const written: { program: string; file: string; clip: string }[] = [];
      const skipped: string[] = [];
      for (const p of runtime.programs.list()) {
        if (p.programChange === undefined) {
          skipped.push(`« ${p.name} » : pas de Program Change`);
          continue;
        }
        const clip = programClipName(p.name, p.programChange);
        const file = path.join(outDir, `${slugify(clip)}.alc`);
        writeFileSync(file, writeAls(cloneProgramClip(xml, { name: clip, programChange: p.programChange })));
        written.push({ program: p.id, file: path.relative(dataRoot, file), clip });
      }
      return { written, skipped, note: say("Chaque clip envoie son Program Change sur le canal de la piste qui le joue : régler la sortie MIDI de la piste sur le canal du programme.", "Each clip sends its Program Change on the channel of the track playing it: set the track's MIDI output to the program's channel.") };
    },
  });
}
