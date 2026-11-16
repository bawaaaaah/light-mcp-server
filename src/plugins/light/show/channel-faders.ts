/**
 * The fader of one fixture channel (docs/specs/venue-fixtures-stage.md, « Lyres »): the one channel fader driving
 * exactly that channel over its whole travel, or the id a new one takes (`panel-<fixture>-<offset>`). Shared by
 * `fader.channel` (the fixture panel's faders, created at the first touch) and `colour.apply` (T41). Pure.
 */
import type { ChannelFader } from "./model.js";

/** Whether a fader's range leaves part of the travel out (an explicit 0..255 is the whole travel). */
export const narrowed = (range: { min: number; max: number } | undefined): boolean => range !== undefined && (range.min > 0 || range.max < 255);

/** The fader driving exactly this channel and nothing else over its whole travel (one narrowed to a function, T12, is something else). */
export const ownChannelFader = (faders: readonly ChannelFader[], fixture: string, offset: number): ChannelFader | undefined =>
  faders.find((f) => f.channels.length === 1 && f.channels[0]!.fixture === fixture && f.channels[0]!.offset === offset && !narrowed(f.range));

/** A free id for a new fader of that channel: panel-<fixture>-<offset>, then -2, -3… */
export function channelFaderId(faders: readonly ChannelFader[], fixture: string, offset: number): string {
  const taken = new Set(faders.map((f) => f.id));
  const base = `panel-${fixture}-${offset}`;
  let id = base;
  for (let k = 2; taken.has(id); k++) id = `${base}-${k}`;
  return id;
}
