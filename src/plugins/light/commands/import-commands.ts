/**
 * Import commands: QLC+ workspace → venue + show. Dry run by default (returns the proposal
 * report); `apply: true` writes it. Files are read from <dataRoot>/imports only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CommandRegistry } from "./registry.js";
import type { ShowRuntime } from "../show/runtime.js";
import type { Collection, FolderStore } from "../data/store.js";
import type { Mapping, MidiMapper } from "../midi/mapping.js";
import { parseQxw } from "../presets/qxw-import.js";
import { qxwToShow } from "../presets/qxw-to-show.js";
import { NoteRegistry, NoteRegistrySchema } from "../midi/note-registry.js";
import type { TempoClock } from "../timing/tempo.js";
import { rebuild } from "../presets/rebuild.js";

export interface ImportServices {
  runtime: ShowRuntime;
  show: FolderStore;
  mappings: Collection<Mapping>;
  mapper: MidiMapper;
  tempo: TempoClock;
  importsDir: string;
}

export function registerImportCommands(reg: CommandRegistry, s: ImportServices): void {
  reg.register({
    name: "import.qxw",
    title: "Importer un workspace QLC+",
    description:
      "Converts a QLC+ workspace (.qxw) into the venue (patch, canvas) and the show (looks with exact steps tagged with the recognised technique, exclusive groups, masters, MIDI mappings with the same notes). Dry run unless apply is true. Give `file` (name inside data/imports) or `xml`.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ file: z.string().optional(), xml: z.string().optional(), apply: z.boolean().default(false) }),
    run: ({ file, xml, apply }) => {
      let text = xml;
      if (!text) {
        if (!file) throw new Error("donner file ou xml");
        const resolved = path.resolve(s.importsDir, file);
        if (!resolved.startsWith(path.resolve(s.importsDir) + path.sep)) throw new Error("fichier hors du dossier imports");
        text = readFileSync(resolved, "utf8");
      }
      const ws = parseQxw(text);
      const p = qxwToShow(ws, s.runtime.venue.definitions);
      const summary = {
        qlcVersion: ws.qlcVersion,
        report: p.report,
        counts: { fixtures: p.fixtures.length, cells: p.canvas?.cells ?? 0, looks: p.looks.length, groups: p.groups.length, mappings: p.mappings.length },
        looks: p.looks.map((l) => ({ id: l.id, name: l.name, tags: l.tags, timing: l.timing })),
      };
      if (!apply) return { applied: false, ...summary };
      const venue = s.runtime.venue;
      for (const f of p.fixtures) venue.fixtures.put(f);
      if (p.canvas) venue.canvases.put(p.canvas);
      for (const l of p.looks) s.runtime.looks.put(l);
      for (const g of p.groups) s.runtime.groups.put(g);
      for (const m of p.mappings) s.mappings.put(m);
      s.mapper.setMappings(s.mappings.list());
      const registry = new NoteRegistry(s.show.readManifest("notes-registry.json", NoteRegistrySchema, NoteRegistrySchema.parse({})));
      if (!registry.data.bands.some((b) => b.id === "import")) registry.data.bands.push({ id: "import", from: 0, to: 127, channel: 1 });
      const collisions: string[] = [];
      for (const n of p.pinnedNotes) {
        try {
          if (n.channel === 1) registry.pin(n.action, "import", n.note);
        } catch (err) {
          collisions.push((err as Error).message);
        }
      }
      s.show.writeManifest("notes-registry.json", registry.data);
      if (p.tempoFromMidiClock) s.tempo.setSource("midi");
      return { applied: true, ...summary, collisions };
    },
  });

  reg.register({
    name: "look.rebuild",
    title: "Reconstruire en technique",
    description:
      "Rebuilds imported looks (exact steps) into editable parametric techniques (plat, damier, palette, creux, masques) when the recognised technique allows it and the re-rendered result matches the original (fidelity ≥ minFidelity). Dry run unless save is true; the previous version is kept in the backups.",
    right: "show:write",
    readOnly: true,
    profiles: ["design"],
    schema: z.object({ id: z.string().optional(), minFidelity: z.number().min(0).max(1).default(0.9), save: z.boolean().default(false) }),
    run: ({ id, minFidelity, save }) => {
      const looks = s.runtime.looks.list().filter((l) => l.technique.kind === "pas" && (!id || l.id === id));
      const results = looks.map((l) => {
        const recognised = (l.tags.find((t) => t.startsWith("technique:")) ?? "").slice("technique:".length);
        const steps = (l.technique as { steps: string[][] }).steps;
        const a = rebuild(steps, recognised, false);
        const b = rebuild(steps, recognised, true);
        const best = b.fidelity > a.fidelity ? { ...b, mirror: true } : { ...a, mirror: false };
        const accepted = Boolean(best.technique) && best.fidelity >= minFidelity;
        if (accepted && save) s.runtime.looks.put({ ...l, technique: best.technique!, mirror: best.mirror, tags: [...l.tags.filter((t) => t !== "reconstruit"), "reconstruit"] });
        return { id: l.id, name: l.name, recognised, fidelity: Math.round(best.fidelity * 100) / 100, mirror: best.mirror, accepted, reason: best.reason, technique: best.technique?.kind };
      });
      return { saved: save, rebuilt: results.filter((r) => r.accepted).length, total: results.length, results };
    },
  });
}
