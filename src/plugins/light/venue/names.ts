/**
 * Manufacturer and model names as the library compares them, and QLC+'s built-in generic dimmer by its names. Pure and
 * without dependencies: the server (qxf-import.ts, the .qxf export) and the interface (web/) share these rules.
 */

/** Letters NFD does not decompose, folded to their usual Latin spelling (« Straße » = « Strasse »). */
const FOLDED: Record<string, string> = { ß: "ss", ø: "o", æ: "ae", œ: "oe", đ: "d", ł: "l", ı: "i", þ: "th", ð: "d" };

/** A text's letters in plain Latin where they have a usual spelling: accents dropped, « ß » as « ss » (case kept). */
export const foldLatin = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[ßøæœđłıþðØÆŒĐŁÞÐ]/g, (c) => {
      const lower = FOLDED[c.toLowerCase()]!;
      return c === c.toLowerCase() ? lower : lower[0]!.toUpperCase() + lower.slice(1);
    });

/**
 * A manufacturer's or a model's name as definitions are looked up: accents folded (« Éclairage » is
 * « eclairage »), case, spaces and punctuation dropped (« Spot 900 » is « Spot900 »). Empty when the
 * name holds no letter or digit of the Latin alphabet.
 */
export const normaliseName = (s: string): string =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[ßøæœđłıþð]/g, (c) => FOLDED[c]!).replace(/[^a-z0-9]/g, "");

export const sameName = (a: string, b: string): boolean => normaliseName(a) === normaliseName(b);

/** QLC+'s built-in generic dimmer: manufacturer and model « Generic », no .qxf file (QLC+ creates it in its code). */
export const GENERIC_DIMMER_NAMES = { manufacturer: "Generic", model: "Generic" } as const;

/** Whether a model is QLC+'s built-in generic dimmer, compared as the library compares names. */
export const isGenericDimmer = (manufacturer: string, model: string): boolean => sameName(manufacturer, GENERIC_DIMMER_NAMES.manufacturer) && sameName(model, GENERIC_DIMMER_NAMES.model);
