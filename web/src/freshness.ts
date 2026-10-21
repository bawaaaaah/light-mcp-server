/**
 * A newer interface on the server (docs/specs/ui-dashboards.md, « Nouvelle version »): after an
 * update, a tab left open keeps running the old one, fixed bugs included, until it is reloaded. The
 * page compares the script it loaded with the one the server's page loads now.
 */

const SCRIPT = /<script[^>]*type="module"[^>]*src="([^"]+)"/;

/** The script this tab started from. */
const loaded = (): string | undefined => document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src") ?? undefined;

export async function newerBuild(): Promise<boolean> {
  const mine = loaded();
  if (!mine) return false;
  try {
    const res = await fetch("/", { cache: "no-store" });
    if (!res.ok) return false;
    const served = SCRIPT.exec(await res.text())?.[1];
    return Boolean(served) && served !== mine;
  } catch {
    return false; // the server is down or restarting: asked again when the link is back
  }
}
