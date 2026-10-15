// Adapted from wing-mcp-server (MIT, https://github.com/bawaaaaah/wing-mcp-server), src/core/env.ts.
// Typed environment variable getters with sane fallback defaults.

export function getEnvString(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : defaultValue;
}

export function getEnvInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function getEnvBool(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return defaultValue;
}

export const DEFAULT_PORT = 8790;
export const DEFAULT_HOST = "0.0.0.0";

export interface Listen {
  port: number;
  host: string;
}

/**
 * Where the HTTP gateway listens: the command-line flag, then `PORT` (port only), then
 * `server.port` / `server.host` in the machine config, then port 8790 on every interface.
 */
export function resolveListen(config: Partial<Listen>, flags: Partial<Listen> = {}): Listen {
  const envPort = getEnvInt("PORT", -1);
  return {
    port: flags.port ?? (envPort >= 0 ? envPort : undefined) ?? config.port ?? DEFAULT_PORT,
    host: flags.host ?? config.host ?? DEFAULT_HOST,
  };
}

/** The base URL a client on this machine (CLI) reaches the gateway at. */
export function localBaseUrl({ port, host }: Listen): string {
  const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}
