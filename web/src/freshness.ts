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

const RELOADED = "reloadedForMissingChunk";

/**
 * A page opened before an update asks for a part of the interface the update replaced (each page is
 * its own file, named after its content: « Songs-DoiuLkLT.js » is gone, the server answers 404):
 * the page reloads once, which brings the new interface, instead of failing. Never twice in ten
 * seconds: a part really missing must not reload the page in a loop.
 */
export function reloadOnMissingChunk(storage: Pick<Storage, "getItem" | "setItem"> = sessionStorage, reload = () => location.reload(), now = Date.now): void {
  window.addEventListener("vite:preloadError", (e) => {
    let last = 0;
    try {
      last = Number(storage.getItem(RELOADED) ?? 0);
    } catch {
      /* no storage: reload all the same */
    }
    if (now() - last < 10_000) return; // already tried: the error shows as it is
    e.preventDefault();
    try {
      storage.setItem(RELOADED, String(now()));
    } catch {
      /* the guard is lost, not the reload */
    }
    reload();
  });
}

