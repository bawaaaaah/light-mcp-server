/**
 * The named functions a channel fader can be narrowed to (docs/specs/groups-masters.md, « Fader de
 * canaux » — T12): a channel cut into functions (a gobo wheel, a colour preset, a macro, a strobe
 * with its speeds) lists them by name; picking one sets the fader's range to it, so the fader's
 * whole travel stays inside that function — the value still moves there, often a speed.
 */

export interface ChannelFunctions {
  offset: number;
  name: string;
  ranges?: { min: number; max: number; name: string }[];
}

/** One function to offer: what the list shows, and the range it sets. */
export interface FaderFunction {
  label: string;
  min: number;
  max: number;
}

/**
 * The functions of the channels a fader drives, deduplicated (the same channel on several fixtures
 * of one model offers its functions once). With several channel names among them, each label says
 * which channel it belongs to. The DMX values close every label: two functions of the same name
 * (on two models) stay apart, and the list says how far the fader will travel.
 */
export function faderFunctions(fixtures: readonly { id: string; channels: readonly ChannelFunctions[] }[], picked: readonly { fixture: string; offset: number }[]): FaderFunction[] {
  const channels = picked.map((p) => fixtures.find((f) => f.id === p.fixture)?.channels.find((c) => c.offset === p.offset)).filter((c): c is ChannelFunctions => c !== undefined);
  const several = new Set(channels.map((c) => c.name)).size > 1;
  const seen = new Set<string>();
  const out: FaderFunction[] = [];
  for (const c of channels) {
    for (const r of c.ranges ?? []) {
      const label = `${several ? `${c.name} · ` : ""}${r.name} (${r.min}–${r.max})`;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push({ label, min: r.min, max: r.max });
    }
  }
  return out;
}

/** The function whose range the fader covers exactly, if any: the field shows it by name. */
export const functionOf = (list: readonly FaderFunction[], range: { min: number; max: number }): FaderFunction | undefined => list.find((f) => f.min === range.min && f.max === range.max);
