/**
 * How the CLI reaches the command layer (docs/specs/data-cli-sdk.md): over HTTP when a server is
 * running (master token), otherwise by opening the data folders in-process — never both, so there
 * is never a second writer on a show a server is using.
 */
import { ConfigStore } from "../core/config-store.js";
import { localBaseUrl, resolveListen } from "../core/env.js";
import { EventBus } from "../core/event-bus.js";
import { LightPlugin, PLUGIN_ID } from "../plugins/light/light-plugin.js";
import { systemContext } from "../plugins/light/commands/registry.js";

export interface Caller {
  mode: "server" | "offline";
  call<T = unknown>(command: string, args?: unknown): Promise<T>;
  /** Raw HTTP to the plugin routes (archive); offline: undefined. */
  http?: (route: string, init?: RequestInit) => Promise<Response>;
  /** Offline only: the data folders, for pack/unpack. */
  plugin?: LightPlugin;
  close(): Promise<void>;
}

export class CliError extends Error {}

/** A running server answers its health check within a short delay. */
async function reachable(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function connect(opts: { configPath: string; dataRoot: string; url?: string; token: () => Promise<string>; offline?: boolean }): Promise<Caller> {
  const store = new ConfigStore({ filePath: opts.configPath });
  await store.load();
  const base = (opts.url ?? process.env.LIGHT_URL ?? localBaseUrl(resolveListen({ port: store.getServerPort(), host: store.getServerHost() }))).replace(/\/$/, "");
  if (!opts.offline && (await reachable(base))) {
    const token = await opts.token();
    // x-light-origin: the activity log says « CLI », not « interface »
    const http = (route: string, init: RequestInit = {}) => fetch(`${base}/api/plugins/light${route}`, { ...init, headers: { authorization: `Bearer ${token}`, "x-light-origin": "cli", ...(init.headers ?? {}) } });
    return {
      mode: "server",
      http,
      async call<T>(command: string, args: unknown = {}): Promise<T> {
        const res = await http(`/commands/${command}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
        const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
        if (!res.ok) throw new CliError(`${command} : ${body.error ?? res.statusText}`);
        return body.result as T;
      },
      close: async () => undefined,
    };
  }
  const plugin = new LightPlugin({ eventBus: new EventBus(), config: store.scoped(PLUGIN_ID), dataRoot: opts.dataRoot, midiNative: null });
  return {
    mode: "offline",
    plugin,
    async call<T>(command: string, args: unknown = {}): Promise<T> {
      try {
        return (await plugin.commands.invoke(command, args, systemContext("cli"))) as T;
      } catch (err) {
        throw new CliError(`${command} : ${(err as Error).message}`);
      }
    },
    close: async () => plugin.saveActivity(), // what it changed shows in the activity log too
  };
}
