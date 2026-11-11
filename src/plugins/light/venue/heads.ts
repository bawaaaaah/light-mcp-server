/**
 * A fixture's colour heads (docs/specs/venue-fixtures-stage.md, « Têtes et zones »), pure: the heads its
 * definition declares (<Head>), or, when it declares none but repeats a colour component (« Red 1 / Green 1 …
 * Red 2 … », a halo « Halo Red »), the heads deduced from its channel names; and among them the **accent**
 * heads (a halo, an unnumbered ring, a backlight): they follow the look but are no full visible colour.
 *
 * The deduction runs when a fixture is resolved, never at import: `FixtureMode.heads` stays what the
 * .qxf says, so the QLC+ workspace import, the library and the duplicate check read the file as it is.
 * It is cautious: a definition that repeats no colour component, or whose parts do not look like zones
 * of one fixture (more parts than repetitions, a lone colour beside full zones), stays one colour (-1).
 */
import type { ColorComponent, FixtureDefinition, FixtureMode } from "./qxf-import.js";
import type { HeadOverrides } from "./overrides.js";

export type HeadComponents = Partial<Record<ColorComponent, number>>;

export interface FixtureHeads {
  /** Head index → component → channel offset. Index -1 alone: one colour for the whole fixture. */
  heads: Map<number, HeadComponents>;
  /** The accent heads (indexes of `heads`): a flag only, it never moves a head's number. */
  accent: Set<number>;
  /** Whether the heads were deduced from channel names (the definition declares none). */
  deduced: boolean;
  /** Colour channels (offsets, coarse) that reach no head although their component is in one: the definition repeats it out of any head. */
  escaped: number[];
}

/** Words naming an accent part (whole words). Not « back » nor « rear »: a double-sided « Front RGB / Back RGB » has two full faces. */
const ACCENT = /\b(halo|aura|backlight)\b/;
/** A ring is an accent only deduced and unnumbered: « Ring 1, Ring 2 », or a ring the definition declares as a head, are zones. */
const RING = /\bring\b/;
/** A head the definition declares is an accent by name only when called a halo or an aura (Martin MAC Aura). */
const DECLARED_ACCENT = /\b(halo|aura)\b/;
/**
 * Words naming a colour component or a colour channel, in English and French (a few German and Spanish too), dropped
 * to keep what tells the parts apart. Matched on the name lowercased and without accents.
 */
const COLOUR_WORDS =
  /\b(red|green|blue|white|amber|uv|ultra ?violet|cyan|magenta|yellow|lime|warm|cold|cool|ww|cw|r|g|b|w|a|c|m|y|colou?r|intensity|led|leds|dimmer|rouge|vert|verte|bleu|bleue|blanc|blanche|ambre|jaune|chaud|froid|couleur|intensite|gradateur|rot|grun|blau|weiss|gelb|rojo|azul|blanco|ambar)\b/g;
/** White channels that tell a colour temperature apart (« Warm White / Cool White »): two whites of one zone, not two zones. */
const TEMPERATURE = /(warm|cold|cool)|\b(ww|cw|chaud|froid)\b/;
/** Colour channels that tune the colour rather than light a zone (« Color balancing red », « Red Tone »): never a zone. */
const TUNING = /(balanc|saturation|\btone\b|temperature|macro|preset|select|speed|program|correction)/;

const plain = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/**
 * A colour channel's part: the words left once the colour words are taken out, and the number left among them
 * (« Red 2 » → "", 2; « Rouge 2 » → "", 2; « LED 1 Red » → "", 1; « Spot 1 Red » → "spot", 1; « Halo Red » → "halo").
 */
export function partOf(channelName: string): { words: string; number?: number } {
  const rest = plain(channelName)
    .replace(/(\d+)/g, " $1 ")
    .replace(COLOUR_WORDS, " ");
  const numbers = rest.match(/\d+/g);
  const words = rest.replace(/\d+/g, " ").replace(/[^a-z]+/g, " ").trim();
  return { words, ...(numbers ? { number: Number(numbers[numbers.length - 1]) } : {}) };
}

