#!/usr/bin/env node
/**
 * CLI `light` (docs/specs/data-cli-sdk.md). Phase 1 commands:
 *   light serve [--port 8790] [--host 0.0.0.0] [--stdio] [--no-http]
 *   light token                 prints the master token (MCP clients, scripts)
 *   light pin <role> <pin>      sets a role's PIN (admin, regisseur, benevole, lecture)
 *   light roles                 lists the roles
 */
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthService, resolveAuthToken } from "../core/auth.js";
import { ConfigStore } from "../core/config-store.js";
import { bootstrap } from "../index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const configPath = process.env.LIGHT_CONFIG_PATH ?? path.join(ROOT, "data", "machine", "config.json");

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
      options: { port: { type: "string" }, host: { type: "string" }, stdio: { type: "boolean", default: false }, "no-http": { type: "boolean", default: false } },
    });
    const running = await bootstrap({ configPath, port: values.port ? Number(values.port) : undefined, host: values.host, stdio: values.stdio, http: !values["no-http"] });
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
  default:
    console.log("light serve | token | pin <rôle> <pin> | roles");
    process.exit(command ? 1 : 0);
}
