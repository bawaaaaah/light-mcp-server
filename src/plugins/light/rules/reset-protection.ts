/**
 * Reset channel protection (docs/specs/rules-limits.md, « Protection du canal Reset »): a built-in
 * locked rule holds every channel with a range tagged `reset` (qxf-import.ts, capabilityTags) at
 * rest against looks, faders, rules and the DMX console. A moving head that resets in the middle of
 * a song swings around and goes dark for seconds: only a voluntary reset (`fixture.reset`) lifts it,
 * for one fixture (and the fixtures sharing its channels) and a few seconds. The rule lives in the
 * engine, not in a venue's files: it can be neither deleted nor relaxed, and `rule.list` shows it.
 *
 * Unlike a forbidden tag of an ordinary rule (rules.ts, moved to the nearest allowed value), a value
 * falling in a Reset range does not go to the next range: on « 0–99 nothing / 100–149 Lamp off /
 * 150–199 Reset / 200–255 Lamp on », the nearest value would switch the lamp off or on. The channel
 * goes back to the last value it had outside its Reset ranges (what the show gave before the
 * forbidden write, a lamp range included), else to its rest: the start of its « no function » range.
 *
 * A Reset range holding 0 triggers nothing: an unwritten channel sits at 0 from power-on, so the
 * fixture cannot reset there, and pushing the channel out of it would start another function
 * (« 0 No effect / 1–10 Sound control »). The protection leaves it alone; show.lint tells. Pure: the
 * memory is passed in.
 */
import { say } from "../../../core/lang.js";
import { capabilityKind, type FixtureCapability, type FixtureChannel } from "../venue/qxf-import.js";
import { ANSWERING_ORIGINS, type Origin } from "../commands/registry.js";
import type { ResolvedFixture } from "../venue/venue.js";
import { RuleSchema, type Clamp, type Rule } from "./rules.js";

export const RESET_RULE_ID = "protection-reset";

/**
 * How long a voluntary reset sends its value: long enough for the fixture to read it (many need it
 * held a few seconds). A default to validate on the hardware.
 */
export const RESET_WINDOW_MS = 5000;

/**
 * Who may trigger a voluntary reset: callers where someone can answer a confirmation (the interface,
 * an AI client asking the user, the command line). Never a MIDI pad, an OSC message, the DJ software
 * or a song's timeline: a reset in the middle of a song is what the protection is for. A default the
 * user confirms.
 */
export const RESET_ORIGINS: readonly Origin[] = ANSWERING_ORIGINS;

const BASE: Rule = RuleSchema.parse({ id: RESET_RULE_ID, level: "venue", target: { tag: "reset" }, forbidTags: ["reset"], locked: true, onViolation: "clamp" });

/** The built-in rule, named in the language of whoever reads it (the « built in » badge is the interface's). */
export function resetProtectionRule(): Rule {
  return {
    ...BASE,
    name: say("Protection du canal Reset", "Reset channel protection"),
    notes: say(
      "Règle du moteur, ni supprimable ni modifiable : un canal Reset reste au repos (la dernière valeur qu'il avait hors de ses plages Reset, sinon le début de sa plage « sans fonction ») pour les looks, les faders, les règles et la console. « Réinitialiser l'appareil » (fixture.reset) la lève quelques secondes pour un seul projecteur.",
      "Engine rule, neither deletable nor editable: a Reset channel stays at rest (the last value it had outside its Reset ranges, else the start of its « no function » range) for looks, faders, rules and the console. « Reset the fixture » (fixture.reset) lifts it for a few seconds, for one fixture only.",
    ),
  };
}

/** A rule id that only the engine may use. */
export const isBuiltinRule = (id: string): boolean => id === RESET_RULE_ID;

/** A maintenance range: a reset, the lamp switched on or off (by its tag, its QLC+ preset or its name). */
export function isMaintenance(c: Pick<FixtureCapability, "name" | "preset" | "color" | "tags">): boolean {
  return c.tags.includes("reset") || /^(Reset|Lamp)/.test(c.preset ?? "") || capabilityKind(c) === "maintenance";
}

