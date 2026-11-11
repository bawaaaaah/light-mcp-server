/**
 * The named functions a channel fader can be narrowed to (docs/specs/groups-masters.md, « Fader de
 * canaux » — T12): a channel cut into functions (a gobo wheel, a colour preset, a macro, a strobe
 * with its speeds) lists them by name; picking one sets the fader's range to it, so the fader's
 * whole travel stays inside that function — the value still moves there, often a speed. A fader has
 * one range for all its channels: the channels it does not fit are named (`unfitted`).
 */
import { searchBy } from "./search-text.js";

export interface ChannelFunctions {
  offset: number;
  name: string;
  ranges?: { min: number; max: number; name: string }[];
}

export interface FixtureFunctions {
  id: string;
  name: string;
  /** Manufacturer and model: two models may cut a channel of the same name differently. */
  model?: string;
  channels: readonly ChannelFunctions[];
}

/** One function to offer: what the list shows, the range it sets, and a key that stays the same when the label gains a prefix (a second model or channel ticked). */
export interface FaderFunction {
  label: string;
  min: number;
  max: number;
  key: string;
}

const channelOf = (fixtures: readonly FixtureFunctions[], p: { fixture: string; offset: number }) => {
  const fixture = fixtures.find((f) => f.id === p.fixture);
  const channel = fixture?.channels.find((c) => c.offset === p.offset);
  return fixture && channel ? { fixture, channel } : undefined;
};

/**
 * The functions of the channels a fader drives, deduplicated (the same channel on several fixtures
 * of one model offers its functions once). Among the channels that have functions, a label names
 * the channel when there are several channel names, and the model when there are several models;
 * the DMX values close every label (two functions of one name stay apart, and the list says how far
 * the fader will travel). An unnamed function shows its values alone.
 */
export function faderFunctions(fixtures: readonly FixtureFunctions[], picked: readonly { fixture: string; offset: number }[]): FaderFunction[] {
  const withRanges = picked.map((p) => channelOf(fixtures, p)).filter((x): x is NonNullable<typeof x> => x !== undefined && (x.channel.ranges?.length ?? 0) > 0);
  const severalChannels = new Set(withRanges.map((x) => x.channel.name)).size > 1;
  const severalModels = new Set(withRanges.map((x) => x.fixture.model ?? x.fixture.id)).size > 1;
  const seen = new Set<string>();
  const out: FaderFunction[] = [];
  for (const { fixture, channel } of withRanges) {
    for (const r of channel.ranges ?? []) {
      const values = `${r.min}–${r.max}`;
      const name = r.name.trim();
      const prefix = [severalModels ? (fixture.model ?? fixture.name) : "", severalChannels ? channel.name : ""].filter(Boolean).join(" · ");
      const label = `${prefix ? `${prefix} · ` : ""}${name ? `${name} (${values})` : values}`;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push({ label, min: r.min, max: r.max, key: [fixture.model ?? fixture.id, channel.name, name, r.min, r.max].join("|") });
    }
  }
  return out;
}

/** The functions whose range the fader covers exactly (several when two functions share a range). */
export const functionsOf = (list: readonly FaderFunction[], range: { min: number; max: number }): FaderFunction[] => list.filter((f) => f.min === range.min && f.max === range.max);

/** The functions a search keeps: the labels holding the whole phrase typed if any do (« gobo 3 » is not « Gobo 1 (16–31) »), else those holding every word of it. */
export function searchFunctions(list: readonly FaderFunction[], query: string): FaderFunction[] {
  return searchBy(list, query, (f) => [f.label]);
}

/**
 * The ticked channels a narrowed range does not fit (« fixture · channel »): one without functions,
 * or whose functions have none on exactly that range — the fader's single range still applies to
 * them. Nothing for the whole travel.
 */
export function unfitted(fixtures: readonly FixtureFunctions[], picked: readonly { fixture: string; offset: number }[], range: { min: number; max: number }): string[] {
  if (range.min <= 0 && range.max >= 255) return [];
  return picked
    .map((p) => channelOf(fixtures, p))
    .filter((x): x is NonNullable<typeof x> => x !== undefined && !(x.channel.ranges ?? []).some((r) => r.min === range.min && r.max === range.max))
    .map(({ fixture, channel }) => `${fixture.name} · ${channel.name}`);
}

/** A named range of a channel cut into functions (venue.fixture.channels `ranges`). */
export interface NamedRange {
  min: number;
  max: number;
  name: string;
}

/** The DMX value a fader sends at a level, over its range (the whole travel by default), as the server composes it. */
export const dmxOf = (level: number, range?: { min: number; max: number }): number => {
  const { min, max } = range ?? { min: 0, max: 255 };
  return Math.round(min + level * (max - min));
};

/** The range a DMX value falls in, if any. */
export const rangeAt = (ranges: readonly NamedRange[], value: number): NamedRange | undefined => ranges.find((r) => value >= r.min && value <= r.max);

/**
 * The range a value is in and its neighbours (T6, « plages voisines »): `n` above (the higher values, the
 * nearest last, so the list reads top to bottom as the fader's travel) and `n` below (the nearest first).
 * Between two ranges, no current one: the neighbours are those around the value.
 */
export function rangeNeighbours(ranges: readonly NamedRange[], value: number, n = 2): { above: NamedRange[]; current?: NamedRange; below: NamedRange[] } {
  const sorted = [...ranges].sort((a, b) => a.min - b.min);
  const current = rangeAt(sorted, value);
  const higher = sorted.filter((r) => r.min > value);
  const lower = sorted.filter((r) => r.max < value);
  return { above: higher.slice(0, n).reverse(), ...(current ? { current } : {}), below: lower.slice(-n).reverse() };
}

/**
 * The ranges a channel fader can show beside its track: those of its one channel, or of all its channels when
 * they are cut exactly alike (same min, max and name); none otherwise, or when a channel has none.
 */
export function sharedRanges(fixtures: readonly FixtureFunctions[], picked: readonly { fixture: string; offset: number }[]): NamedRange[] | undefined {
  const lists = picked.map((p) => channelOf(fixtures, p)?.channel.ranges);
  if (!lists.length || lists.some((l) => !l?.length)) return undefined;
  const key = (l: readonly NamedRange[]) => JSON.stringify(l.map(({ min, max, name }) => [min, max, name]));
  const first = key(lists[0]!);
  return lists.every((l) => key(l!) === first) ? lists[0]! : undefined;
}
