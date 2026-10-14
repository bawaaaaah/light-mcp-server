#!/usr/bin/env node
/**
 * CLI `light` (docs/specs/data-cli-sdk.md). Thin adapters on the command layer: over HTTP when a
 * server runs, in-process on the data folders otherwise (`--offline` forces it).
 */
import { parseArgs } from "node:util";
import path from "node:path";
import { AuthService, resolveAuthToken } from "../core/auth.js";
import { ConfigStore } from "../core/config-store.js";
import { bootstrap } from "../index.js";
import { configPath as resolveConfigPath, dataRoot } from "../core/paths.js";
import { readFileSync, writeFileSync } from "node:fs";
import { connect, CliError, type Caller } from "./client.js";
import { diffFolder, packArchive, readArchive, restoreFolder, type FolderDiff } from "../plugins/light/data/archive.js";

const USAGE = `light <commande>
  serve [--port 8790] [--host 0.0.0.0] [--stdio] [--no-http] [--standby | --live]
                                  lance le serveur (--standby : n'envoie rien, QLC+ tient les nodes)
  token                           jeton maître (clients MCP, scripts)
  pin <rôle> <pin>                PIN d'un rôle (admin, regisseur, benevole, lecture)
  roles                           liste des rôles
  check                           vérifie le show (lint) ; code de sortie 1 en cas d'erreur
  selftest [--cadence]            auto-test (mappings, exclusivité, latence, cadence)
  import qxw <fichier> [--apply] [--replace]
                                  import d'un workspace QLC+ (proposition, puis --apply) ; une réimportation
                                  garde les retouches faites à la main (--replace : les écraser)
  export cuesheet [--setlist id]  feuille de conduite (Markdown)
  export notes [--csv]            table des notes MIDI
  export board [--song id]        planche (storyboard SVG) d'un chant
  export ableton [--shell f]      MIDI Effect Rack depuis la coquille (data/private/)
  export liveset --setlist id --als f --track nom
                                  pose la setlist dans une copie du Live Set (Live fermé)
  osc-table                       adresses OSC
  pack [fichier] [--no-venue]     sauvegarde .lightshow
  unpack <fichier> [--check]      restaure une sauvegarde (avec copie de l'existant) ; --check : différences seulement
  standby on|off                  sortie en veille / reprendre la main
  call <commande> [json]          n'importe quelle commande (voir « commands »)
  commands                        liste des commandes
Options communes : --offline (ouvre les données sans passer par le serveur), --url http://hôte:port`;


const DATA_ROOT = dataRoot();
const configPath = resolveConfigPath();

