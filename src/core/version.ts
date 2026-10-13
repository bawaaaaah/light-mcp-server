import { readFileSync } from "node:fs";

let cached: string | undefined;

/** The package version, read once from package.json. */
export function getPackageVersion(): string {
  if (cached === undefined) {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    cached = pkg.version ?? "0.0.0";
  }
  return cached;
}
