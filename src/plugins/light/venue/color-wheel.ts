/**
 * The colour wheel of a fixture without colour mixing (a lamp and a wheel, docs/specs/venue-fixtures-
 * stage.md, « Roue de couleurs »): which slot answers a painted colour. Pure: the venue reads the slots
 * from the definition and its overrides, the runtime keeps the slot each fixture holds from frame to
 * frame (hysteresis), toDmx writes the value.
 *
 * - Slots are ranges `{min, max}`: the value sent is the **middle** of the range (it holds when the DMX
 *   drifts by a step or two), and a value read back finds its slot by range, wherever in it.
 * - The choice goes by **OKLab** distance between colours brought to the same level (the level goes to
 *   the dimmer): only the hue and the saturation count.
 * - A **near-neutral** colour goes to a neutral slot (white, or « Open », a slot without filter) rather
 *   than to a pale tint.
 * - A **split** slot (two colours) is never chosen for one colour; it is when a look asks those two
 *   colours of the fixture (`askOf`).
 * - **Hysteresis**: the slot held stays unless another is clearly closer (`SWITCH_MARGIN`), so a colour
 *   gliding along does not make the wheel turn back and forth (a turning wheel flashes the colours between).
 */
import type { FixtureCapability } from "./qxf-import.js";
import type { WheelOverrides } from "./overrides.js";
import type { Color } from "./venue.js";
import { lightRgb, displayHex } from "../engine/display.js";
import { chroma, oklab, oklabDistance, type Lab } from "../engine/oklab.js";

/** A slot of the wheel: its DMX range, its name, its colour(s) as the fixture shows them. */
export interface WheelSlot {
  min: number;
  max: number;
  name: string;
  color: Color;
  /** A split slot's second colour. */
  color2?: Color;
  /** A slot without filter (« Open »), white light. */
  open?: boolean;
  /** Colours the slot answers to beside its own (overrides). */
  answers?: Color[];
  /** Never chosen from a painted colour (overrides). */
  off?: boolean;
}

/** A wheel ready to choose from: its slots, overrides applied, and the per-fixture options. */
export interface Wheel {
  offset: number;
  slots: WheelSlot[];
  /** Split slots may answer a look asking their two colours. */
  doubles: boolean;
  /** How the slot changes in a crossfade: at mid-fade, or with the dimmer through black (« au noir »). */
  change: "mid" | "black";
}

/** A slot is kept unless another is at least this much closer (relative: 0.2 = 20 % closer). */
export const SWITCH_MARGIN = 0.2;
/** An asked colour whose OKLab chroma is below this is near-neutral: it goes to a white or open slot. */
export const NEUTRAL_CHROMA = 0.04;
/** Two colours of one look closer than this (OKLab) are one colour: the look asks only one. */
export const DISTINCT = 0.1;
/** A split slot answers two asked colours only when each is this close (OKLab) to one of its halves. */
export const DOUBLE_MATCH = 0.1;
/** Below this level a painted colour asks nothing (black: the dimmer is at 0 anyway). */
const DARK = 0.02;

const hexColor = (hex: string): Color => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const WHITE: Color = { red: 1, green: 1, blue: 1 };
/** A slot without filter, by its name: « Open », « White », « Blanc »… (QLC+ often gives it no colour). */
const OPEN_NAME = /^\s*(open|white|blanc|ouvert|clear|no colou?r|sans couleur)\b/i;

/** The value sent for a slot: the middle of its range. */
export const slotValue = (s: { min: number; max: number }): number => Math.round((s.min + s.max) / 2);

/** The slot a DMX value falls in, by range (the preview and `dmx.explain` read the wheel byte back). */
export function slotAt<S extends { min: number; max: number }>(slots: readonly S[], value: number): S | undefined {
  return slots.find((s) => value >= s.min && value <= s.max);
}

/** The coloured slots of a wheel channel: a capability with a colour, or an open (white) one named so. */
export function wheelSlots(capabilities: readonly FixtureCapability[]): WheelSlot[] {
  return capabilities.flatMap((c): WheelSlot[] => {
    if (c.color) return [{ min: c.min, max: c.max, name: c.name, color: hexColor(c.color), ...(c.color2 ? { color2: hexColor(c.color2) } : {}) }];
    if (OPEN_NAME.test(c.name)) return [{ min: c.min, max: c.max, name: c.name, color: WHITE, open: true }];
    return [];
  });
}

