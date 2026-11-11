/**
 * A fixture's colour heads (docs/specs/venue-fixtures-stage.md, « Têtes et zones »), pure: the heads its
 * definition declares (<Head>), or, when it declares none but repeats a colour component (« Red 1 / Green 1 …
 * Red 2 … », a halo « Halo Red »), the heads deduced from its channel names; and among them the **accent**
 * heads (a halo, an unnumbered ring, a backlight): they follow the look but are no full visible colour.
 *
 * The deduction runs when a fixture is resolved, never at import: `FixtureMode.heads` stays what the
 * .qxf says, so the QLC+ workspace import, the library and the duplicate check read the file as it is.
 * It is cautious: a definition that repeats no colour component, or whose parts do not look like zones
 * of one fixture (more parts than repetitions, a lone colour beside parts that are not alike), stays one colour (-1).
 * A colour channel that is no plain intensity (a laser, a channel cut into functions) is no colour here at all.
 */
import type { ColorComponent, FixtureChannel, FixtureDefinition, FixtureMode } from "./qxf-import.js";
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
  /**
   * Whether the heads hold a colour channel as the definition reads it, a plain intensity or not (a laser, a colour
   * channel cut into functions): such a fixture mixes its colour, a painted colour never drives its wheel.
   */
  mixes: boolean;
}

/**
 * Words naming an accent part (whole words, matched on the words left once the colour words are out: no accents, no
 * punctuation). Not « back » nor « rear »: a double-sided « Front RGB / Back RGB » has two full faces.
 */
const ACCENT = /\b(halo|aura|backlight|back light|anneau|couronne|contre jour)\b/;
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
/** A range of a colour channel that runs a function rather than sets a level (« Strobe slow-fast », « Sound active », « Fade in »). */
const FUNCTION = /strob|sound|music|\bauto\b|program|macro|chase|spin|scan|jump|random|pulse|flash|fade (in|out)|alternat/;

const plain = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/**
 * A colour channel's part: the words left once the colour words are taken out, and the number left among them
 * (« Red 2 » → "", 2; « Rouge 2 » → "", 2; « LED 1 Red » → "", 1; « Spot 1 Red » → "spot", 1; « Halo Red » → "halo";
 * « Spots 2+3 Red » → "spots", 2: the first number; « Red (8bit) » → "", no number: a resolution is not one).
 */
export function partOf(channelName: string): { words: string; number?: number } {
  const rest = plain(channelName)
    // a resolution is no part number: « Flower Effect 1 (8bit) », « Dimmer 16 bit », « Pan 16-bit »
    .replace(/\d+\s*-?bit\b/g, " ")
    .replace(/(\d+)/g, " $1 ")
    .replace(COLOUR_WORDS, " ");
  // the first number names the part: « Spots 2+3 » is part 2, after « Spots 1+4 »
  const first = /\d+/.exec(rest)?.[0];
  const words = rest.replace(/\d+/g, " ").replace(/[^a-z]+/g, " ").trim();
  return { words, ...(first ? { number: Number(first) } : {}) };
}

/**
 * A channel's colour component when it is a plain intensity of that colour; undefined for a laser (« Red Laser »:
 * Blackout / On / Strobe slow-fast) or a colour channel cut into functions (a strobe, a sound mode, a fade program):
 * at full, such a channel would run its function. It is then no zone and no colour writes it, a whole-fixture one included.
 *
 * The same idea as `isLevel` (qxf-import.ts), which demotes an Intensity channel cut into functions to an effect, but
 * not the same rule: `isLevel` wants every range to be a level, and would reject a colour channel whose ranges are
 * named otherwise (« Red 0-100 » beside « Full red »); here only a range that starts a function disqualifies.
 */
