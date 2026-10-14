/**
 * Where things live. The data folder must never sit inside node_modules (an npm update would wipe
 * it): installed from npm, it is ./data of the current directory, like wing-mcp-server; in a source
 * checkout or the Docker image, the package's own data/ folder. LIGHT_DATA_ROOT overrides both.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The package root (src/core → .., dist/core → ..). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function dataRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), packageRoot = PACKAGE_ROOT): string {
  if (env.LIGHT_DATA_ROOT) return path.resolve(cwd, env.LIGHT_DATA_ROOT);
  const installed = packageRoot.split(path.sep).includes("node_modules");
  return installed ? path.resolve(cwd, "data") : path.join(packageRoot, "data");
}

export function configPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), packageRoot = PACKAGE_ROOT): string {
  return env.LIGHT_CONFIG_PATH ? path.resolve(cwd, env.LIGHT_CONFIG_PATH) : path.join(dataRoot(env, cwd, packageRoot), "machine", "config.json");
}

/** The built web interface shipped with the package. */
export const webRoot = (): string => path.join(PACKAGE_ROOT, "web", "dist");
