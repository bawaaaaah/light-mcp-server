/**
 * Show files, as in a classic lighting console (docs/specs/data-cli-sdk.md, « Shows et sauvegardes »):
 * list, create (empty or as a copy), open, rename, delete (to the backups), reset, and `.lightshow`
 * backups kept on the server. A show is a folder under <dataRoot>/shows and plays on the venue its
 * show.json names; everything is saved as it changes, so « Enregistrer sous » is a copy.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { packArchive, readArchive, type ArchiveManifest } from "../data/archive.js";
import { ID_RE, slugify, stableStringify } from "../data/store.js";
import { ShowSettingsSchema } from "../show/model.js";
import type { CommandRegistry } from "./registry.js";

export interface FileServices {
  dataRoot: string;
  current(): { show: string; venue: string };
  /** Switches the running show (and its venue). */
  open(id: string): Promise<void>;
  /** Writes pending live values, so a copy or an archive has them. */
  flush(): void;
  /** Re-reads the current show and venue from disk (after a reset or a restore). */
  reload(): void;
  /** Replaces the current show (and venue) with an archive's content, after a backup copy. */
  restore(bytes: Uint8Array): { backup: string; files: { show: number; venue: number } };
  /** Imports a QLC+ workspace (.qxw text) into the open show. */
  importQxw(xml: string): Promise<unknown>;
}

/** Local date and time for file names, as the user reads them: 2026-10-15_23-01-52. */
const stamp = (d = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
const BACKUP_RE = /^[\w.-]+\.lightshow$/;

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
    if (!ID_RE.test(id) || !existsSync(showDir(id))) throw new Error(`show inconnu : ${id}`);
  };
  const freeId = (base: string, dir: string) => {
    let id = slugify(base);
    for (let i = 2; existsSync(path.join(dir, id)); i++) id = `${slugify(base).slice(0, 60)}-${i}`;
    return id;
  };
  /** Packs the current show and venue into <backups>/<show>-<date>[-label].lightshow. */
  const backup = (label?: string): string => {
    s.flush();
    const { show, venue } = s.current();
    mkdirSync(backupsDir, { recursive: true });
    const name = `${show}-${stamp()}${label ? `-${slugify(label)}` : ""}.lightshow`;
    writeFileSync(path.join(backupsDir, name), packArchive({ show: { id: show, dir: showDir(show) }, venue: { id: venue, dir: path.join(venuesDir, venue) } }));
    return name;
  };
  const backupFile = (file: string) => {
    if (!BACKUP_RE.test(file) || !existsSync(path.join(backupsDir, file))) throw new Error(`sauvegarde inconnue : ${file}`);
    return path.join(backupsDir, file);
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
      if (qxw && (from || !open)) throw new Error("un workspace QLC+ s'importe dans un show neuf, ouvert aussitôt");
      if (from) known(from);
      s.flush();
      const id = freeId(name, showsDir);
      if (from) cpSync(showDir(from), showDir(id), { recursive: true });
      else mkdirSync(showDir(id), { recursive: true });
      const baseVenue = from ? settingsOf(from).venue : s.current().venue;
      let venueId = baseVenue;
      if (venue !== "current") {
        venueId = freeId(id, venuesDir);
        if (venue === "copy" && existsSync(path.join(venuesDir, baseVenue))) cpSync(path.join(venuesDir, baseVenue), path.join(venuesDir, venueId), { recursive: true });
        else mkdirSync(path.join(venuesDir, venueId), { recursive: true });
      }
      writeSettings(id, { name, venue: venueId });
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
      if (id === s.current().show) throw new Error("impossible de supprimer le show ouvert : en ouvrir un autre d'abord");
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
      const name = settingsOf(show).name;
      rmSync(showDir(show), { recursive: true, force: true });
      writeSettings(show, { name, venue: venueId });
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
    run: ({ label }) => ({ file: backup(label) }),
  });

  reg.register({
    name: "backup.restore",
    title: "Restaurer une sauvegarde",
    description: "Replaces the open show (and its venue, when the backup has one) with a backup from data/backups. The current folders are copied to data/backups first.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ file: z.string() }),
    run: ({ file }) => s.restore(new Uint8Array(readFileSync(backupFile(file)))),
  });
}

/** For the download route: the path of a backup file, or undefined. */
export function backupPath(dataRoot: string, file: string): string | undefined {
  const full = path.join(dataRoot, "backups", file);
  return BACKUP_RE.test(file) && existsSync(full) ? full : undefined;
}