export function plainColour(ch: FixtureChannel | undefined): ColorComponent | undefined {
  if (!ch?.color || /\blaser/.test(plain(ch.name))) return undefined;
  return ch.capabilities.length > 1 && ch.capabilities.some((c) => FUNCTION.test(plain(c.name))) ? undefined : ch.color;
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

/** A colour channel's component for the deduction: its colour, or « white-warm », « white-cool »… for a white told apart by its temperature. */
type Component = ColorComponent | `white-${string}`;

/** A group of colour channels that may be one zone. */
interface Part {
  number?: number;
  /** The words left once the colours and the numbers are out ("" for « Red », « Red 2 »). */
  words: string;
  offsets: number[];
  /** Its components, sorted and joined: parts alike have the same. */
  comps: string;
}

/** Colour channels grouped by `key`; undefined when a group would repeat a component (the key does not tell zones apart). */
function groupBy(offsets: readonly number[], key: (offset: number) => string, partAt: (offset: number) => { words: string; number?: number }, colourAt: (offset: number) => Component): Part[] | undefined {
  const parts = new Map<string, Omit<Part, "comps"> & { comps: Set<Component> }>();
  for (const off of offsets) {
    const k = key(off);
    const { words, number } = partAt(off);
    const part = parts.get(k) ?? { ...(number !== undefined ? { number } : {}), words, offsets: [], comps: new Set<Component>() };
    const c = colourAt(off);
    if (part.comps.has(c)) return undefined;
    part.comps.add(c);
    part.offsets.push(off);
    parts.set(k, part);
  }
  return [...parts.values()].map((p) => ({ ...p, comps: [...p.comps].sort().join("+") }));
}

/** Head order, fixed whatever the accent: numbered parts first by number, then the others as patched (by offset). Transitive. */
const byPlace = (a: Part, b: Part): number => (a.number === undefined ? 1 : 0) - (b.number === undefined ? 1 : 0) || (a.number ?? 0) - (b.number ?? 0) || a.offsets[0]! - b.offsets[0]!;

/**
 * The first zone when the fixture numbers only the others (« Red / Red 2 / Red 3 »): an unnumbered part with no word
 * left takes number 1, or 0 when a part is already numbered 1 (« Red / Red 1 / Red 2 »). The other unnumbered parts
 * (a halo) stay after the numbered ones, as patched.
 */
function numberFirst(parts: Part[]): Part[] {
  if (!parts.some((p) => p.number !== undefined)) return parts;
  const first = parts.find((p) => p.number === undefined && p.words === "");
  if (!first) return parts;
  const number = parts.some((p) => p.number === 1) ? 0 : 1;
  return parts.map((p) => (p === first ? { ...p, number } : p));
}

/** How many times the most repeated component comes among these channels. */
function mostRepeated(offsets: readonly number[], colourAt: (offset: number) => Component): number {
  const counts = new Map<Component, number>();
  for (const off of offsets) counts.set(colourAt(off), (counts.get(colourAt(off)) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

/**
 * A lone unnumbered channel whose words only add to an unnumbered part's, with a component that part lacks, belongs to
 * it: « Background - White (8bit) - all pixels » beside « Background - Red / Green / Blue (8bit) ».
 */
function joinQualified(parts: Part[], colourAt: (offset: number) => Component): Part[] {
  const out = parts.map((p) => ({ ...p, offsets: [...p.offsets] }));
  for (const p of [...out]) {
    if (p.offsets.length !== 1 || p.number !== undefined) continue;
    const c = colourAt(p.offsets[0]!);
    // the part sharing the most words wins (« spot » and « spot inner » both prefix « spot inner white »)
    const into = out
      .filter((q) => q !== p && q.number === undefined && q.words !== "" && p.words.startsWith(`${q.words} `) && !q.comps.split("+").includes(c))
      .sort((a, b) => b.words.length - a.words.length)[0];
    if (!into) continue;
    into.offsets.push(...p.offsets);
    into.offsets.sort((x, y) => x - y);
    into.comps = [...into.comps.split("+"), c].sort().join("+");
    out.splice(out.indexOf(p), 1);
  }
  return out;
}

/** The accent correction that applies to this mode: [] always (no accent); a list only when one of its names is in the mode. */
function accentFor(mode: FixtureMode, overrides: HeadOverrides | undefined): readonly string[] | undefined {
  const accent = overrides?.accent;
  if (!accent) return undefined;
  return accent.length === 0 || accent.some((n) => mode.channels.includes(n)) ? accent : undefined;
}

/** The heads a mode has before any accent: declared, deduced from the names, or one for the whole fixture. */
function partsOf(def: FixtureDefinition, mode: FixtureMode): { parts: { offsets: number[] }[]; deduced: boolean } {
  if (mode.heads.length) return { parts: mode.heads.map((offsets) => ({ offsets: [...offsets] })), deduced: false };
  // each channel's plain colour, read once
  const colours = mode.channels.map((name) => {
    const ch = def.channels.get(name);
    return { colour: plainColour(ch), fine: ch?.fine ?? false };
  });
  const coarse = mode.channels.flatMap((name, off) => (colours[off]!.colour && !colours[off]!.fine && !TUNING.test(plain(name)) ? [off] : []));
  // a white told apart by its temperature is its own component here: « Warm White / Cool White » are one zone
  const colourAt = (off: number): Component => {
    const c = colours[off]!.colour!;
    const t = c === "white" ? TEMPERATURE.exec(plain(mode.channels[off]!)) : null;
    return t ? `white-${t[0]}` : c;
  };
  const whole = { parts: [], deduced: false };
  // a fixture that repeats no colour component has one zone: « RGBWA | U.V. », « CMY | CTO », « RGB | Emulated White »
  if (mostRepeated(coarse, colourAt) < 2) return whole;
  // by the number left once the colour words are out (any language: « Rouge 1 », « LED 1 Red »); by the words too
  // when the number alone would put one component twice in a part (« Spot 1 Red / Derby 1 Red »)
  const names = new Map(coarse.map((off) => [off, partOf(mode.channels[off]!)]));
  const partAt = (off: number) => names.get(off)!;
  const found =
    groupBy(coarse, (off) => (partAt(off).number !== undefined ? `#${partAt(off).number}` : partAt(off).words), partAt, colourAt) ??
    groupBy(coarse, (off) => `${partAt(off).words}#${partAt(off).number ?? ""}`, partAt, colourAt);
  if (!found) return whole;
  const joined = joinQualified(found, colourAt);
  // parts alike (the same components, twice at least) are zones: a lone colour beside them (a « UV Dimmer » beside
  // 4 RGBW spots) is left out of any head rather than making the whole fixture one colour
  const alike = (p: Part) => joined.some((q) => q !== p && q.comps === p.comps);
  const parts = joined.some(alike) ? joined.filter((p) => p.offsets.length > 1 || alike(p)) : joined;
  if (parts.length <= 1) return whole;
  // zones of one fixture: no more parts than the most repeated component among them (« Red (Pixel 1) | Green (Pixel 2) … »
  // are single LEDs, not zones), and no lone colour beside full zones that are not alike (« Red / Fade Speed | Green / Blue »)
  if (parts.length > mostRepeated(parts.flatMap((p) => p.offsets), colourAt)) return whole;
  const sizes = parts.map((p) => p.offsets.length);
  if (Math.min(...sizes) === 1 && Math.max(...sizes) > 1) return whole;
  return { parts: numberFirst(parts).sort(byPlace), deduced: true };
}

/** A mode's heads, declared or deduced, and its accent heads, with the per-model or per-fixture correction. */
export function headsOf(def: FixtureDefinition, mode: FixtureMode, overrides?: HeadOverrides): FixtureHeads {
  const colourAt = (off: number) => plainColour(def.channels.get(mode.channels[off] ?? ""));
  const names = (offsets: readonly number[]) => offsets.filter((o) => colourAt(o)).map((o) => mode.channels[o]!);
  const { parts, deduced } = partsOf(def, mode);
  // read on the definition's own colour channels, not on the plain ones: a fixture whose only colour channels are a
  // laser or cut into functions has empty heads, and is still no lamp (its wheel is left to raw channels)
  const headOffsets = parts.length ? parts.flatMap((p) => p.offsets) : mode.channels.map((_, off) => off);
  const mixes = headOffsets.some((off) => def.channels.get(mode.channels[off] ?? "")?.color !== undefined);
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
    // an accent needs a full head beside it: all named so, they are all full heads (venue.fixture.heads.set refuses a list that marks them all)
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
      const c = plainColour(ch);
      if (c && !ch!.fine && !reached.has(off) && inHeads.has(c) && !TEMPERATURE.test(plain(name)) && !TUNING.test(plain(name))) escaped.push(off);
    });
  }
  return { heads, accent, deduced, escaped, mixes };
}

/**
 * Why a list of accent channels cannot be kept for a model (all empty when it can): names that are no colour channel
 * of any of its modes; in every mode that has one of them, heads it covers only in part (an accent is whole heads);
 * and the modes where it would cover every head (an accent needs a full head beside it).
 */
export function accentProblems(def: FixtureDefinition, accent: readonly string[]): { unknown: string[]; partial: { mode: string; head: string[] }[]; every: string[] } {
  const unknown = accent.filter((n) => !plainColour(def.channels.get(n)) || !def.modes.some((m) => m.channels.includes(n)));
  const partial: { mode: string; head: string[] }[] = [];
  const every: string[] = [];
  for (const mode of def.modes) {
    if (!accent.some((n) => mode.channels.includes(n))) continue;
    const { heads } = headsOf(def, mode, { accent: [] });
    let covered = 0;
    for (const comps of heads.values()) {
      const head = Object.values(comps).map((o) => mode.channels[o]!);
      const inside = head.filter((n) => accent.includes(n)).length;
      if (inside > 0 && inside < head.length) partial.push({ mode: mode.name, head });
      if (inside > 0 && inside === head.length) covered++;
    }
    if (!heads.has(-1) && covered === heads.size) every.push(mode.name);
  }
  return { unknown, partial, every };
}
