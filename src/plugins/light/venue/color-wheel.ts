/**
 * The colour wheel of a fixture without colour mixing (a lamp and a wheel, docs/specs/venue-fixtures-
 * stage.md, « Roue de couleurs »): which slot answers a painted colour. Pure: the venue reads the slots
 * from the definition and its overrides, the runtime keeps the slot each fixture holds from frame to
 * frame (hysteresis) and when it last changed, toDmx writes the value.
 *
 * - Slots are ranges `{min, max}`: the value sent is the **middle** of the range (it holds when the DMX
 *   drifts by a step or two), and a value read back finds its slot by range, wherever in it.
 * - The choice goes by the distance between **tints** (`tintDistance`, engine/oklab.ts): the level goes to
 *   the dimmer, so the colours are brought to one lightness, and the hue counts more than the saturation.
 * - A **near-neutral** colour goes to a neutral slot (white, or « Open », a slot without filter) rather
 *   than to a pale tint, with two thresholds so that a colour on the edge does not flap.
 * - A **split** slot (two colours) is never chosen for one colour; it is when a look asks those two
 *   colours of the fixture (`askOf`).
 * - **Hysteresis**: the slot held stays unless another is clearly closer (`SWITCH_MARGIN`), so a colour
 *   gliding along does not make the wheel turn back and forth (a turning wheel flashes the colours between).
 * - The wheel follows **the look whose colour wins** on the fixture (`wheelFrame`), never a mix of two.
 */
import type { FixtureCapability } from "./qxf-import.js";
import type { WheelOverrides } from "./overrides.js";
import type { Color, LooksMerge } from "./venue.js";
import { lightRgb, displayHex } from "../engine/display.js";
import { chroma, oklab, oklabDistance, tintDistance, type Lab } from "../engine/oklab.js";

/** A range of the wheel channel as the definition gives it: a slot once it has a colour (its own, « Open », or a correction). */
export interface WheelCapability {
  min: number;
  max: number;
  name: string;
  color?: Color;
  /** A split slot's second colour. */
  color2?: Color;
  /** A slot without filter (« Open »), white light. */
  open?: boolean;
}

/** A slot of the wheel: its DMX range, its name, its colour(s) as the fixture shows them. */
export interface WheelSlot extends WheelCapability {
  color: Color;
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
  /** « black »: how long the dimmer stays at 0 after a change, in ms (the time the wheel takes to turn). */
  changeMs: number;
}

/** A slot is kept unless another is at least this much closer (relative: 0.2 = 20 % closer). */
export const SWITCH_MARGIN = 0.2;
/** An asked colour whose OKLab chroma falls below this is near-neutral: it goes to a white or open slot. */
export const NEUTRAL_CHROMA = 0.04;
/** A wheel already on a neutral slot stays near-neutral up to this chroma (two thresholds: a colour on the edge does not flap). */
export const NEUTRAL_LEAVE = 0.05;
/** Two colours of one look closer than this (OKLab) are one colour: the look asks only one. */
export const DISTINCT = 0.1;
/** A split slot answers two asked colours only when each is this close (OKLab) to one of its halves. */
export const DOUBLE_MATCH = 0.1;
/** A head this much darker than the brightest one of its look asks nothing (relative: 0.02 = 2 % of it). */
const DARK = 0.02;
/** Below half a DMX step a colour is black: it asks nothing. */
const BLACK = 1 / 510;
/**
 * « Au noir »: how long the dimmer stays at 0 after the slot changed, in ms — the time the wheel takes to turn,
 * set per model (`changeMs` of the wheel overrides). The default is a guess: to measure on the hardware.
 */
export const WHEEL_CHANGE_MS = 300;
/**
 * « Au noir », in a crossfade: the light ramps down ahead of the change, from the moment the look coming in
 * paints within this share of the look still on top (0.25: from 75 % of its level), and back up after it.
 */
export const BLACK_RAMP = 0.25;
/** « Au noir », in a crossfade: the light comes back up over this long (ms) from the end of the black window, never in one frame. */
export const BLACK_RAMP_MS = 150;

const hexColor = (hex: string): Color => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const WHITE: Color = { red: 1, green: 1, blue: 1 };
const OPEN_WORDS = /open|white|blanc|ouvert|clear|no colou?r|sans couleur/gi;
/**
 * A slot without filter, by its name: « Open », « White », « Blanc », « Open / White », « White 5600K »… (QLC+
 * often gives it no colour). The whole name must say so: « White + Red » or « white/red split » are no open slot.
 */
