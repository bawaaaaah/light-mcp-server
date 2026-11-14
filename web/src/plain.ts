/** A loosely typed value (a command argument, a schema default) as text; anything but a string, number or boolean is `fallback`. */
export const plain = (v: unknown, fallback = ""): string => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : fallback);