const isReset = (c: Pick<FixtureCapability, "tags">) => c.tags.includes("reset");

/** A Reset range that can trigger one: not one holding 0, where every unwritten channel sits from power-on. */
const triggers = (c: Pick<FixtureCapability, "tags" | "min">) => isReset(c) && c.min > 0;

/** Whether a value falls in one of the channel's triggering Reset ranges. */
const inTrigger = (ch: Pick<FixtureChannel, "capabilities">, v: number) => ch.capabilities.some((c) => triggers(c) && v >= c.min && v <= c.max);

const isLampOff = (c: Pick<FixtureCapability, "name" | "preset">) => c.preset === "LampOff" || /\blamps?\s*off\b/i.test(c.name);
const isLampOn = (c: Pick<FixtureCapability, "name" | "preset">) => c.preset === "LampOn" || /\blamps?\s*on\b/i.test(c.name);

/**
 * Where a Reset channel rests: the start of its « no function » range (a neutral one), else of its
 * first range that is no maintenance. Undefined when every range is maintenance (a channel that is
 * all « Lamp » and « Reset »): the protection then falls back on Lamp on (holdAtRest).
 */
export function restValue(ch: Pick<FixtureChannel, "capabilities">): number | undefined {
  const free = ch.capabilities.filter((c) => !isMaintenance(c));
  return (free.find((c) => capabilityKind(c) === "neutral") ?? free[0])?.min;
}

/** A name saying reset (« Reset », « Resets », « Resetting », in French « Réinitialisation »). */
const RESET_WORD = /\breset(s|ting)?\b|\br[ée]initialis/i;
/** A name saying everything is reset (« Reset all », « Complete reset », « Réinitialisation totale »). */
const ALL_WORD = /\b(all|complete|total|entire|tout|totale|complet|compl[èe]te)\b/i;

/**
 * The Reset range a voluntary reset sends, by what its name says first: QLC+ presets are often wrong
 * (ResetAll on « Enable blackout while pan/tilt move »). (a) a reset of everything by its name;
 * (b) a ResetAll preset whose name says reset; (c) the first range whose name says reset; (d) the
 * first Reset range. Ranges holding 0 trigger nothing: chosen only for a channel that has no other.
 */
function chosenReset(ch: FixtureChannel): { cap: FixtureCapability; others: FixtureCapability[] } | undefined {
  const all = ch.capabilities.filter(isReset);
  const live = all.filter(triggers);
  const resets = live.length ? live : all;
  const cap =
    resets.find((c) => RESET_WORD.test(c.name) && ALL_WORD.test(c.name)) ??
    resets.find((c) => c.preset === "ResetAll" && RESET_WORD.test(c.name)) ??
    resets.find((c) => RESET_WORD.test(c.name)) ??
    resets[0];
  return cap && { cap, others: all.filter((c) => c !== cap) };
}

export interface ResetChannel {
  offset: number;
  name: string;
  /** The value a voluntary reset sends: the middle of its Reset range (safe from a range read one off). */
  value: number;
  /** That range, as people read it: « Reset all (200–255) ». */
  range: string;
  /** The other Reset ranges of the channel, left alone: the confirmation says which one is sent. */
  others: string[];
}

const rangeText = (c: FixtureCapability) => `${c.name || "Reset"} (${c.min}–${c.max})`;

/** The channels of a fixture carrying a Reset range, with the range a voluntary reset sends and its value. */
export function resetChannels(fx: Pick<ResolvedFixture, "def" | "mode">): ResetChannel[] {
  return fx.mode.channels.flatMap((name, offset) => {
    const ch = fx.def.channels.get(name);
    const chosen = ch && chosenReset(ch);
    if (!chosen) return [];
    const { cap, others } = chosen;
    return [{ offset, name, value: Math.floor((cap.min + cap.max) / 2), range: rangeText(cap), others: others.map(rangeText) }];
  });
}

