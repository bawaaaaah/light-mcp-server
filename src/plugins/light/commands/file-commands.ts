/**
 * Show files, as in a classic lighting console (docs/specs/data-cli-sdk.md, « Shows et sauvegardes »):
 * list, create (empty or as a copy), open, rename, delete (to the backups), reset, and `.lightshow`
 * backups kept on the server. A show is a folder under <dataRoot>/shows and plays on the venue its
 * show.json names; everything is saved as it changes, so « Enregistrer sous » is a copy.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { packArchive, readArchive, type ArchiveManifest, type RestorePreview, type RestoreResult } from "../data/archive.js";
import { definitionDirsFor, FixturePolicySchema, type FixturePolicy } from "../data/archive-fixtures.js";
import { ID_RE, slugify, stableStringify } from "../data/store.js";
import { ShowSettingsSchema } from "../show/model.js";
import { PatchedFixtureSchema, type PatchedFixture } from "../venue/venue.js";
import { pairFixtures, placementChange } from "../venue/positions-import.js";
import { autoBackupDue, autoBackupsOf, autoBackupsToPrune, autoBackupTime, historyToPrune } from "../data/retention.js";
import type { CommandRegistry } from "./registry.js";
import { say } from "../../../core/lang.js";

export interface FileServices {
  dataRoot: string;
  current(): { show: string; venue: string };
  /** Switches the running show (and its venue). */
  open(id: string): Promise<void>;
  /** Writes pending live values, so a copy or an archive has them. */
  flush(): void;
  /** Re-reads the current show and venue from disk (after a reset or a restore). */
  reload(): void;
  /** Replaces the current show (and venue) with an archive's content, after a backup copy, and merges its fixture definitions as `fixtures` says. */
  restore(bytes: Uint8Array, fixtures: FixturePolicy): RestoreResult;
  /** What restore would change; nothing is written. */
  preview(bytes: Uint8Array, fixtures: FixturePolicy): RestorePreview;
  /** Imports a QLC+ workspace (.qxw text) into the open show. */
  importQxw(xml: string): Promise<unknown>;
}