export function isOpenName(name: string): boolean {
  const noWords = name.replace(OPEN_WORDS, "");
  // a colour temperature alone (« 5600K ») is a tint, not an open slot: it only goes with an open word
  return noWords !== name && !/\p{L}/u.test(noWords.replace(/\d+\s*k\b/gi, ""));
}

/** The value sent for a slot: the middle of its range. */
export const slotValue = (s: { min: number; max: number }): number => Math.round((s.min + s.max) / 2);

/** The slot a DMX value falls in, by range (the preview and `dmx.explain` read the wheel byte back). */
export function slotAt<S extends { min: number; max: number }>(slots: readonly S[], value: number): S | undefined {
  return slots.find((s) => value >= s.min && value <= s.max);
}

/**
 * Every range of a wheel channel: with its colour(s) when the definition gives them, white when it is named
 * open, else without (a rainbow, a definition that gives no colour: to be given one by a correction).
 */
export function wheelCapabilities(capabilities: readonly FixtureCapability[]): WheelCapability[] {
  return capabilities.map((c): WheelCapability => {
    if (c.color) return { min: c.min, max: c.max, name: c.name, color: hexColor(c.color), ...(c.color2 ? { color2: hexColor(c.color2) } : {}) };
    return { min: c.min, max: c.max, name: c.name, ...(isOpenName(c.name) ? { color: WHITE, open: true } : {}) };
  });
}

/**
 * The slots of a wheel: its ranges with the corrections of a model or a fixture (venue/overrides.ts) — real
 * colour, colours answered, slots left out. A range without colour is no slot until a correction gives it one;
 * an open slot given a real colour is no longer taken for white.
 */
export function applyWheelOverrides(capabilities: readonly WheelCapability[], o: WheelOverrides | undefined): WheelSlot[] {
  return capabilities.flatMap((c): WheelSlot[] => {
    const own = o?.slots?.[String(c.min)];
    const color = own?.color ? hexColor(own.color) : c.color;
    if (!color) return [];
    const { open, ...range } = c;
    return [{ ...range, color, ...(open && !own?.color ? { open } : {}), ...(own?.answers?.length ? { answers: own.answers.map(hexColor) } : {}), ...(own?.off ? { off: true } : {}) }];
  });
}

/** The coloured slots of a wheel channel as its definition gives them: a capability with a colour, or an open (white) one named so. */
export const wheelSlots = (capabilities: readonly FixtureCapability[]): WheelSlot[] => applyWheelOverrides(wheelCapabilities(capabilities), undefined);

/** The wheel of a channel; without any slot (a definition that gives no colour) it answers nothing until corrected. */
export function wheelOf(offset: number, capabilities: readonly FixtureCapability[], o: WheelOverrides | undefined): Wheel {
  return { offset, slots: applyWheelOverrides(wheelCapabilities(capabilities), o), doubles: o?.doubles ?? true, change: o?.change ?? "mid", changeMs: o?.changeMs ?? WHEEL_CHANGE_MS };
}

