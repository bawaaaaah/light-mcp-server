/** Small shared helpers of the web UI. */

/** Readable id from a name: « Refrain final » → "refrain-final". */
export const slug = (s: string, fallback = "item"): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || fallback;

/** `base`, or `base-2`, `base-3`… when taken. */
export function uniqueId(base: string, existing: string[]): string {
  if (!base) return "";
  let id = base;
  for (let i = 2; existing.includes(id); i++) id = `${base}-${i}`;
  return id;
}

/** "a, b ,c" → ["a", "b", "c"] */
export const splitList = (s: string): string[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** In-page links: scroll to a section without touching the address (its hash names the page). */
export function jumpTo(e: { preventDefault(): void }, id: string): void {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** The label of a server identifier (technique, order, topology…), or the identifier itself when the UI has none. */
export const labelOf = (labels: Record<string, string>, id: string): string => labels[id] ?? id;

/** A loosely typed value (a command argument, a schema default) as text; anything but a string, number or boolean is `fallback`. */
export const plain = (v: unknown, fallback = ""): string => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : fallback);