/** The slots with the corrections of a model or a fixture (venue/overrides.ts): real colour, colours answered, slots left out. */
export function applyWheelOverrides(slots: readonly WheelSlot[], o: WheelOverrides | undefined): WheelSlot[] {
  return slots.map((s) => {
    const own = o?.slots?.[String(s.min)];
    if (!own) return s;
    return { ...s, ...(own.color ? { color: hexColor(own.color) } : {}), ...(own.answers?.length ? { answers: own.answers.map(hexColor) } : {}), ...(own.off ? { off: true } : {}) };
  });
}

/** The wheel of a channel, or none when it has no coloured slot. */
export function wheelOf(offset: number, capabilities: readonly FixtureCapability[], o: WheelOverrides | undefined): Wheel | undefined {
  const slots = applyWheelOverrides(wheelSlots(capabilities), o);
  return slots.length ? { offset, slots, doubles: o?.doubles ?? true, change: o?.change ?? "mid" } : undefined;
}

/** A colour at full level (its brightest component at 1), in OKLab: the hue and saturation only. */
function hueOf(c: Color): Lab | undefined {
  const rgb = lightRgb(c);
  const top = Math.max(...rgb);
  return top > DARK ? oklab(rgb.map((v) => v / top) as [number, number, number]) : undefined;
}

/** A colour on screen at full level (as the slot choice sees it). */
function fullHex(c: Color): string {
  const [r, g, b] = lightRgb(c);
  const top = Math.max(r, g, b) || 1;
  return displayHex({ red: r / top, green: g / top, blue: b / top });
}

const levelOf = (c: Color): number => Math.max(0, ...Object.values(c).map((v) => v ?? 0));

/** What a slot is chosen by: its colour and those it answers to. */
const refsOf = (s: WheelSlot): Lab[] => [s.color, ...(s.answers ?? [])].map(hueOf).filter((x): x is Lab => x !== undefined);

/** The slot chosen, how far its real colour is from what was asked (OKLab, at full level), and the value to send. */
export interface WheelPick {
  slot: WheelSlot;
  value: number;
  gap: number;
}

/**
 * The slot for the colour(s) asked (`ask`: one colour, or the two a look asks of the fixture), the slot
 * held until now (`previous`, its `min`) kept unless another is `SWITCH_MARGIN` closer. Undefined when
 * nothing is asked or no slot can answer.
 */
export function pickSlot(slots: readonly WheelSlot[], ask: readonly Color[], previous?: number, opts: { doubles?: boolean } = {}): WheelPick | undefined {
  const asked = ask.map(hueOf).filter((x): x is Lab => x !== undefined);
  if (!asked.length) return undefined;
  const live = slots.filter((s) => !s.off);
  // a split slot answers two colours, each near one of its halves (either way round)
  // `forced`: nearest by a colour the slot answers to (overrides), which wins a tie with a slot's own colour
  type Scored = { slot: WheelSlot; d: number; forced?: boolean };
  let scored: Scored[] = [];
  if (asked.length >= 2 && (opts.doubles ?? true)) {
    const [a, b] = asked as [Lab, Lab];
    for (const s of live) {
      const h1 = s.color2 && hueOf(s.color);
      const h2 = s.color2 && hueOf(s.color2);
      if (!h1 || !h2) continue;
      const d = Math.min(Math.max(oklabDistance(a, h1), oklabDistance(b, h2)), Math.max(oklabDistance(a, h2), oklabDistance(b, h1)));
      if (d <= DOUBLE_MATCH) scored.push({ slot: s, d });
    }
  }
  if (!scored.length) {
    // one colour (the first asked): the plain slots, the neutral ones only for a near-neutral colour when there are any
    const target = asked[0]!;
    const plain = live.filter((s) => !s.color2);
    const neutral = chroma(target) < NEUTRAL_CHROMA ? plain.filter((s) => s.open || refsOf(s).some((r) => chroma(r) < NEUTRAL_CHROMA)) : [];
    scored = (neutral.length ? neutral : plain)
      .map((slot) => {
        const own = hueOf(slot.color);
        const dOwn = own ? oklabDistance(target, own) : Infinity;
        const dAnswer = Math.min(Infinity, ...(slot.answers ?? []).map(hueOf).filter((x): x is Lab => x !== undefined).map((r) => oklabDistance(target, r)));
        return dAnswer <= dOwn ? { slot, d: dAnswer, forced: true } : { slot, d: dOwn };
      })
      .filter((x) => Number.isFinite(x.d));
  }
  if (!scored.length) return undefined;
  let best = scored.reduce((x, y) => (y.d < x.d || (y.d === x.d && y.forced && !x.forced) ? y : x));
  const held = previous === undefined ? undefined : scored.find((x) => x.slot.min === previous);
  // a colour answered by hand wins over the slot held at the same distance (a correction applies at once)
  if (held && held !== best && !(best.d < held.d * (1 - SWITCH_MARGIN)) && !(best.forced && !held.forced && best.d <= held.d)) best = held;
  // the gap to the slot's real colour (a split slot: to its halves), not to the colours it answers to
  const real = hueOf(best.slot.color);
  const gap = best.slot.color2 ? best.d : real ? oklabDistance(asked[0]!, real) : 0;
  return { slot: best.slot, value: slotValue(best.slot), gap: Math.round(gap * 1000) / 1000 };
}

