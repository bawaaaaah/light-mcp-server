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
 * keeps the value it had outside the maintenance ranges (what the show gave before the forbidden
 * write), else its rest: the start of its « no function » range. Pure: the memory is passed in.
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
      "Règle du moteur, ni supprimable ni modifiable : un canal Reset reste au repos (la valeur qu'il avait hors des plages de maintenance, sinon le début de sa plage « sans fonction ») pour les looks, les faders, les règles et la console. « Réinitialiser l'appareil » (fixture.reset) la lève quelques secondes pour un seul projecteur.",
      "Engine rule, neither deletable nor editable: a Reset channel stays at rest (the value it had outside its maintenance ranges, else the start of its « no function » range) for looks, faders, rules and the console. « Reset the fixture » (fixture.reset) lifts it for a few seconds, for one fixture only.",
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

/**
 * Where a Reset channel rests: the start of its « no function » range (a neutral one), else of its
 * first range that is no maintenance. Undefined when every range is maintenance (a channel that is
 * all « Reset »): the protection cannot hold it at rest (show.lint says so).
 */
export function restValue(ch: Pick<FixtureChannel, "capabilities">): number | undefined {
  const free = ch.capabilities.filter((c) => !isMaintenance(c));
  return (free.find((c) => capabilityKind(c) === "neutral") ?? free[0])?.min;
}

/** The Reset range a voluntary reset sends: the « all » one when there are several (by its QLC+ preset or its name), else the first. */
function chosenReset(ch: FixtureChannel): { cap: FixtureCapability; others: FixtureCapability[] } | undefined {
  const resets = ch.capabilities.filter(isReset);
  const cap = resets.find((c) => c.preset === "ResetAll" || /\ball\b|\btout/i.test(c.name)) ?? resets[0];
  return cap && { cap, others: resets.filter((c) => c !== cap) };
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

/** Channels of a fixture the protection cannot hold at rest: every range is maintenance. */
export function unprotectable(fx: Pick<ResolvedFixture, "def" | "mode">): string[] {
  return fx.mode.channels.filter((name) => {
    const ch = fx.def.channels.get(name);
    return ch?.tags.includes("reset") && restValue(ch) === undefined;
  });
}

/**
 * Holds a fixture's Reset channels at rest in a DMX buffer. `last` remembers, per DMX slot (fixtures
 * sharing a channel share it), the last value seen outside the maintenance ranges: a value written
 * into a Reset range goes back to it, else to the channel's rest. A Lamp on or off written on purpose
 * is left alone: only a reset is forbidden. `lifted` slots are those a voluntary reset sends now.
 * A channel that is all maintenance cannot rest: it is kept out of its Reset ranges when it has
 * another one (the nearest value), else left as it is. Returns what it moved.
 */
export function holdAtRest(fx: ResolvedFixture, buffer: Uint8Array, last: Map<string, number>, lifted: (index: number) => boolean = () => false): Clamp[] {
  const clamps: Clamp[] = [];
  fx.mode.channels.forEach((name, offset) => {
    const ch = fx.def.channels.get(name);
    const index = fx.patch.address - 1 + offset;
    if (!ch?.tags.includes("reset") || index < 0 || index >= buffer.length || lifted(index)) return;
    const key = `${fx.patch.universe}/${index}`;
    const v = buffer[index]!;
    const cap = ch.capabilities.find((c) => v >= c.min && v <= c.max);
    if (!cap || !isMaintenance(cap)) {
      last.set(key, v);
      return;
    }
    if (!isReset(cap)) return;
    // a remembered value is checked against this channel: the slot may have been another fixture's
    const kept = last.get(key);
    const keptOk = kept !== undefined && !ch.capabilities.some((c) => kept >= c.min && kept <= c.max && isMaintenance(c));
    const to = (keptOk ? kept : undefined) ?? restValue(ch) ?? nearestOutside(v, ch);
    if (to === undefined || to === v) return;
    buffer[index] = to;
    clamps.push({ fixture: fx.patch.id, channel: name, from: v, to, rule: RESET_RULE_ID });
  });
  return clamps;
}

/** The nearest value of a range that is no reset, for a channel without any rest. */
function nearestOutside(v: number, ch: FixtureChannel): number | undefined {
  let best: number | undefined;
  for (const c of ch.capabilities.filter((x) => !isReset(x))) for (const x of [c.min, c.max]) if (best === undefined || Math.abs(x - v) < Math.abs(best - v)) best = x;
  return best;
}