async function machine(): Promise<{ store: ConfigStore; auth: AuthService; token: string }> {
  const store = new ConfigStore({ filePath: configPath });
  await store.load();
  const token = await resolveAuthToken(store);
  return { store, auth: new AuthService(token, store), token };
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "serve": {
    const { values } = parseArgs({
      args: rest,
      options: { port: { type: "string" }, host: { type: "string" }, stdio: { type: "boolean", default: false }, "no-http": { type: "boolean", default: false }, standby: { type: "boolean" }, live: { type: "boolean" } },
    });
    if (values.standby && values.live) {
      console.error("--standby et --live sont incompatibles");
      process.exit(1);
    }
    const standby = values.standby ? true : values.live ? false : undefined;
    const running = await bootstrap({ configPath, port: values.port ? Number(values.port) : undefined, host: values.host, stdio: values.stdio, http: !values["no-http"], light: standby === undefined ? undefined : { standby } });
    const shutdown = async () => {
      await running.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    break;
  }
  case "token": {
    console.log((await machine()).token);
    break;
  }
  case "pin": {
    const [role, pin] = rest;
    if (!role || !pin) {
      console.error("usage : light pin <rôle> <pin>");
      process.exit(1);
    }
    await (await machine()).auth.setPin(role, pin);
    console.log(`PIN du rôle « ${role} » enregistré.`);
    break;
  }
  case "roles": {
    for (const r of (await machine()).auth.roles()) console.log(`${r.id.padEnd(10)} ${r.name.padEnd(24)} PIN ${r.pinHash ? "défini" : "—"}  droits : ${r.rights.join(", ")}`);
    break;
  }
  case undefined:
  case "help":
  case "--help":
    console.log(USAGE);
    break;
  default: {
    try {
      process.exitCode = await runCommand(command, rest);
    } catch (err) {
      console.error(err instanceof CliError ? err.message : (err as Error).stack);
      process.exitCode = 1;
    }
  }
}

/** Commands that go through the command layer; returns the exit code. */
async function runCommand(name: string, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      offline: { type: "boolean", default: false },
      url: { type: "string" },
      apply: { type: "boolean", default: false },
      replace: { type: "boolean", default: false },
      cadence: { type: "boolean", default: false },
      setlist: { type: "string" },
      song: { type: "string" },
      csv: { type: "boolean", default: false },
      shell: { type: "string" },
      als: { type: "string" },
      track: { type: "string" },
      "no-venue": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
    },
  });
  const caller = await connect({ configPath, dataRoot: DATA_ROOT, url: values.url, offline: values.offline, token: async () => (await machine()).token });
  if (caller.mode === "offline") console.error("(serveur injoignable : données ouvertes directement)");
  const json = (v: unknown) => console.log(JSON.stringify(v, null, 2));
  try {
    switch (name) {
      case "check": {
        const lint = await caller.call<{ ok: boolean; issues: { level: string; where: string; message: string }[] }>("show.lint");
        for (const i of lint.issues) console.log(`${i.level === "erreur" ? "✖" : "⚠"} ${i.where} : ${i.message}`);
        console.log(lint.ok ? "✔ show valide" : "✖ erreurs à corriger");
        return lint.ok ? 0 : 1;
      }
      case "selftest": {
        type R = { total: number; passed: number; failed: { label: string; mapping: string; reason: string }[]; exclusivity: { group: string; ok: boolean; detail?: string }[]; latencyMs: { p50: number; max: number }; cadence?: { bpm: number; looks: { look: string; ok: boolean; measuredMs?: number; expectedMs: number; detail?: string }[] } };
        const r = await caller.call<R>("selftest.run", { cadence: values.cadence });
        console.log(`Mappings : ${r.passed}/${r.total} · latence ${r.latencyMs.p50} ms (max ${r.latencyMs.max} ms)`);
        for (const f of r.failed) console.log(`  ✖ ${f.label || f.mapping} : ${f.reason}`);
        for (const e of r.exclusivity) console.log(`  ${e.ok ? "✔" : "✖"} exclusivité ${e.group}${e.detail ? ` : ${e.detail}` : ""}`);
        if (r.cadence) {
          console.log(`Cadence à ${r.cadence.bpm} BPM :`);
          for (const c of r.cadence.looks) console.log(`  ${c.ok ? "✔" : "✖"} ${c.look} ${c.measuredMs ?? "—"} / ${Math.round(c.expectedMs)} ms${c.detail ? ` (${c.detail})` : ""}`);
        }
        const ok = r.failed.length === 0 && r.exclusivity.every((e) => e.ok) && (r.cadence?.looks.every((c) => c.ok) ?? true);
        return ok ? 0 : 1;
      }
      case "import": {
        const [kind, file] = positionals;
        if (kind !== "qxw" || !file) throw new CliError("usage : light import qxw <fichier> [--apply]");
        json(await caller.call("import.qxw", { xml: readFileSync(file, "utf8"), apply: values.apply, replace: values.replace }));
        if (!values.apply) console.error("(proposition seulement : relancer avec --apply pour écrire)");
        return 0;
      }
      case "export": {
        const [kind] = positionals;
        if (kind === "cuesheet") console.log(await caller.call<string>("export.cuesheet", values.setlist ? { setlist: values.setlist } : {}));
        else if (kind === "notes") console.log(await caller.call<string>("export.notes", { format: values.csv ? "csv" : "markdown" }));
        else if (kind === "board") console.log(await caller.call<string>("export.board", values.song ? { song: values.song } : {}));
        else if (kind === "ableton") json(await caller.call("export.ableton.rack", values.shell ? { shell: values.shell } : {}));
        else if (kind === "liveset") {
          if (!values.setlist || !values.als || !values.track) throw new CliError("usage : light export liveset --setlist <id> --als <fichier> --track <piste>");
          json(await caller.call("export.liveset", { setlist: values.setlist, als: values.als, track: values.track }));
        } else throw new CliError("usage : light export cuesheet | notes | board | ableton | liveset");
        return 0;
      }
      case "osc-table":
        json(await caller.call("osc.table"));
        return 0;
      case "standby": {
        const [on] = positionals;
        if (on !== "on" && on !== "off") throw new CliError("usage : light standby on|off");
        json(await caller.call("output.standby", { on: on === "on" }));
        return 0;
      }
      case "pack":
        return await pack(caller, positionals[0], !values["no-venue"]);
      case "unpack":
        if (!positionals[0]) throw new CliError("usage : light unpack <fichier.lightshow>");
        return await unpack(caller, positionals[0], values.check);
      case "commands": {
        const list = caller.plugin ? caller.plugin.commands.list() : ((await (await caller.http!("/commands")).json()) as { name: string; title: string; readOnly?: boolean }[]);
        for (const c of list) console.log(`${c.name.padEnd(28)} ${c.readOnly ? "lecture" : "écriture"}  ${c.title}`);
        return 0;
      }
      case "call": {
        const [command, args] = positionals;
        if (!command) throw new CliError("usage : light call <commande> [json]");
        json(await caller.call(command, args ? JSON.parse(args) : {}));
        return 0;
      }
      default:
        console.error(USAGE);
        return 1;
    }
  } finally {
    await caller.close();
  }
}

