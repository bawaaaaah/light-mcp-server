/**
 * Recalling a named position from the interface (T32): the panel of a head, the Show page, a Live button — one
 * `position.preset.go`, and what it left out said in the one toast of the app (LockToastHost, T26): heads frozen hard
 * (`refused`), heads given that it does not cover, heads a point cannot reach. Never a silent refusal.
 */
import { ApiError, cmd } from "./api";
import { showLockToast } from "./components/MotionLockButton";
import type { Texts } from "./i18n";
import { leftOut, type GoReply } from "./leftOut";

export { leftOut };

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Recalls `id` on `fixtures` (all it covers when absent). Resolves to the heads that went there; a refusal is said in
 * the toast and resolves to [] (the caller has nothing more to do).
 */
export async function recallPosition(t: Texts, id: string, name: string, nameOf: (id: string) => string, fixtures?: string[]): Promise<string[]> {
  try {
    const reply = await cmd<GoReply>("position.preset.go", { id, ...(fixtures ? { fixtures } : {}) });
    const said = leftOut(t, name, reply, nameOf);
    if (said.length) showLockToast(said.join(" · "));
    return reply.fixtures;
  } catch (e) {
    if (e instanceof ApiError) {
      const said = leftOut(t, name, { refused: ids(e.detail?.refused), notCovered: ids(e.detail?.notCovered) }, nameOf);
      // the server's sentence names what blocks it; the frozen heads first, said as the lock control says them
      showLockToast(said.length ? said.join(" · ") : e.message);
      return [];
    }
    showLockToast((e as Error).message);
    return [];
  }
}
