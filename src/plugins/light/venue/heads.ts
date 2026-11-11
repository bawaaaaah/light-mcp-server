/**
 * A fixture's colour heads (docs/specs/venue-fixtures-stage.md, « Têtes et zones »), pure: the heads its
 * definition declares (<Head>), or, when it declares none but repeats its colour components (« Red 1 /
 * Green 1 … Red 2 … », a halo « Halo Red »), the heads deduced from its channel names; and among them the
 * **accent** heads (a halo, a ring, a back light): they follow the look but are no full visible colour.
 *
 * The deduction runs when a fixture is resolved, never at import: `FixtureMode.heads` stays what the
 * .qxf says, so the QLC+ workspace import, the library and the duplicate check read the file as it is.
 */
import type { ColorComponent, FixtureDefinition, FixtureMode } from "./qxf-import.js";
import type { HeadOverrides } from "./overrides.js";

export type HeadComponents = Partial<Record<ColorComponent, number>>;

export interface FixtureHeads {
  /** Head index → component → channel offset. Index -1 alone: one colour for the whole fixture. */
  heads: Map<number, HeadComponents>;
  /** The accent heads (indexes of `heads`), always after the full ones when deduced. */
  accent: Set<number>;
  /** Whether the heads were deduced from channel names (the definition declares none). */
  deduced: boolean;
  /** Colour channels (offsets, coarse) that reach no head although their component is in one: the definition repeats it out of any head. */
  escaped: number[];
}

/** Words naming an accent part of a fixture (lowercase, whole words). */
const ACCENT = /\b(halo|ring|aura|back|backlight|rear)\b/i;
/** Words naming a colour component or a colour channel, dropped to keep what tells the parts apart. */
const COLOUR_WORDS = /\b(red|green|blue|white|amber|uv|ultra ?violet|cyan|magenta|yellow|lime|warm|cold|cool|ww|cw|r|g|b|w|a|c|m|y|colou?r|intensity|led|dimmer)\b/g;

/** A colour channel's part: the words left once the colour is taken out, and its number (« Red 2 » → "", 2; « Halo Red » → "halo"). */
export function partOf(channelName: string): { words: string; number?: number } {
  const name = channelName.toLowerCase();
  const trailing = /^(.*?)[\s_#-]*(\d+)$/.exec(name);
  const zone = trailing ? undefined : /\b(?:zone|segment|section|part|pixel|cell|head|ring|halo)\s*(\d+)\b/.exec(name);
  const number = trailing ? Number(trailing[2]) : zone ? Number(zone[1]) : undefined;
  const rest = trailing ? trailing[1]! : name;
  const words = rest.replace(COLOUR_WORDS, " ").replace(/\d+/g, " ").replace(/[^a-z]+/g, " ").trim();
  return { words, ...(number !== undefined ? { number } : {}) };
}

/** Whether a set of channels is an accent part: named so, or listed by the override (`accent`, channel names; [] none). */
const isAccent = (names: readonly string[], overrides: HeadOverrides | undefined): boolean =>
  overrides?.accent ? names.length > 0 && names.every((n) => overrides.accent!.includes(n)) : names.length > 0 && names.every((n) => ACCENT.test(partOf(n).words));

/** The first channel of each component, in offset order. */
function componentsOf(offsets: readonly number[], colourAt: (offset: number) => ColorComponent | undefined): HeadComponents {
  const comps: HeadComponents = {};
  for (const off of offsets) {
    const c = colourAt(off);
    if (c && comps[c] === undefined) comps[c] = off;
  }
  return comps;
}

/** A mode's heads, declared or deduced, and its accent heads, with the per-model or per-fixture correction. */
export function headsOf(def: FixtureDefinition, mode: FixtureMode, overrides?: HeadOverrides): FixtureHeads {
  const colourAt = (off: number) => def.channels.get(mode.channels[off] ?? "")?.color;
  const coarse = mode.channels.flatMap((name, off) => {
    const ch = def.channels.get(name);
    return ch?.color && !ch.fine ? [off] : [];
  });
  const heads = new Map<number, HeadComponents>();
  const accent = new Set<number>();
  let deduced = false;
  if (mode.heads.length) {
    mode.heads.forEach((offsets, h) => {
      heads.set(h, componentsOf(offsets, colourAt));
      const names = offsets.filter((o) => colourAt(o)).map((o) => mode.channels[o]!);
      if (isAccent(names, overrides)) accent.add(h);
    });
    // an accent needs a full head beside it
    if (accent.size === heads.size) accent.clear();
  } else {
    // colour channels gathered by part: what their name says once the colour is taken out, and its number
    const parts = new Map<string, { number?: number; offsets: number[] }>();
    for (const off of coarse) {
      const p = partOf(mode.channels[off]!);
      const key = `${p.words}#${p.number ?? ""}`;
      const part = parts.get(key) ?? { ...(p.number !== undefined ? { number: p.number } : {}), offsets: [] };
      part.offsets.push(off);
      parts.set(key, part);
    }
    const list = [...parts.values()].map((p) => ({ ...p, accent: isAccent(p.offsets.map((o) => mode.channels[o]!), overrides) }));
    const full = list.filter((p) => !p.accent);
    if (list.length <= 1 || !full.length) {
      // one colour for the whole fixture, as the definition reads (fine channels included, the first wins)
      heads.set(-1, componentsOf(mode.channels.map((_, off) => off), colourAt));
    } else {
      deduced = true;
      // the full parts first, then the accents, each in the order of their numbers (as patched when one has none)
      const order = (a: (typeof list)[number], b: (typeof list)[number]) => (a.number !== undefined && b.number !== undefined ? a.number - b.number : 0) || a.offsets[0]! - b.offsets[0]!;
      const sorted = [...full.sort(order), ...list.filter((p) => p.accent).sort(order)];
      sorted.forEach((p, h) => {
        heads.set(h, componentsOf(p.offsets, colourAt));
        if (p.accent) accent.add(h);
      });
    }
  }
  const reached = new Set([...heads.values()].flatMap((c) => Object.values(c)));
  const inHeads = new Set([...heads.values()].flatMap((c) => Object.keys(c)));
  const escaped = coarse.filter((off) => !reached.has(off) && inHeads.has(colourAt(off)!));
  return { heads, accent, deduced, escaped };
}
