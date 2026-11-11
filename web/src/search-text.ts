/** Text compared without case, accents or dash kind: « gobo », « Gobo », « red (16-31) », « intimite » find what they mean. */
export const fold = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2010-\u2015]/g, "-")
    .toLowerCase();

/** A search text folded, trimmed and with its blanks collapsed (empty when nothing was typed). */
export const searchPhrase = (query: string): string => fold(query).trim().replace(/\s+/g, " ");

/**
 * The items a search keeps: those whose text holds the whole phrase typed if any do, else those
 * holding every word of it. `texts` gives the strings an item is searched by.
 */
export function searchBy<T>(list: readonly T[], query: string, texts: (item: T) => readonly string[]): T[] {
  const phrase = searchPhrase(query);
  if (!phrase) return [...list];
  const folded = new Map(list.map((x) => [x, texts(x).map(fold)] as const));
  const whole = list.filter((x) => folded.get(x)!.some((t) => t.includes(phrase)));
  if (whole.length) return whole;
  const words = phrase.split(" ");
  return list.filter((x) => words.every((w) => folded.get(x)!.some((t) => t.includes(w))));
}
