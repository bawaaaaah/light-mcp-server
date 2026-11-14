/** Rights as the server matches them (src/core/auth.ts, rightMatches): pure, shared by the pages and tested against the server. */

/** Same table as the server's IMPLIED_RIGHTS: show:write brings show:propose, commands:position brings commands:freeze. */
export const IMPLIED: Readonly<Record<string, string>> = { "show:propose": "show:write", "commands:freeze": "commands:position" };

/** Granted outright: "*", "area:*" or the right itself. */
const direct = (rights: readonly string[], wanted: string) => rights.some((g) => g === "*" || g === wanted || (g.endsWith(":*") && wanted.startsWith(g.slice(0, -1))));

/** Same rule as the server's rightMatches: "*" and "area:*" grant wholesale, and a right brings the one it implies. */
export function grants(rights: readonly string[], right: string): boolean {
  const implier = IMPLIED[right];
  return direct(rights, right) || (implier !== undefined && direct(rights, implier));
}

/** The right that brings `right` when only it does (`right` itself not granted outright): undefined otherwise. */
export function impliedBy(rights: readonly string[], right: string): string | undefined {
  const implier = IMPLIED[right];
  return implier !== undefined && !direct(rights, right) && direct(rights, implier) ? implier : undefined;
}