/** Local date and time for file names, as the user reads them: 2026-10-15_23-01-52. */
const stamp = (d = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
const BACKUP_RE = /^[\w.-]+\.lightshow$/;

/** Packs the current show and venue into <backups>/<show>-<date>[-label].lightshow. */
export function writeBackup(s: FileServices, label?: string, now = new Date()): string {
  s.flush();
  const { show, venue } = s.current();
  const backupsDir = path.join(s.dataRoot, "backups");
  mkdirSync(backupsDir, { recursive: true });
  const name = `${show}-${stamp(now)}${label ? `-${slugify(label)}` : ""}.lightshow`;
  writeFileSync(path.join(backupsDir, name), packArchive({ show: { id: show, dir: path.join(s.dataRoot, "shows", show) }, venue: { id: venue, dir: path.join(s.dataRoot, "venues", venue) }, definitionDirs: definitionDirsFor(s.dataRoot, venue) }));
  return name;
}

/**
 * The day's automatic backup of the open show when it is due, then the pruning of old automatic
 * backups and of old object history (rules in data/retention.ts). Returns the file written, if any.
 */
export function runAutoBackup(s: FileServices, changedSince: boolean, now = new Date()): string | undefined {
  const backupsDir = path.join(s.dataRoot, "backups");
  const { show } = s.current();
  const files = existsSync(backupsDir) ? readdirSync(backupsDir) : [];
  const last = autoBackupsOf(files, show)[0];
  const written = autoBackupDue(now, last ? autoBackupTime(last, show) : undefined, changedSince) ? writeBackup(s, "auto", now) : undefined;
  for (const f of autoBackupsToPrune(written ? [...files, written] : files, show)) rmSync(path.join(backupsDir, f), { force: true });
  for (const kind of ["shows", "venues"]) {
    const root = path.join(backupsDir, kind);
    if (!existsSync(root)) continue;
    for (const store of readdirSync(root)) {
      const dir = path.join(root, store);
      if (!statSync(dir).isDirectory()) continue;
      for (const entry of historyToPrune(readdirSync(dir), now)) rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }
  return written;
}

export function registerFileCommands(reg: CommandRegistry, s: FileServices): void {
  const showsDir = path.join(s.dataRoot, "shows");
  const venuesDir = path.join(s.dataRoot, "venues");
  const backupsDir = path.join(s.dataRoot, "backups");
  const showDir = (id: string) => path.join(showsDir, id);
  const settingsOf = (id: string) => {
    const file = path.join(showDir(id), "show.json");
    return ShowSettingsSchema.parse(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  };
  const writeSettings = (id: string, patch: Record<string, unknown>) => {
    mkdirSync(showDir(id), { recursive: true });
    writeFileSync(path.join(showDir(id), "show.json"), stableStringify({ ...settingsOf(id), ...patch }));
  };
  const known = (id: string) => {
    if (!ID_RE.test(id) || !existsSync(showDir(id))) throw new Error(say(`show inconnu : ${id}`, `unknown show: ${id}`));
  };
  const freeId = (base: string, dir: string) => {
    let id = slugify(base);
    for (let i = 2; existsSync(path.join(dir, id)); i++) id = `${slugify(base).slice(0, 60)}-${i}`;
    return id;
  };
  const backup = (label?: string): string => writeBackup(s, label);
  const backupFile = (file: string) => {
    if (!BACKUP_RE.test(file) || !existsSync(path.join(backupsDir, file))) throw new Error(say(`sauvegarde inconnue : ${file}`, `unknown backup: ${file}`));
    return path.join(backupsDir, file);
  };

  /** Venue folders, and the shows that play on each. */
  const venueIds = () => (existsSync(venuesDir) ? readdirSync(venuesDir).filter((id) => ID_RE.test(id) && statSync(path.join(venuesDir, id)).isDirectory()) : []);
  const showIds = () => (existsSync(showsDir) ? readdirSync(showsDir).filter((id) => ID_RE.test(id) && statSync(showDir(id)).isDirectory()) : []);
  const showsOn = (venueId: string, except?: string) => showIds().filter((id) => id !== except && settingsOf(id).venue === venueId);
  const knownVenue = (id: string) => {
    if (!ID_RE.test(id) || !existsSync(path.join(venuesDir, id))) throw new Error(say(`lieu inconnu : ${id}`, `unknown venue: ${id}`));
  };
  /** The venue a show.json names, refused when it is not an id (a hand-edited or restored file must not reach outside data/venues). */
  const venueOf = (showId: string) => {
    const v = settingsOf(showId).venue;
    if (!ID_RE.test(v)) throw new Error(say(`lieu invalide dans le show ${showId} : ${v}`, `invalid venue in show ${showId}: ${v}`));
    return v;
  };
  /** A venue's patch as on disk; files that do not read as a fixture are skipped, and named in `unreadable` when given. */
  const fixturesOfVenue = (id: string, unreadable?: string[]): PatchedFixture[] => {
    const dir = path.join(venuesDir, id, "fixtures");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        let parsed;
        try {
          parsed = PatchedFixtureSchema.safeParse(JSON.parse(readFileSync(path.join(dir, f), "utf8")));
        } catch {
          parsed = undefined;
        }
        if (parsed?.success) return [parsed.data];
        unreadable?.push(f);
        return [];
      });
  };
  /** Points a show at a venue; the open show is reopened on it. */
  const attach = async (showId: string, venueId: string) => {
    s.flush();
    writeSettings(showId, { venue: venueId });
    if (showId === s.current().show) await s.open(showId);
  };

  reg.register({
    name: "show.list",
    title: "Shows",
    description: "The shows on this machine (folders under data/shows): id, name, venue, last change, and which one is open.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({}),
    run: () => {
      if (!existsSync(showsDir)) return [];
      return readdirSync(showsDir)
        .filter((id) => ID_RE.test(id) && statSync(showDir(id)).isDirectory())
        .map((id) => {
          const settings = settingsOf(id);
          const changed = Math.max(...[showDir(id), ...readdirSync(showDir(id)).map((f) => path.join(showDir(id), f))].map((f) => statSync(f).mtimeMs));
          return { id, name: settings.name, venue: settings.venue, active: id === s.current().show, changedAt: new Date(changed).toISOString() };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "fr"));
    },
  });

  reg.register({
    name: "show.create",
    title: "Nouveau show",
    description:
      "Creates a show, empty, as a copy of another (`from`, « Enregistrer sous » / « Dupliquer »), or from a QLC+ workspace (`qxw`, its text: imported into the new show), and opens it unless open is false. Venue: `current` plays on the open show's venue (same patch), `copy` copies that venue for this show, `new` starts an empty one (the right choice for another QLC+ workspace).",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({
      name: z.string().min(1),
      from: z.string().optional(),
      venue: z.enum(["current", "copy", "new"]).default("current"),
      open: z.boolean().default(true),
      qxw: z.string().optional(),
    }),
    run: async ({ name, from, venue, open, qxw }) => {
      if (qxw && (from || !open)) throw new Error(say("un workspace QLC+ s'importe dans un show neuf, ouvert aussitôt", "a QLC+ workspace is imported into a new show, opened at once"));
      if (from) known(from);
      s.flush();
      const id = freeId(name, showsDir);
      if (from) cpSync(showDir(from), showDir(id), { recursive: true });
      else mkdirSync(showDir(id), { recursive: true });
      const baseVenue = from ? venueOf(from) : s.current().venue;
      let venueId = baseVenue;
      if (venue !== "current") {
        venueId = freeId(id, venuesDir);
        if (venue === "copy" && existsSync(path.join(venuesDir, baseVenue))) cpSync(path.join(venuesDir, baseVenue), path.join(venuesDir, venueId), { recursive: true });
        else mkdirSync(path.join(venuesDir, venueId), { recursive: true });
      }
      // an empty venue has none of the copied show's fixtures: its absent list would darken fixtures patched later under the same ids
      writeSettings(id, { name, venue: venueId, ...(venue === "new" ? { absentFixtures: [] } : {}) });
      if (open) await s.open(id);
      const imported = qxw ? await s.importQxw(qxw) : undefined;
      return { id, name, venue: venueId, opened: open, imported };
    },
  });

  reg.register({
    name: "show.open",
    title: "Ouvrir un show",
    description: "Opens another show (and its venue): what plays stops, its looks, songs, dashboards and mappings replace the current ones on every screen.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: z.string() }),
    run: async ({ id }) => {
      known(id);
      await s.open(id);
      return { id, name: settingsOf(id).name, venue: settingsOf(id).venue };
    },
  });

  reg.register({
    name: "venue.list",
    title: "Lieux",
    description: "The venues on this machine (folders under data/venues): id, how many fixtures, the shows that play on it (a venue shared by several shows changes for all of them), and which one is open.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({}),
    run: () =>
      venueIds()
        .map((id) => {
          const shows = showsOn(id);
          return { id, fixtures: fixturesOfVenue(id).length, shows, shared: shows.length > 1, active: id === s.current().venue };
        })
        .sort((a, b) => a.id.localeCompare(b.id)),
  });

  reg.register({
    name: "show.venue.set",
    title: "Changer le lieu d'un show",
    description: "Makes a show play on another existing venue (default: the open show, which is reopened on it). Nothing is copied: the show now shares that venue with the others that use it. Its absent fixtures are kept by id: `absent` lists those the new venue has, dark for this show.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ venue: z.string(), show: z.string().optional() }),
    run: async ({ venue, show }) => {
      const target = show ?? s.current().show;
      known(target);
      knownVenue(venue);
      const was = settingsOf(target).venue;
      await attach(target, venue);
      const here = new Set(fixturesOfVenue(venue).map((f) => f.id));
      // the absent ids it keeps: those this venue has are dark for this show from now on
      return { show: target, venue, was, sharedWith: showsOn(venue, target), absent: settingsOf(target).absentFixtures.filter((i) => here.has(i)) };
    },
  });

  reg.register({
    name: "show.venue.detach",
    title: "Dissocier le lieu d'un show",
    description: "Gives a show its own copy of the venue it shares (patch, positions, canvases, zones, rules), so changing one no longer changes the other. Default: the open show, which is reopened on its copy. The other shows keep the original.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ show: z.string().optional() }),
    run: async ({ show }) => {
      const target = show ?? s.current().show;
      known(target);
      const from = venueOf(target);
      const others = showsOn(from, target);
      if (!others.length) return { show: target, venue: from, detached: false, sharedWith: [] };
      s.flush();
      const copy = freeId(target, venuesDir);
      if (existsSync(path.join(venuesDir, from))) cpSync(path.join(venuesDir, from), path.join(venuesDir, copy), { recursive: true });
      else mkdirSync(path.join(venuesDir, copy), { recursive: true });
      await attach(target, copy);
      return { show: target, venue: copy, from, detached: true, sharedWith: others };
    },
  });

  reg.register({
    name: "venue.positions.import",
    title: "Reprendre les positions d'un autre lieu",
    description:
      "Moves the open venue's fixtures to where another venue (`from`) has them: position, mount, orientation and target only; addresses, modes and names stay. Fixtures are paired by id, then by name, then by make/model/mode in address order (`ambiguous`: several candidates shared that name or model, paired by address: check them). A target zone this venue lacks is not copied (`skipped`). Without apply (the default) nothing is written: it lists what would move (changed fields per fixture), what is paired how, what has no equivalent on either side, and the source files that did not read (`unreadable`). With apply true every move is checked first, then written, one venue.fixture.put each; a write refused midway stops and says how many were moved.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ from: z.string(), apply: z.boolean().default(false) }),
    run: async ({ from, apply }, ctx) => {
      knownVenue(from);
      if (from === s.current().venue) throw new Error(say("c'est le lieu ouvert", "that is the open venue"));
      const mine = PatchedFixtureSchema.array().parse(await reg.invoke("venue.fixture.list", {}, ctx));
      // a target is a zone of the source: kept only where this venue has a zone of that id
      const zones = new Set((z.array(z.object({ id: z.string() }).passthrough()).parse(await reg.invoke("stage.zone.list", {}, ctx))).map((x) => x.id));
      const unreadable: string[] = [];
      const { pairs, unmatchedSource, unmatchedTarget } = pairFixtures(fixturesOfVenue(from, unreadable), mine);
      const moves = pairs.map((p) => ({ ...p, ...placementChange(p.from, p.to, zones) }));
      const toMove = moves.filter((m) => m.changed.length);
      // every fixture checked before the first write: a refused one would leave the venue half moved
      const next = toMove.map((m) => PatchedFixtureSchema.parse({ ...m.to, ...m.fields }));
      let written = 0;
      if (apply) {
        for (const fixture of next) {
          try {
            await reg.invoke("venue.fixture.put", { fixture }, ctx);
          } catch (err) {
            throw new Error(say(`${written} projecteur(s) déplacé(s) sur ${next.length}, arrêt sur ${fixture.id} : ${(err as Error).message}`, `${written} of ${next.length} fixture(s) moved, stopped at ${fixture.id}: ${(err as Error).message}`));
          }
          written++;
        }
      }
      return {
        applied: apply,
        moves: toMove.map((m) => ({ id: m.to.id, name: m.to.name, from: m.from.id, by: m.by, ...(m.ambiguous ? { ambiguous: true } : {}), changed: m.changed, ...(m.skipped.length ? { skipped: m.skipped } : {}) })),
        unchanged: moves.length - toMove.length,
        noEquivalentHere: unmatchedSource.map((f) => ({ id: f.id, name: f.name })),
        notInSource: unmatchedTarget.map((f) => ({ id: f.id, name: f.name })),
        ...(unreadable.length ? { unreadable } : {}),
      };
    },
  });

  reg.register({
    name: "show.rename",
    title: "Renommer un show",
    description: "Changes a show's displayed name (its folder keeps its id). Default: the open show.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: z.string().optional(), name: z.string().min(1) }),
    run: ({ id, name }) => {
      const target = id ?? s.current().show;
      known(target);
      writeSettings(target, { name });
      if (target === s.current().show) s.reload();
      return { id: target, name };
    },
  });

  reg.register({
    name: "show.delete",
    title: "Supprimer un show",
    description: "Moves a show that is not open to data/backups/deleted/ (recoverable by hand). Its venue stays.",
    right: "show:admin",
    profiles: ["setup"],
    schema: z.object({ id: z.string() }),
    run: ({ id }) => {
      known(id);
      if (id === s.current().show) throw new Error(say("impossible de supprimer le show ouvert : en ouvrir un autre d'abord", "the open show cannot be deleted: open another one first"));
      const deletedDir = path.join(backupsDir, "deleted");
      mkdirSync(deletedDir, { recursive: true });
      const target = path.join(deletedDir, freeId(`${stamp()}-${id}`, deletedDir));
      renameSync(showDir(id), target);
      return { id, movedTo: path.relative(s.dataRoot, target) };
    },
  });

  reg.register({
    name: "show.reset",
    title: "Réinitialiser le show",
    description:
      "Empties the open show (looks, groups, faders, songs, mappings, dashboards, rules, settings) and, with venue true, its venue too (patch, canvases, zones). A .lightshow backup is written first; its name is returned.",
    right: "show:admin",
    profiles: ["setup"],
    schema: z.object({ venue: z.boolean().default(false) }),
    run: ({ venue }) => {
      const saved = backup("avant-reinitialisation");
      const { show, venue: venueId } = s.current();
      const { name, absentFixtures } = settingsOf(show);
      rmSync(showDir(show), { recursive: true, force: true });
      // the venue kept, what is not installed stays so (its fixtures often share addresses with installed ones)
      writeSettings(show, { name, venue: venueId, ...(venue ? {} : { absentFixtures }) });
      if (venue) {
        rmSync(path.join(venuesDir, venueId), { recursive: true, force: true });
        mkdirSync(path.join(venuesDir, venueId), { recursive: true });
      }
      s.reload();
      return { show, venue: venue ? venueId : undefined, backup: saved };
    },
  });

  reg.register({
    name: "backup.list",
    title: "Sauvegardes",
    description: "The .lightshow backups kept on the server (data/backups): file, size, date, show and venue inside.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({}),
    run: () => {
      if (!existsSync(backupsDir)) return [];
      return readdirSync(backupsDir)
        .filter((f) => BACKUP_RE.test(f))
        .map((file) => {
          const full = path.join(backupsDir, file);
          let manifest: Partial<ArchiveManifest> = {};
          try {
            manifest = readArchive(new Uint8Array(readFileSync(full))).manifest;
          } catch {
            /* unreadable: listed without its content */
          }
          return { file, size: statSync(full).size, createdAt: manifest.createdAt ?? new Date(statSync(full).mtimeMs).toISOString(), show: manifest.show, venue: manifest.venue };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  });

  reg.register({
    name: "backup.create",
    title: "Enregistrer une sauvegarde",
    description: "Writes a .lightshow backup of the open show and its venue into data/backups (optional label in its name).",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ label: z.string().optional() }),
    // « auto » names the automatic backups, which rotate: a backup made by hand never does
    run: ({ label }) => ({ file: backup(label && slugify(label) === "auto" ? "auto-manuel" : label) }),
  });

  reg.register({
    name: "backup.restore",
    title: "Restaurer une sauvegarde",
    description:
      "Replaces the open show (and its venue, when the backup has one) with a backup from data/backups. The current folders are copied to data/backups first. The backup's fixture definitions (.qxf) are merged into the library: fixtures \"missing\" (default) adds the ones the library lacks, \"replace\" also overwrites the ones that differ (the old file is kept in the restore's backup folder), \"none\" leaves the library alone. dryRun: true only reports what would change (show, venue, definitions missing/differing/invalid).",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ file: z.string(), fixtures: FixturePolicySchema.default("missing"), dryRun: z.boolean().default(false) }),
    run: ({ file, fixtures, dryRun }) => {
      const bytes = new Uint8Array(readFileSync(backupFile(file)));
      return dryRun ? s.preview(bytes, fixtures) : s.restore(bytes, fixtures);
    },
  });
}

/** For the download route: the path of a backup file, or undefined. */
export function backupPath(dataRoot: string, file: string): string | undefined {
  const full = path.join(dataRoot, "backups", file);
  return BACKUP_RE.test(file) && existsSync(full) ? full : undefined;
}