/** The first channel of each component, in offset order. */
function componentsOf(offsets: readonly number[], colourAt: (offset: number) => ColorComponent | undefined): HeadComponents {
  const comps: HeadComponents = {};
  for (const off of offsets) {
    const c = colourAt(off);
    if (c && comps[c] === undefined) comps[c] = off;
  }
  return comps;
}

/** A group of colour channels that may be one zone. */
interface Part {
  number?: number;
  offsets: number[];
}

/** Colour channels grouped by `key`; undefined when a group would repeat a component (the key does not tell zones apart). */
function groupBy(offsets: readonly number[], key: (offset: number) => { key: string; number?: number }, colourAt: (offset: number) => ColorComponent | undefined): Part[] | undefined {
  const parts = new Map<string, Part & { comps: Set<ColorComponent> }>();
  for (const off of offsets) {
    const k = key(off);
    const part = parts.get(k.key) ?? { ...(k.number !== undefined ? { number: k.number } : {}), offsets: [], comps: new Set<ColorComponent>() };
    const c = colourAt(off)!;
    if (part.comps.has(c)) return undefined;
    part.comps.add(c);
    part.offsets.push(off);
    parts.set(k.key, part);
  }
  return [...parts.values()].map(({ comps: _c, ...p }) => p);
}

/** Head order, fixed whatever the accent: numbered parts first by number, then the others as patched (by offset). Transitive. */
const byPlace = (a: Part, b: Part): number => (a.number === undefined ? 1 : 0) - (b.number === undefined ? 1 : 0) || (a.number ?? 0) - (b.number ?? 0) || a.offsets[0]! - b.offsets[0]!;

/** The accent correction that applies to this mode: [] always (no accent); a list only when one of its names is in the mode. */
function accentFor(mode: FixtureMode, overrides: HeadOverrides | undefined): readonly string[] | undefined {
  const accent = overrides?.accent;
  if (!accent) return undefined;
  return accent.length === 0 || accent.some((n) => mode.channels.includes(n)) ? accent : undefined;
}

/** The heads a mode has before any accent: declared, deduced from the names, or one for the whole fixture. */
function partsOf(def: FixtureDefinition, mode: FixtureMode): { parts: Part[]; deduced: boolean } {
  if (mode.heads.length) return { parts: mode.heads.map((offsets) => ({ offsets: [...offsets] })), deduced: false };
  const coarse = mode.channels.flatMap((name, off) => {
    const ch = def.channels.get(name);
    return ch?.color && !ch.fine && !TUNING.test(plain(name)) ? [off] : [];
  });
  // a white told apart by its temperature is its own component here: « Warm White / Cool White » are one zone
  const colourAt = (off: number) => {
    const c = def.channels.get(mode.channels[off] ?? "")?.color;
    const t = c === "white" ? TEMPERATURE.exec(plain(mode.channels[off]!)) : null;
    return (t ? `white-${t[0]}` : c) as ColorComponent | undefined;
  };
  const whole = { parts: [], deduced: false };
  // a fixture that repeats no colour component has one zone: « RGBWA | U.V. », « CMY | CTO », « RGB | Emulated White »
  const counts = new Map<ColorComponent, number>();
  for (const off of coarse) counts.set(colourAt(off)!, (counts.get(colourAt(off)!) ?? 0) + 1);
  const repeat = Math.max(0, ...counts.values());
  if (repeat < 2) return whole;
  // by the number left once the colour words are out (any language: « Rouge 1 », « LED 1 Red »); by the words too
  // when the number alone would put one component twice in a part (« Spot 1 Red / Derby 1 Red »)
  const part = (off: number) => partOf(mode.channels[off]!);
  const parts =
    groupBy(coarse, (off) => ({ key: part(off).number !== undefined ? `#${part(off).number}` : part(off).words, ...(part(off).number !== undefined ? { number: part(off).number } : {}) }), colourAt) ??
    groupBy(coarse, (off) => ({ key: `${part(off).words}#${part(off).number ?? ""}`, ...(part(off).number !== undefined ? { number: part(off).number } : {}) }), colourAt);
  if (!parts || parts.length <= 1) return whole;
  // zones of one fixture: no more parts than the most repeated component (« Red (Pixel 1) | Green (Pixel 2) … » are
  // single LEDs, not zones), and no lone colour beside full zones (« Red / Fade Speed | Green / Blue »)
  if (parts.length > repeat) return whole;
  const sizes = parts.map((p) => p.offsets.length);
  if (Math.min(...sizes) === 1 && Math.max(...sizes) > 1) return whole;
  return { parts: parts.sort(byPlace), deduced: true };
}

