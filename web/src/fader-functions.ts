/**
 * The named functions a channel fader can be narrowed to (docs/specs/groups-masters.md, « Fader de
 * canaux » — T12): a channel cut into functions (a gobo wheel, a colour preset, a macro, a strobe
 * with its speeds) lists them by name; picking one sets the fader's range to it, so the fader's
 * whole travel stays inside that function — the value still moves there, often a speed. A fader has
 * one range for all its channels: the channels it does not fit are named (`unfitted`).
 */

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

/** One function to offer: what the list shows, and the range it sets. */
export interface FaderFunction {
  label: string;
  min: number;
  max: number;
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
      out.push({ label, min: r.min, max: r.max });
    }
  }
  return out;
}

/** The functions whose range the fader covers exactly (several when two functions share a range). */
export const functionsOf = (list: readonly FaderFunction[], range: { min: number; max: number }): FaderFunction[] => list.filter((f) => f.min === range.min && f.max === range.max);

/** Text compared without case, accents or dash kind: « gobo », « Gobo », « red (16-31) » find what they mean. */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2010-\u2015]/g, "-")
    .toLowerCase();

/** The functions a search keeps: the labels holding the whole phrase typed if any do (« gobo 3 » is not « Gobo 1 (16–31) »), else those holding every word of it. */
export function searchFunctions(list: readonly FaderFunction[], query: string): FaderFunction[] {
  const phrase = fold(query).trim().replace(/\s+/g, " ");
  if (!phrase) return [...list];
  const whole = list.filter((f) => fold(f.label).includes(phrase));
  if (whole.length) return whole;
  const words = phrase.split(" ");
  return list.filter((f) => words.every((w) => fold(f.label).includes(w)));
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
