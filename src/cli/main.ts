#!/usr/bin/env node
/**
 * CLI `light` (docs/specs/data-cli-sdk.md). Thin adapters on the command layer: over HTTP when a
 * server runs, in-process on the data folders otherwise (`--offline` forces it).
 */
import { parseArgs } from "node:util";
import path from "node:path";
import { AuthService, newMasterToken, resolveAuthToken } from "../core/auth.js";
import { ConfigStore } from "../core/config-store.js";
import { bootstrap } from "../index.js";
import { configPath as resolveConfigPath, dataRoot } from "../core/paths.js";
import { getEnvBool } from "../core/env.js";
import { readFileSync, writeFileSync } from "node:fs";
import { connect, CliError, localServerUrl, reachable, type Caller } from "./client.js";
import { diffFolder, packArchive, readArchive, restoreFolder, type FolderDiff } from "../plugins/light/data/archive.js";

const USAGE = `light <commande>
  serve [--port 8790] [--host 0.0.0.0] [--stdio] [--no-http] [--standby | --live]
                                  lance le serveur (--standby : n'envoie rien, QLC+ tient les nodes)
  token [--new]                   jeton maître (clients MCP, scripts) ; --new : le renouveler, sans l'afficher
  pin <utilisateur> <pin>         PIN d'un utilisateur (un nom de rôle crée l'utilisateur de ce rôle)
  roles                           liste des rôles
  users                           liste des utilisateurs (rôle, PIN)
  check                           vérifie le show (lint) ; code de sortie 1 en cas d'erreur
  selftest [--cadence]            auto-test (mappings, exclusivité, latence, cadence)
  import qxw <fichier> [--apply] [--replace] [--force]
                                  import d'un workspace QLC+ (proposition, puis --apply) ; une réimportation
                                  garde les retouches faites à la main (--replace : les écraser) ; un autre
                                  workspace que celui du show est refusé (--force : l'importer quand même)
  export cuesheet [--setlist id]  feuille de conduite (Markdown)
  export notes [--csv]            table des notes MIDI
  export board [--song id]        planche (storyboard SVG) d'un chant
  export mid [--song id]          fichier MIDI d'un chant (notes des looks, Program Change des programmes)
  export programs [--shell f]     un clip Ableton .alc par programme de règles (Program Change au lancement)
  export ableton [--shell f]      MIDI Effect Rack depuis la coquille (data/private/)
  export liveset --setlist id --als f --track nom
                                  pose la setlist dans une copie du Live Set (Live fermé)
  osc-table                       adresses OSC
  show list                       shows de la machine (le show ouvert est marqué)
  show new <nom> [--from id] [--venue current|copy|new]
                                  nouveau show, vide ou copie d'un autre (« Enregistrer sous »), puis ouvert
  show open <id>                  ouvre un autre show (et son lieu)
  show rename <nom>               renomme le show ouvert
  show reset [--with-venue]       vide le show ouvert (et son lieu), après une sauvegarde
  backup list|create [libellé]|restore <fichier>
                                  sauvegardes .lightshow gardées dans data/backups
  pack [fichier] [--no-venue]     sauvegarde .lightshow
  unpack <fichier> [--check]      restaure une sauvegarde (avec copie de l'existant) ; --check : différences seulement
  standby on|off                  sortie en veille / reprendre la main
  activity [--limit 30]           activité récente : quand, qui, d'où, quoi, sur quel objet
  call <commande> [json] [--check]  n'importe quelle commande (voir « commands ») ;
                                  --check : ce qu'un enregistrement (*.put) changerait, sans écrire
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
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await running.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // Windows has no SIGTERM: its tray app (windows/) asks for a clean stop by closing our stdin, which
    // also happens when the app dies. Not with --stdio, whose stdin carries MCP.
    if (getEnvBool("LIGHT_STOP_ON_STDIN_CLOSE", false) && !values.stdio) {
      process.stdin.on("end", shutdown).on("close", shutdown).on("error", shutdown).resume();
    }
    break;
  }
  case "token": {
    if (rest.includes("--new")) {
      // never printed: a token on a screen or in a log is a token to renew again
      const { store, token } = await machine();
      const base = localServerUrl(store);
      if (await reachable(base)) {
        // the running server rewrites the whole config from memory: it must make the change itself
        const res = await fetch(`${base}/api/auth/master-token`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) {
          console.error(`Renouvellement refusé par le serveur (${res.status}).`);
          process.exit(1);
        }
        console.log("Jeton maître renouvelé par le serveur, qui l'applique déjà (non affiché ; « light token » pour le lire).");
      } else {
        await store.setServerAuthToken(newMasterToken());
        console.log("Jeton maître renouvelé (non affiché ; « light token » pour le lire) : le serveur le prendra à son démarrage.");
      }
      console.log("À mettre à jour : les clients qui ont le jeton en dur (scripts, clients MCP par jeton) et les onglets ouverts avec lui ; le menu de la barre le relit tout seul. Les sessions par PIN, les clés et les connexions OAuth restent valides.");
      break;
    }
    console.log((await machine()).token);
    break;
  }
  case "pin": {
    const [role, pin] = rest;
    if (!role || !pin) {
      console.error("usage : light pin <utilisateur> <pin>");
      process.exit(1);
    }
    await (await machine()).auth.setPin(role, pin);
    console.log(`PIN de « ${role} » enregistré.`);
    break;
  }
  case "users": {
    for (const u of (await machine()).auth.users()) console.log(`${u.id.padEnd(20)} ${u.name.padEnd(24)} ${u.roleName.padEnd(24)} PIN ${u.hasPin ? "défini" : "—"}${u.disabled ? "  (désactivé)" : ""}`);
    break;
  }
  case "roles": {
    for (const r of (await machine()).auth.roles()) console.log(`${r.id.padEnd(10)} ${r.name.padEnd(24)} droits : ${r.rights.join(", ")}`);
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
      force: { type: "boolean", default: false },
      cadence: { type: "boolean", default: false },
      setlist: { type: "string" },
      song: { type: "string" },
      csv: { type: "boolean", default: false },
      shell: { type: "string" },
      als: { type: "string" },
      track: { type: "string" },
      "no-venue": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      from: { type: "string" },
      venue: { type: "string" },
      "with-venue": { type: "boolean", default: false },
      limit: { type: "string" },
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
        json(await caller.call("import.qxw", { xml: readFileSync(file, "utf8"), apply: values.apply, replace: values.replace, force: values.force }));
        if (!values.apply) console.error("(proposition seulement : relancer avec --apply pour écrire)");
        return 0;
      }
      case "export": {
        const [kind] = positionals;
        if (kind === "cuesheet") console.log(await caller.call<string>("export.cuesheet", values.setlist ? { setlist: values.setlist } : {}));
        else if (kind === "notes") console.log(await caller.call<string>("export.notes", { format: values.csv ? "csv" : "markdown" }));
        else if (kind === "mid") json(await caller.call("export.mid", values.song ? { song: values.song } : {}));
        else if (kind === "programs") json(await caller.call("export.ableton.programs", values.shell ? { shell: values.shell } : {}));
        else if (kind === "board") console.log(await caller.call<string>("export.board", values.song ? { song: values.song } : {}));
        else if (kind === "ableton") json(await caller.call("export.ableton.rack", values.shell ? { shell: values.shell } : {}));
        else if (kind === "liveset") {
          if (!values.setlist || !values.als || !values.track) throw new CliError("usage : light export liveset --setlist <id> --als <fichier> --track <piste>");
          json(await caller.call("export.liveset", { setlist: values.setlist, als: values.als, track: values.track }));
        } else throw new CliError("usage : light export cuesheet | notes | board | mid | programs | ableton | liveset");
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
      case "show": {
        const [action, arg] = positionals;
        if (action === "list") for (const sh of await caller.call<{ id: string; name: string; venue: string; active: boolean }[]>("show.list")) console.log(`${sh.active ? "▶" : " "} ${sh.id.padEnd(24)} ${sh.name}  (lieu ${sh.venue})`);
        else if (action === "new" && arg) json(await caller.call("show.create", { name: arg, from: values.from, venue: values.venue }));
        else if (action === "open" && arg) json(await caller.call("show.open", { id: arg }));
        else if (action === "rename" && arg) json(await caller.call("show.rename", { name: arg }));
        else if (action === "reset") json(await caller.call("show.reset", { venue: values["with-venue"] }));
        else throw new CliError("usage : light show list|new <nom>|open <id>|rename <nom>|reset [--with-venue]");
        return 0;
      }
      case "backup": {
        const [action, arg] = positionals;
        if (action === "list") for (const b of await caller.call<{ file: string; size: number; show?: string }[]>("backup.list")) console.log(`${b.file}  ${Math.round(b.size / 1024)} Kio`);
        else if (action === "create") json(await caller.call("backup.create", arg ? { label: arg } : {}));
        else if (action === "restore" && arg) json(await caller.call("backup.restore", { file: arg }));
        else throw new CliError("usage : light backup list|create [libellé]|restore <fichier>");
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
      case "activity": {
        type Entry = { at: number; count: number; title: string; origin: string; who?: string; target?: string; ok: boolean; error?: string };
        const list = await caller.call<Entry[]>("activity.list", { limit: Math.min(500, Math.max(1, Number(values.limit ?? 30) || 30)) });
        const when = (ms: number) => new Date(ms).toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
        if (!list.length) console.log("Rien sur la dernière semaine.");
        // oldest first, as a terminal reads
        for (const e of [...list].reverse()) console.log(`${when(e.at)}  ${(e.who ?? "—").padEnd(18)} ${e.origin.padEnd(8)} ${e.ok ? "✔" : "✖"} ${e.title}${e.target ? ` · ${e.target}` : ""}${e.count > 1 ? ` ×${e.count}` : ""}${e.error ? ` (${e.error})` : ""}`);
        return 0;
      }
      case "call": {
        const [command, args] = positionals;
        if (!command) throw new CliError("usage : light call <commande> [json] [--check]");
        // --check: what the write would change (show.diff), nothing written
        json(values.check ? await caller.call("show.diff", { command, args: args ? JSON.parse(args) : {} }) : await caller.call(command, args ? JSON.parse(args) : {}));
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