async function pack(caller: Caller, file: string | undefined, withVenue: boolean): Promise<number> {
  let bytes: Uint8Array;
  let name: string;
  if (caller.http) {
    const res = await caller.http(`/archive${withVenue ? "" : "?venue=0"}`);
    if (!res.ok) throw new CliError(`archive : ${res.statusText}`);
    bytes = new Uint8Array(await res.arrayBuffer());
    name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "show.lightshow";
  } else {
    const p = caller.plugin!;
    bytes = packArchive({ show: { id: path.basename(p.runtime.store.root), dir: p.runtime.store.root }, venue: withVenue ? { id: path.basename(p.venue.store.root), dir: p.venue.store.root } : undefined });
    name = `${path.basename(p.runtime.store.root)}.lightshow`;
  }
  const out = file ?? name;
  writeFileSync(out, bytes);
  console.log(`✔ ${out} (${Math.round(bytes.length / 1024)} Kio)`);
  return 0;
}

function printDiff(label: string, d: FolderDiff | null): void {
  if (d === null) return console.log(`${label} : inchangé (absent de la sauvegarde)`);
  console.log(`${label} : ${d.added.length} ajouté(s), ${d.changed.length} modifié(s), ${d.removed.length} supprimé(s), ${d.unchanged} identique(s)`);
  for (const p of d.added) console.log(`  + ${p}`);
  for (const p of d.changed) console.log(`  ~ ${p}`);
  for (const p of d.removed) console.log(`  - ${p}`);
}

async function unpack(caller: Caller, file: string, check = false): Promise<number> {
  const bytes = readFileSync(file);
  if (check) {
    let diff: { show: FolderDiff | null; venue: FolderDiff | null };
    if (caller.http) {
      const res = await caller.http("/archive?dryRun=1", { method: "POST", body: bytes });
      const body = (await res.json()) as typeof diff & { error?: string };
      if (!res.ok) throw new CliError(`archive : ${body.error ?? res.statusText}`);
      diff = body;
    } else {
      const content = readArchive(new Uint8Array(bytes));
      const p = caller.plugin!;
      diff = { show: Object.keys(content.show).length ? diffFolder(p.runtime.store.root, content.show) : null, venue: Object.keys(content.venue).length ? diffFolder(p.venue.store.root, content.venue) : null };
    }
    printDiff("Show", diff.show);
    printDiff("Lieu", diff.venue);
    console.error("(rien n'a été écrit : relancer sans --check pour restaurer)");
    return 0;
  }
  if (caller.http) {
    const res = await caller.http("/archive", { method: "POST", body: bytes });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) throw new CliError(`restauration : ${body.error ?? res.statusText}`);
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  const p = caller.plugin!;
  const content = readArchive(new Uint8Array(bytes));
  const backups = path.join(DATA_ROOT, "backups", "restore-" + new Date().toISOString().replace(/[:.]/g, "-"));
  if (Object.keys(content.show).length) restoreFolder(p.runtime.store.root, content.show, path.join(backups, "show"));
  if (Object.keys(content.venue).length) restoreFolder(p.venue.store.root, content.venue, path.join(backups, "venue"));
  console.log(`✔ restauré (${Object.keys(content.show).length} fichiers de show, ${Object.keys(content.venue).length} de lieu) ; copie de l'existant : ${path.relative(DATA_ROOT, backups)}`);
  return 0;
}
