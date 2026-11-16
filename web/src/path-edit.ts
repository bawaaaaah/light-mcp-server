/** Pure helpers of the look editor's path (T28, `components/PathEditor.tsx`): tested without a browser. */

/** A stop moved from `from` to `to`, the others in their order. Pure. */
export function moveStop<T>(stops: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= stops.length || to >= stops.length) return [...stops];
  const out = [...stops];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

/** A number typed in a field (a decimal comma accepted), or undefined when it is not one. Pure. */
export function typedNumber(text: string): number | undefined {
  const t = text.trim().replace(",", ".");
  if (t === "" || t === "-" || t === ".") return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}