/** A colour at full level (its brightest component at 1), in OKLab: the hue and saturation only. */
function hueOf(c: Color): Lab | undefined {
  const rgb = lightRgb(c);
  const top = Math.max(...rgb);
  return top > BLACK ? oklab(rgb.map((v) => v / top) as [number, number, number]) : undefined;
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

/** A slot of white light: without filter, or whose colour (or one it answers to) is near-neutral. */
const isNeutral = (s: WheelSlot): boolean => Boolean(s.open) || refsOf(s).some((r) => chroma(r) < NEUTRAL_CHROMA);

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
  const split = scored.length > 0;
  if (!split) {
    // one colour (the first asked): the plain slots, the neutral ones only for a near-neutral colour when there are any.
    // Two thresholds: a wheel already on a neutral slot stays near-neutral a little further; and the slot held stays
    // among those to choose from, to be left only for one clearly closer (no flapping on the edge).
    const target = asked[0]!;
    const plain = live.filter((s) => !s.color2);
    const on = previous === undefined ? undefined : plain.find((s) => s.min === previous);
    const neutral = chroma(target) < (on && isNeutral(on) ? NEUTRAL_LEAVE : NEUTRAL_CHROMA) ? plain.filter((s) => isNeutral(s) || s === on) : [];
    scored = (neutral.some(isNeutral) ? neutral : plain)
      .map((slot) => {
        const own = hueOf(slot.color);
        const dOwn = own ? tintDistance(target, own) : Infinity;
        const dAnswer = Math.min(Infinity, ...(slot.answers ?? []).map(hueOf).filter((x): x is Lab => x !== undefined).map((r) => tintDistance(target, r)));
        return dAnswer <= dOwn ? { slot, d: dAnswer, forced: true } : { slot, d: dOwn };
      })
      .filter((x) => Number.isFinite(x.d));
  }
  if (!scored.length) return undefined;
  let best = scored.reduce((x, y) => (y.d < x.d || (y.d === x.d && y.forced && !x.forced) ? y : x));
  const held = previous === undefined ? undefined : scored.find((x) => x.slot.min === previous);
  // a colour answered by hand wins over the slot held at the same distance (a correction applies at once)
  if (held && held !== best && !(best.d < held.d * (1 - SWITCH_MARGIN)) && !(best.forced && !held.forced && best.d <= held.d)) best = held;
  // the gap to the slot's real colour, not to the colours it answers to: a split slot's, to its halves; a plain
  // slot asked two colours shows one only, so the gap is that of the farther of the two
  const real = hueOf(best.slot.color);
  const gap = split ? best.d : real ? Math.max(...asked.slice(0, 2).map((a) => oklabDistance(a, real))) : 0;
  return { slot: best.slot, value: slotValue(best.slot), gap: Math.round(gap * 1000) / 1000 };
}

/**
 * What a look asks of a wheel fixture from what it paints on it (head → colour; -1 the whole fixture):
 * nothing when it is dark there; two colours when it paints two heads (or cells) of the fixture with
 * colours at least `DISTINCT` apart — the first two in head order —, else the colour of its brightest head.
 * A head much darker than the brightest one (`DARK`, relative: the look may be far down a fade) asks nothing.
 */
export function askOf(heads: ReadonlyMap<number, Color>): Color[] {
  const top = Math.max(0, ...[...heads.values()].map(levelOf));
  if (top <= BLACK) return [];
  const lit = [...heads].filter(([, c]) => levelOf(c) > BLACK && levelOf(c) >= DARK * top).sort(([a], [b]) => a - b);
  const distinct: { color: Color; hue: Lab }[] = [];
  for (const [, color] of lit) {
    const hue = hueOf(color);
    if (hue && distinct.every((x) => oklabDistance(x.hue, hue) >= DISTINCT)) distinct.push({ color, hue });
  }
  if (distinct.length >= 2) return [distinct[0]!.color, distinct[1]!.color];
  return [lit.reduce((x, y) => (levelOf(y[1]) > levelOf(x[1]) ? y : x))[1]];
}

/**
 * One look painting a fixture. `sheet`: a crossfade and the looks it replaces share one, any other look has
 * its own (like `RawWrite.sheet`). `heads`: what it paints there now (head → colour), fades and masters
 * applied — its level says how much of the fixture's light is this look's. `hues`: the same at full, before
 * fades and masters — what it asks of the wheel, known in the dark (a look rising from black pre-positions it).
 */
export interface LookPaint {
  look: string;
  sheet: string;
  heads: ReadonlyMap<number, Color>;
  hues?: ReadonlyMap<number, Color>;
}

/** The slot a fixture holds on this frame, when it last changed, and the dimmer factor of « au noir » (1 otherwise). */
export interface WheelFrame {
  pick: WheelPick | undefined;
  /** The colour asked (screen hex), for `dmx.explain`; none when nothing is asked (the slot held stays). */
  asked: string | undefined;
  dim: number;
  /** When the slot last changed (the `now` of that frame); none while it never did. */
  changedAt: number | undefined;
}

/** What is kept of a wheel from frame to frame: the slot held (its `min`) and when it last changed. */
export interface WheelHeld {
  slot: number;
  changedAt?: number;
}

const paintedLevel = (p: LookPaint): number => Math.max(0, ...[...p.heads.values()].map(levelOf));

