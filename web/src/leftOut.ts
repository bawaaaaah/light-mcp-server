/**
 * What a recall or an aim left out, as the toast says it (T32, T27): heads frozen hard (`refused`), heads a named
 * position does not cover, heads with no stage position, heads a point cannot reach. Pure, for the tests.
 */
import type { Texts } from "./i18n.js";
import { isFrench, quoted } from "./typography.js";

export interface GoReply {
  fixtures: string[];
  refused?: string[];
  notCovered?: string[];
  unreachable?: { fixture: string; error: string; unplaced?: true }[];
}

/**
 * Why a head was left out, without nested brackets (a head's name may hold some: « Lyre C (sol) »): the server's
 * « au-delà des butées (pan -120°, tilt 77°) » said « au-delà des butées : pan −120°, tilt 77° ».
 */
export const reasonText = (t: Texts, error: string): string =>
  error.replace(/\s*\(([^()]*)\)\s*$/, (_, inner: string) => `${t.colon} ${inner}`).replace(/-(?=\d)/g, "−");

/** What a recall left out, as sentences (empty: every head asked went there). Pure, for the tests. */
export function leftOut(t: Texts, name: string, reply: Partial<GoReply>, nameOf: (id: string) => string): string[] {
  const w = t.positions;
  const names = (list: string[]) => list.map(nameOf).join(", ");
  const unplaced = reply.unreachable?.filter((u) => u.unplaced) ?? [];
  const unreachable = reply.unreachable?.filter((u) => !u.unplaced) ?? [];
  return [
    reply.refused?.length ? (reply.refused.length === 1 ? w.refusedOne : w.refused).replace("{names}", () => names(reply.refused!)) : "",
    reply.notCovered?.length ? w.notCovered.replace("{name}", () => quoted(t, name)).replace("{names}", () => names(reply.notCovered!)) : "",
    unplaced.length ? w.unplaced.replace("{names}", () => names(unplaced.map((u) => u.fixture))) : "",
    unreachable.length ? w.unreachable.replace("{names}", () => unreachable.map((u) => `${nameOf(u.fixture)} — ${reasonText(t, u.error)}`).join(isFrench(t) ? " ; " : "; ")) : "",
  ].filter(Boolean);
}
