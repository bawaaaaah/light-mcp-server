/**
 * Import commands: QLC+ workspace → venue + show. Dry run by default (returns the proposal
 * report); `apply: true` writes it. Files are read from <dataRoot>/imports only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CommandRegistry } from "./registry.js";
import type { ShowRuntime } from "../show/runtime.js";
import type { Collection, FolderStore } from "../data/store.js";
import { mappingInputKey, type Mapping, type MidiMapper } from "../midi/mapping.js";
import { parseQxw } from "../presets/qxw-import.js";
import { parseQxf } from "../venue/qxf-import.js";
import { mergeImport } from "../presets/merge-import.js";

/** Fingerprints of what the last import wrote, per collection and id (re-import « mode hybride »). */
const ImportStateSchema = z.record(z.string(), z.record(z.string(), z.string()));
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
  /** Where .qxf fixture definitions are kept (data/fixtures). */
  fixturesDir: string;
}

export function registerImportCommands(reg: CommandRegistry, s: ImportServices): void {
  reg.register({
    name: "fixture.definition.add",
    title: "Ajouter une définition de projecteur",
    description:
      "Adds a QLC+ fixture definition (.qxf, as text) to data/fixtures, the library every import and patch reads; checked before it is written. An existing file of the same name is only replaced with replace: true.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ name: z.string().min(1), xml: z.string().min(1), replace: z.boolean().default(false) }),
    run: ({ name, xml, replace }) => {
      const def = parseQxf(xml); // throws on anything that is not a definition
      const file = `${path.basename(name).replace(/\.qxf$/i, "").replace(/[^\w.-]+/g, "-").slice(0, 100) || "definition"}.qxf`;
      const target = path.join(s.fixturesDir, file);
      if (existsSync(target) && readFileSync(target, "utf8") !== xml && !replace) throw new Error(`${file} existe déjà (replace pour le remplacer)`);
      mkdirSync(s.fixturesDir, { recursive: true });
      writeFileSync(target, xml);
      s.runtime.venue.refreshDefinitions();
      return { file, manufacturer: def.manufacturer, model: def.model, modes: def.modes.map((m) => m.name) };
    },
  });
  reg.register({
    name: "import.qxw",
    title: "Importer un workspace QLC+",
    description:
      "Converts a QLC+ workspace (.qxw) into the venue (patch, canvas) and the show (looks with exact steps tagged with the recognised technique, exclusive groups, masters, MIDI mappings with the same notes). Dry run unless apply is true. Give `file` (name inside data/imports) or `xml`.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({
      file: z.string().optional(),
      xml: z.string().optional(),
      apply: z.boolean().default(false),
      replace: z.boolean().default(false),
      /** Apply even though the workspace is not the one this show was imported from. */
      force: z.boolean().default(false),
    }),
    run: ({ file, xml, apply, replace, force }) => {
      let text = xml;
      if (!text) {
        if (!file) throw new Error("donner file ou xml");
        const resolved = path.resolve(s.importsDir, file);
        if (!resolved.startsWith(path.resolve(s.importsDir) + path.sep)) throw new Error("fichier hors du dossier imports");
        text = readFileSync(resolved, "utf8");
      }
      const ws = parseQxw(text);
      s.runtime.venue.refreshDefinitions();
      const p = qxwToShow(ws, s.runtime.venue.definitions);
      const state = s.show.readManifest("import-state.json", ImportStateSchema, {});
      // An imported mapping never takes a MIDI input that one of the user's own mappings answers:
      // theirs wins, the imported one is left out and reported (before and after applying).
      const importedIds = state.mappings ?? {};
      const taken = new Map(s.mappings.list().filter((m) => !(m.id in importedIds)).map((m) => [mappingInputKey(m), m.id]));
      const ownerOf = (m: { id: string; input: Mapping["input"] }) => {
        const owner = taken.get(mappingInputKey(m));
        return owner && owner !== m.id ? owner : undefined;
      };
      const conflicts = p.mappings.filter((m) => ownerOf(m)).map((m) => `mapping « ${m.label || m.id} » non importé : son entrée MIDI est déjà celle de ${ownerOf(m)}`);
      const freeMappings = p.mappings.filter((m) => !ownerOf(m));
      // Another workspace merged into this show would replace its canvases and looks of the same
      // name (a 101-cell canvas once became a 4-cell one): it belongs in a show of its own.
      const knownFixtures = Object.keys(state.fixtures ?? {});
      const shared = p.fixtures.filter((f) => knownFixtures.includes(f.id)).length;
      const otherWorkspace =
        knownFixtures.length > 0 && shared < Math.min(knownFixtures.length, p.fixtures.length) / 2
          ? `ce workspace n'est pas celui de ce show (${shared} projecteur(s) en commun sur ${p.fixtures.length}) : ses canevas et looks de même nom remplaceraient ceux du show. L'importer dans un autre show, ou forcer (force).`
          : undefined;
      const leftOut = new Set(p.mappings.filter((m) => ownerOf(m)).map((m) => mappingInputKey(m)));
      const summary = {
        qlcVersion: ws.qlcVersion,
        report: p.report,
        otherWorkspace,
        conflicts,
        counts: { fixtures: p.fixtures.length, cells: p.canvas?.cells ?? 0, looks: p.looks.length, groups: p.groups.length, mappings: p.mappings.length },
        looks: p.looks.map((l) => ({ id: l.id, name: l.name, tags: l.tags, timing: l.timing })),
      };
      if (!apply) return { applied: false, ...summary };
      if (otherWorkspace && !force) throw new Error(otherWorkspace);
      const venue = s.runtime.venue;
      // « mode hybride »: untouched objects are updated, hand edits kept, live state always kept
      const merge = <T extends { id: string }>(name: string, raw: T[], col: { get(id: string): T | undefined; put(v: unknown): T; parse(v: unknown): T }) => {
        const incoming = raw.map((x) => col.parse(x)); // same defaults as what is stored, so fingerprints compare
        const m = mergeImport(name, incoming as unknown as ({ id: string } & Record<string, unknown>)[], (id) => col.get(id) as unknown as ({ id: string } & Record<string, unknown>) | undefined, state[name] ?? {}, replace);
        for (const item of m.write) col.put(item);
        state[name] = { ...(state[name] ?? {}), ...m.fingerprints };
        return { added: m.added.length, updated: m.updated.length, unchanged: m.unchanged.length, kept: m.kept, toCheck: m.toCheck };
      };
      const merged = {
        fixtures: merge("fixtures", p.fixtures, venue.fixtures),
        canvases: merge("canvases", [...(p.canvas ? [p.canvas] : []), ...p.matrixCanvases], venue.canvases),
        looks: merge("looks", p.looks, s.runtime.looks),
        groups: merge("groups", p.groups, s.runtime.groups),
        faders: merge("faders", p.faders, s.runtime.faders),
        mappings: merge("mappings", freeMappings, s.mappings),
      };
      s.show.writeManifest("import-state.json", state);
      s.mapper.setMappings(s.mappings.list());
      const registry = new NoteRegistry(s.show.readManifest("notes-registry.json", NoteRegistrySchema, NoteRegistrySchema.parse({})));
      if (!registry.data.bands.some((b) => b.id === "import")) registry.data.bands.push({ id: "import", from: 0, to: 127, channel: 1 });
      const collisions: string[] = [];
      for (const n of p.pinnedNotes.filter((x) => !leftOut.has(mappingInputKey({ input: { type: "note", channel: x.channel, number: x.note } })))) {
        try {
          if (n.channel === 1) registry.pin(n.action, "import", n.note);
        } catch (err) {
          collisions.push((err as Error).message);
        }
      }
      s.show.writeManifest("notes-registry.json", registry.data);
      if (p.tempoFromMidiClock) s.tempo.setSource("midi");
      return { applied: true, ...summary, merged, collisions };
    },
  });

  reg.register({
    name: "look.rebuild",
    title: "Reconstruire en technique",
    description:
      "Rebuilds imported looks (exact steps) into editable parametric techniques (plat, damier, palette, creux, masques) when the recognised technique allows it and the re-rendered result matches the original (fidelity ≥ minFidelity). Dry run unless save is true; the previous version is kept in the backups.",
    right: "show:write",
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