/**
 * What a look asks of a wheel fixture from what it paints on it (head → colour; -1 the whole fixture):
 * nothing when it is dark there; two colours when it paints two heads (or cells) of the fixture with
 * colours at least `DISTINCT` apart — the first two in head order —, else the colour of its brightest head.
 */
export function askOf(heads: ReadonlyMap<number, Color>): Color[] {
  const lit = [...heads].filter(([, c]) => levelOf(c) > DARK).sort(([a], [b]) => a - b);
  if (!lit.length) return [];
  const distinct: { color: Color; hue: Lab }[] = [];
  for (const [, color] of lit) {
    const hue = hueOf(color)!;
    if (distinct.every((x) => oklabDistance(x.hue, hue) >= DISTINCT)) distinct.push({ color, hue });
  }
  if (distinct.length >= 2) return [distinct[0]!.color, distinct[1]!.color];
  return [lit.reduce((x, y) => (levelOf(y[1]) > levelOf(x[1]) ? y : x))[1]];
}

/** One look painting a fixture: its fade weight and what it paints there (head → colour). */
export interface LookPaint {
  look: string;
  weight: number;
  heads: ReadonlyMap<number, Color>;
}

/** The slot a fixture holds on this frame, and the dimmer factor of « au noir » (1 otherwise). */
export interface WheelFrame {
  pick: WheelPick | undefined;
  /** The colour asked (screen hex), for `dmx.explain`. */
  asked: string | undefined;
  dim: number;
}

/**
 * The wheel of one fixture on one frame. The slot follows the **heaviest** look painting the fixture (on
 * equal weights the one started last, on top): in a crossfade A → B it changes at mid-fade, once B weighs
 * as much as A, never on the colours between. With `change: "black"` the dimmer goes through black there:
 * the heaviest look's light is dosed by how much it outweighs the looks wanting another slot,
 * (top − others) / top, 0 at the crossing. Without looks (a frame built by hand), `fallback` (the colour
 * painted) is asked. Nothing asked: the slot held stays (`previous`), the lamp is dark anyway.
 */
export function wheelFrame(wheel: Wheel, paints: readonly LookPaint[], fallback: Color | undefined, previous: number | undefined): WheelFrame {
  const opts = { doubles: wheel.doubles };
  const asking = paints.map((p) => ({ weight: Math.max(0, p.weight), ask: askOf(p.heads) })).filter((p) => p.weight > 0 && p.ask.length);
  const top = asking.reduce<(typeof asking)[number] | undefined>((x, y) => (!x || y.weight >= x.weight ? y : x), undefined);
  const ask = top?.ask ?? (fallback && levelOf(fallback) > DARK ? [fallback] : []);
  const pick = pickSlot(wheel.slots, ask, previous, opts) ?? (previous !== undefined ? heldPick(wheel, previous) : undefined);
  let dim = 1;
  if (wheel.change === "black" && top && pick) {
    const others = asking.filter((p) => p !== top && pickSlot(wheel.slots, p.ask, undefined, opts)?.slot.min !== pick.slot.min).reduce((sum, p) => sum + p.weight, 0);
    dim = Math.max(0, (top.weight - others) / top.weight);
  }
  return { pick, asked: ask.length ? ask.map(fullHex).join("+") : undefined, dim };
}

/** The slot held, as a pick (nothing asked on this frame). */
function heldPick(wheel: Wheel, previous: number): WheelPick | undefined {
  const slot = wheel.slots.find((s) => s.min === previous);
  return slot && { slot, value: slotValue(slot), gap: 0 };
}

/** A slot's colour(s) on screen: one hex, or two joined by « + » for a split slot. */
export const slotHex = (s: WheelSlot): string => [s.color, ...(s.color2 ? [s.color2] : [])].map(displayHex).join("+");
