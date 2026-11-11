/**
 * Names of fixture definitions, compared as the server does (src/plugins/light/venue/qxf-import.ts
 * normaliseName and findMode): keep the two in step. « Pro Spot » and « PRO-SPOT » are one model.
 */
const FOLDED: Record<string, string> = { ß: "ss", ø: "o", æ: "ae", œ: "oe", đ: "d", ł: "l" };

export const normaliseName = (s: string): string =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[ßøæœđł]/g, (c) => FOLDED[c]!).replace(/[^a-z0-9]/g, "");

const normaliseMode = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/channels?$/, "ch").replace(/ch$/, "");

/** The channel count of a fixture's mode in the library, matched the way the server resolves it; undefined when its definition or mode is not there. */
export function footprintOf<D extends { manufacturer: string; model: string; modes: { name: string; channels: number }[] }>(library: readonly D[], f: { manufacturer: string; model: string; mode: string }): number | undefined {
  const def = library.find((d) => normaliseName(d.manufacturer) === normaliseName(f.manufacturer) && normaliseName(d.model) === normaliseName(f.model));
  return (def?.modes.find((m) => m.name === f.mode) ?? def?.modes.find((m) => normaliseMode(m.name) === normaliseMode(f.mode)))?.channels;
}