/**
 * Channels of a fixture the protection cannot hold out of their Reset ranges: no rest, no memory
 * possible, and no range but resets and Lamp off (a channel that is all « Reset » from 1 up).
 */
export function unprotectable(fx: Pick<ResolvedFixture, "def" | "mode">): string[] {
  return fx.mode.channels.filter((name) => {
    const ch = fx.def.channels.get(name);
    return ch !== undefined && ch.capabilities.some(triggers) && restValue(ch) === undefined && nearestOutside(0, ch) === undefined;
  });
}

/**
 * Reset ranges holding 0 (« 0–10 Reset to display fan setting »), per channel: the protection leaves
 * them alone, the channel sitting there from power-on (show.lint tells, for the user to check the
 * fixture's manual).
 */
export function powerOnResets(fx: Pick<ResolvedFixture, "def" | "mode">): { channel: string; range: string }[] {
  return fx.mode.channels.flatMap((name) => {
    const c = fx.def.channels.get(name)?.capabilities.find((x) => isReset(x) && x.min === 0);
    return c ? [{ channel: name, range: rangeText(c) }] : [];
  });
}

/**
 * Holds a fixture's Reset channels at rest in a DMX buffer. `last` remembers, per DMX slot (fixtures
 * sharing a channel share it), the last value seen outside the triggering Reset ranges, a lamp range
 * included: a value written into a Reset range goes back to it, else to the channel's rest. A Lamp
 * on or off written on purpose is left alone: only a reset is forbidden; so is a Reset range holding
 * 0 (no trigger, see the header). `lifted` slots are those a voluntary reset sends now. A channel
 * without rest nor memory goes to the nearest Lamp on or neutral range, else to the nearest range
 * that is neither a reset nor Lamp off, else is left as it is. Returns what it moved.
 */
export function holdAtRest(fx: ResolvedFixture, buffer: Uint8Array, last: Map<string, number>, lifted: (index: number) => boolean = () => false): Clamp[] {
  const clamps: Clamp[] = [];
  fx.mode.channels.forEach((name, offset) => {
    const ch = fx.def.channels.get(name);
    const index = fx.patch.address - 1 + offset;
    if (!ch?.tags.includes("reset") || index < 0 || index >= buffer.length || lifted(index)) return;
    const key = `${fx.patch.universe}/${index}`;
    const v = buffer[index]!;
    if (!inTrigger(ch, v)) {
      last.set(key, v);
      return;
    }
    // a remembered value is checked against this channel: the slot may have been another fixture's
    const kept = last.get(key);
    const to = (kept !== undefined && !inTrigger(ch, kept) ? kept : undefined) ?? restValue(ch) ?? nearestOutside(v, ch);
    if (to === undefined || to === v) return;
    buffer[index] = to;
    clamps.push({ fixture: fx.patch.id, channel: name, from: v, to, rule: RESET_RULE_ID });
  });
  return clamps;
}

/**
 * For a channel without rest nor memory: the nearest value of a Lamp on or neutral range, else of a
 * range that is neither a triggering reset nor Lamp off. Never Lamp off: the protection would put the
 * lamp out in the middle of a song.
 */
function nearestOutside(v: number, ch: Pick<FixtureChannel, "capabilities">): number | undefined {
  const nearest = (caps: FixtureCapability[]) => {
    let best: number | undefined;
    for (const c of caps) for (const x of [c.min, c.max]) if (best === undefined || Math.abs(x - v) < Math.abs(best - v)) best = x;
    return best;
  };
  const allowed = ch.capabilities.filter((c) => !triggers(c) && !isLampOff(c));
  return nearest(allowed.filter((c) => isLampOn(c) || capabilityKind(c) === "neutral")) ?? nearest(allowed);
}
