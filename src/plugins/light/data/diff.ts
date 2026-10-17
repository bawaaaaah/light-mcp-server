/**
 * What changes between two versions of an object, field by field (show.diff): dotted paths, array
 * items as [n], with the value before and after. A list whose length changes is one change. Pure,
 * for JSON values.
 */
export interface Change {
  path: string;
  before?: unknown;
  after?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The changes from `before` to `after`, at most `max` (the rest is left out). */
export function diff(before: unknown, after: unknown, max = 200): Change[] {
  const out: Change[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (out.length >= max) return;
    if (isObject(a) && isObject(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) walk(a[key], b[key], path ? `${path}.${key}` : key);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      a.forEach((x, i) => walk(x, b[i], `${path}[${i}]`));
      return;
    }
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    out.push({ path: path || "(objet)", ...(a !== undefined ? { before: a } : {}), ...(b !== undefined ? { after: b } : {}) });
  };
  walk(before, after, "");
  return out;
}