/** A mode's heads, declared or deduced, and its accent heads, with the per-model or per-fixture correction. */
export function headsOf(def: FixtureDefinition, mode: FixtureMode, overrides?: HeadOverrides): FixtureHeads {
  const colourAt = (off: number) => def.channels.get(mode.channels[off] ?? "")?.color;
  const names = (offsets: readonly number[]) => offsets.filter((o) => colourAt(o)).map((o) => mode.channels[o]!);
  const { parts, deduced } = partsOf(def, mode);
  const heads = new Map<number, HeadComponents>();
  const accent = new Set<number>();
  if (!parts.length) {
    // one colour for the whole fixture, as the definition reads (fine channels included, the first wins)
    heads.set(-1, componentsOf(mode.channels.map((_, off) => off), colourAt));
  } else {
    const listed = accentFor(mode, overrides);
    const named = (n: string) => {
      const p = partOf(n);
      return deduced ? ACCENT.test(p.words) || (p.number === undefined && RING.test(p.words)) : DECLARED_ACCENT.test(p.words);
    };
    parts.forEach((p, h) => {
      heads.set(h, componentsOf(p.offsets, colourAt));
      const ns = names(p.offsets);
      if (ns.length && ns.every((n) => (listed ? listed.includes(n) : named(n)))) accent.add(h);
    });
    // an accent needs a full head beside it: all named so, they are all full heads
    if (accent.size === heads.size) accent.clear();
  }
  // colours the definition repeats out of any head: only when deduced or whole (a definition that declares its heads
  // keeps its master or background channels out of them on purpose), never a white told apart by its temperature
  const escaped: number[] = [];
  if (!mode.heads.length) {
    const reached = new Set([...heads.values()].flatMap((c) => Object.values(c)));
    const inHeads = new Set([...heads.values()].flatMap((c) => Object.keys(c)));
    mode.channels.forEach((name, off) => {
      const ch = def.channels.get(name);
      if (ch?.color && !ch.fine && !reached.has(off) && inHeads.has(ch.color) && !TEMPERATURE.test(plain(name)) && !TUNING.test(plain(name))) escaped.push(off);
    });
  }
  return { heads, accent, deduced, escaped };
}

/**
 * Why a list of accent channels cannot be kept for a model (empty when it can): names that are no colour channel
 * of any of its modes, and, in every mode that has one of them, heads it covers only in part (an accent is whole heads).
 */
export function accentProblems(def: FixtureDefinition, accent: readonly string[]): { unknown: string[]; partial: { mode: string; head: string[] }[] } {
  const unknown = accent.filter((n) => !def.channels.get(n)?.color || !def.modes.some((m) => m.channels.includes(n)));
  const partial: { mode: string; head: string[] }[] = [];
  for (const mode of def.modes) {
    if (!accent.some((n) => mode.channels.includes(n))) continue;
    const { heads } = headsOf(def, mode, { accent: [] });
    for (const comps of heads.values()) {
      const head = Object.values(comps).map((o) => mode.channels[o]!);
      const inside = head.filter((n) => accent.includes(n)).length;
      if (inside > 0 && inside < head.length) partial.push({ mode: mode.name, head });
    }
  }
  return { unknown, partial };
}