/** The slot a look would take on its own (its `min`), none when it asks nothing. */
const wants = (wheel: Wheel, p: LookPaint, opts: { doubles: boolean }): number | undefined => pickSlot(wheel.slots, askOf(p.hues ?? p.heads), undefined, opts)?.slot.min;

/**
 * The wheel of one fixture on one frame. `paints`: the looks painting it, in the order their colours are laid
 * (the last one on top). The slot follows **the look whose colour wins** there, never a mix of two:
 *
 * - merge « last »: only the latest sheet painting the fixture counts, as for its colour — a look started over
 *   another turns the wheel at once (its light rises from black on the new slot), and while it paints black
 *   (a chase's dark step) it asks nothing: the slot held stays, the wheel never goes back to the look below;
 * - inside a sheet (a crossfade and the looks leaving under it), or among all with « highest », the look
 *   painting the most light (its painted level, which carries its fade weight; on equal levels the later one):
 *   in a crossfade A → B the slot changes at mid-fade, once B lights as much as A, never on the colours between.
 *
 * What that look asks is read from its colours at full (`hues`): known before its light rises. The dimmer keeps
 * the level of the merged colour: mid-way between two colours sharing no component it dips to about 51 % (known,
 * left as it is).
 *
 * With `change: "black"` the dimmer goes through black where the slot changes: 0 for `changeMs` after a change
 * (`held.changedAt`, on the injected `now`) — a real change only, never the first slot taken — and in a
 * crossfade the light ramps down ahead of it (`BLACK_RAMP`). Without looks (a frame built by hand), `fallback`
 * (the colour painted) is asked. Nothing asked: the slot held stays, the lamp is dark anyway.
 */
export function wheelFrame(wheel: Wheel, paints: readonly LookPaint[], fallback: Color | undefined, held: WheelHeld | undefined, at: { now: number; merge: LooksMerge }): WheelFrame {
  const opts = { doubles: wheel.doubles };
  const sheet = paints[paints.length - 1]?.sheet;
  const counting = at.merge === "last" ? paints.filter((p) => p.sheet === sheet) : paints;
  const levels = new Map(counting.map((p) => [p, paintedLevel(p)]));
  const top = counting.reduce<LookPaint | undefined>((x, y) => (!x || levels.get(y)! >= levels.get(x)! ? y : x), undefined);
  const ask = top ? askOf(top.hues ?? top.heads) : fallback && levelOf(fallback) > BLACK ? [fallback] : [];
  const pick = pickSlot(wheel.slots, ask, held?.slot, opts) ?? (held ? heldPick(wheel, held.slot) : undefined);
  const changedAt = held && pick && pick.slot.min !== held.slot ? at.now : held?.changedAt;
  let dim = 1;
  if (wheel.change === "black" && pick) {
    // a clock gone back (now < changedAt): the window is over, no delayed black
    const since = changedAt !== undefined && at.now >= changedAt ? at.now - changedAt : undefined;
    if (since !== undefined && since < wheel.changeMs) dim = 0;
    else if (top) {
      // in a crossfade: the brightest look of the same sheet wanting another slot, closing in or moving away
      const mine = levels.get(top)!;
      const other = Math.max(0, ...counting.filter((p) => p !== top && p.sheet === top.sheet && wants(wheel, p, opts) !== pick.slot.min).map((p) => levels.get(p)!));
      if (mine > BLACK && other > 0) {
        dim = Math.max(0, Math.min(1, (mine - other) / (mine * BLACK_RAMP)));
        // the ramp back up is anchored at the end of the black window: a short crossfade does not jump from 0 to its level
        if (since !== undefined && wheel.changeMs > 0) dim = Math.min(dim, (since - wheel.changeMs) / BLACK_RAMP_MS);
      }
    }
  }
  return { pick, asked: ask.length ? ask.map(fullHex).join("+") : undefined, dim, changedAt };
}

/** The slot held, as a pick (nothing asked on this frame). */
function heldPick(wheel: Wheel, previous: number): WheelPick | undefined {
  const slot = wheel.slots.find((s) => s.min === previous);
  return slot && { slot, value: slotValue(slot), gap: 0 };
}

/** A slot's colour(s) on screen: one hex, or two joined by « + » for a split slot. */
export const slotHex = (s: WheelSlot): string => [s.color, ...(s.color2 ? [s.color2] : [])].map(displayHex).join("+");
