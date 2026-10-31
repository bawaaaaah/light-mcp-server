/**
 * Rules mask, v1 (docs/specs/rules-limits.md): three levels — fixture type, venue/show, and
 * group/widget (group limits live on the groups themselves). Applied last to the show's rendered
 * output; the DMX console parks (technician forcing) are applied after it on purpose.
 *
 * A rule targets channels of fixtures (by type, fixture id, or everything) selected by channel
 * name, engine attribute or capability tag, and constrains their value: min/max, allowed values,
 * forbidden capability tags (a value falling in a forbidden range is moved to the nearest allowed
 * value). The most specific level wins unless a broader rule is `locked`.
 */
import { z } from "zod";
import { CAPABILITY_KINDS, capabilityKind, strobeHz, type CapabilityTag, type FixtureChannel } from "../venue/qxf-import.js";
import type { ResolvedFixture } from "../venue/venue.js";

export const RuleSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  level: z.enum(["type", "venue", "show"]).default("show"),
  /** zone: fixtures located in or aiming at this zone (protected zones). */
  scope: z.object({ model: z.string().optional(), fixture: z.string().optional(), zone: z.string().optional() }).prefault({}),
  target: z.object({
    channel: z.string().optional(),
    attribute: z.enum(["intensity", "color", "colorWheel", "pan", "tilt", "strobe", "effect", "speed", "maintenance", "other"]).optional(),
    color: z.string().optional(),
    tag: z.enum(["soundActive", "autoProgram", "builtinMacro", "strobe", "reset", "uv", "machine"]).optional(),
  }),
  min: z.number().int().min(0).max(255).optional(),
  max: z.number().int().min(0).max(255).optional(),
  values: z.array(z.number().int().min(0).max(255)).optional(),
  forbidTags: z.array(z.enum(["soundActive", "autoProgram", "builtinMacro", "strobe", "reset", "uv", "machine"])).optional(),
  /**
   * Allowlist: on a channel made of ranges, only ranges of these kinds (and the neutral ones: off,
   * open, no function); a value elsewhere goes to the nearest allowed range — « fixed colours and
   * dimmer only ».
   */
  allowCapabilities: z.array(z.enum(CAPABILITY_KINDS)).optional(),
  /**
   * Strobe no faster than this (Hz), where the fixture definition gives its strobe ranges in Hz:
   * the value moves to the nearest setting at or under it. Chosen by the venue (photosensitive
   * guidance speaks of 3 flashes a second); without frequencies in a definition it has no effect.
   */
  maxHz: z.number().positive().max(100).optional(),
  /**
   * Duration bound: at or above `above` (DMX value) for `seconds` at most — a blinder at full, a
   * hot lamp. After that the channel is held just under it until what drives it comes down.
   */
  hold: z.object({ above: z.number().int().min(1).max(255), seconds: z.number().positive().max(600) }).optional(),
  /** Pan/tilt no faster than this, in degrees per second (the fixture's travel from its definition): heads glide, motors are spared. */
  maxDegPerSecond: z.number().positive().max(10000).optional(),
  /** The value changes at most once every this many seconds (a haze or bubble machine never pulsing on the beat). */
  steadySeconds: z.number().positive().max(600).optional(),
  locked: z.boolean().default(false),
  /**
   * What a look launch does when this rule would bound it: clamp (the default: bound it and say so),
   * confirm (only on an explicit yes — a dialog in the interface, `confirm` for AI; refused from
   * MIDI, OSC or a song, where nobody can answer), or reject (never launched).
   */
  onViolation: z.enum(["clamp", "confirm", "reject"]).default("clamp"),
  /**
   * For some callers only: the rule does not bound the output (it mixes every source) but checks the
   * looks these callers launch — AI clients, MIDI, a volunteer's role — refusing or asking as
   * onViolation says (clamp refuses here). Absent: everyone, on the output.
   */
  appliesTo: z
    .object({
      origins: z.array(z.enum(["ui", "midi", "osc", "os2l", "ableset", "mcp", "timeline", "cli"])).optional(),
      roles: z.array(z.string()).optional(),
    })
    .optional(),
  /** Rule program it belongs to: the rule applies only while that program is active (absent = always). */
  program: z.string().optional(),
  notes: z.string().optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

/**
 * Rule program (docs/specs/rules-limits.md, « Programmes de règles »): a named set of rules for a
 * moment of the service — « prière : rien au-dessus de 40 %, pas de strobe ». One is active at a
 * time (or none). It is selected by a MIDI Program Change (its number, 0-based like the MIDI byte;
 * Live shows it +1, « #100 » = 99), by a song section, or by a command.
 */
export const RuleProgramSchema = z.object({
  id: z.string(),
  name: z.string(),
  programChange: z.number().int().min(0).max(127).optional(),
  channel: z.number().int().min(1).max(16).default(1),
  notes: z.string().optional(),
});
export type RuleProgram = z.infer<typeof RuleProgramSchema>;

/** The rules in force for the active program: rules without a program, plus that program's. */
export const rulesInForce = (rules: Rule[], activeProgram?: string): Rule[] => rules.filter((r) => !r.program || r.program === activeProgram);

const LEVEL_RANK = { type: 0, venue: 1, show: 2 } as const;

export interface Clamp {
  fixture: string;
  channel: string;
  from: number;
  to: number;
  rule: string;
}

export function ruleApplies(rule: Rule, fx: ResolvedFixture, ch: FixtureChannel, zoneOfFixture?: (id: string) => string | undefined): boolean {
  if (rule.scope.zone && fx.patch.target !== rule.scope.zone && zoneOfFixture?.(fx.patch.id) !== rule.scope.zone) return false;
  const model = `${fx.def.manufacturer} ${fx.def.model}`.toLowerCase();
  if (rule.scope.model && !model.includes(rule.scope.model.toLowerCase())) return false;
  if (rule.scope.fixture && rule.scope.fixture !== fx.patch.id) return false;
  const t = rule.target;
  if (t.channel && t.channel.toLowerCase() !== ch.name.toLowerCase()) return false;
  if (t.attribute && t.attribute !== ch.attribute) return false;
  if (t.color && t.color !== ch.color) return false;
  if (t.tag && !ch.tags.includes(t.tag as CapabilityTag)) return false;
  return true;
}

/** Nearest value outside the capability ranges `isBad` refuses. */
function avoidRanges(value: number, ch: FixtureChannel, isBad: (c: FixtureChannel["capabilities"][number]) => boolean): number {
  const bad = ch.capabilities.filter(isBad);
  if (!bad.some((c) => value >= c.min && value <= c.max)) return value;
  const allowed = ch.capabilities.filter((c) => !isBad(c));
  if (allowed.length === 0) return 0;
  let best = allowed[0]!.min;
  for (const c of allowed) for (const v of [c.min, c.max]) if (Math.abs(v - value) < Math.abs(best - value)) best = v;
  return best;
}

/** Specificity of a rule's scope: everything < a model < a zone < one fixture. */
const scopeRank = (r: Rule) => (r.scope.fixture ? 3 : r.scope.zone ? 2 : r.scope.model ? 1 : 0);
const specificity = (r: Rule) => LEVEL_RANK[r.level] * 10 + scopeRank(r);

type Constraint = "forbidTags" | "allowCapabilities" | "values" | "min" | "max" | "maxHz";
const CONSTRAINTS: Constraint[] = ["forbidTags", "allowCapabilities", "values", "min", "max", "maxHz"];

export interface EffectiveRule {
  min?: number;
  max?: number;
  maxHz?: number;
  values?: number[];
  forbidTags?: string[];
  allowCapabilities?: string[];
  /** constraint → id of the rule it comes from */
  from: Partial<Record<Constraint, string>>;
  /** locked rules re-applied on top (they cannot be relaxed) */
  locked: string[];
}

/**
 * The rule in force on one channel (docs/specs/rules-limits.md): each constraint comes from the
 * most specific rule that sets it — level (type < venue < show), then scope (all < model < zone <
 * fixture) — so a show can relax a type's limit; `locked` rules are re-applied on top. Pure.
 */
export function effectiveRule(rules: Rule[], fx: ResolvedFixture, ch: FixtureChannel, zoneOfFixture?: (id: string) => string | undefined): EffectiveRule | undefined {
  const applicable = rules.filter((r) => ruleApplies(r, fx, ch, zoneOfFixture)).sort((a, b) => specificity(a) - specificity(b));
  if (!applicable.length) return undefined;
  const eff: EffectiveRule = { from: {}, locked: applicable.filter((r) => r.locked).map((r) => r.id) };
  for (const r of applicable) {
    for (const k of CONSTRAINTS) {
      const v = r[k];
      if (v === undefined || (Array.isArray(v) && v.length === 0)) continue;
      (eff as unknown as Record<string, unknown>)[k] = v;
      eff.from[k] = r.id;
    }
  }
  // contradictory bounds (min above max): the more specific rule's bound wins
  if (eff.min !== undefined && eff.max !== undefined && eff.min > eff.max) {
    const rank = (id?: string) => specificity(applicable.find((r) => r.id === id)!);
    if (rank(eff.from.min) >= rank(eff.from.max)) {
      delete eff.max;
      delete eff.from.max;
    } else {
      delete eff.min;
      delete eff.from.min;
    }
  }
  return eff;
}

/** Moves a strobe value to the nearest one at or under maxHz: inside its range, else just outside it. */
function limitHz(v: number, ch: FixtureChannel, maxHz: number): number {
  const hz = strobeHz(v, ch);
  if (hz === undefined || hz <= maxHz) return v;
  const cap = ch.capabilities.find((c) => c.hz && v >= c.min && v <= c.max)!;
  let best: number | undefined;
  for (let x = cap.min; x <= cap.max; x++) if (strobeHz(x, ch)! <= maxHz && (best === undefined || Math.abs(x - v) < Math.abs(best - v))) best = x;
  if (best !== undefined) return best;
  // even the slowest setting of the range is too fast: the nearest value outside it (usually « open »)
  const outside = [cap.min - 1, cap.max + 1].filter((x) => x >= 0 && x <= 255 && (strobeHz(x, ch) ?? 0) <= maxHz);
  return outside.sort((a, b) => Math.abs(a - v) - Math.abs(b - v))[0] ?? v;
}

/** Applies constraints to a value; returns the new value. */
function enforce(v: number, c: { min?: number; max?: number; maxHz?: number; values?: number[]; forbidTags?: string[]; allowCapabilities?: string[] }, ch: FixtureChannel): number {
  const forbid = c.forbidTags;
  if (forbid?.length) v = avoidRanges(v, ch, (cap) => cap.tags.some((t) => forbid.includes(t)));
  const allow = c.allowCapabilities;
  if (allow?.length) {
    v = avoidRanges(v, ch, (cap) => {
      const kind = capabilityKind(cap);
      return kind !== "neutral" && !allow.includes(kind);
    });
  }
  if (c.maxHz !== undefined) v = limitHz(v, ch, c.maxHz);
  if (c.values?.length) v = c.values.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), c.values[0]!);
  if (c.min !== undefined && v < c.min) v = c.min;
  if (c.max !== undefined && v > c.max) v = c.max;
  return v;
}

/**
 * Duration bounds (`hold`): a channel at or above a rule's level for longer than its seconds is held
 * just under it until it comes down. `since` remembers, per fixture, channel and rule, when the
 * channel went above; that memory is the only state. Returns what it held.
 */
export function applyHolds(rules: Rule[], fx: ResolvedFixture, buffer: Uint8Array, now: number, since: Map<string, number>, zoneOfFixture?: (id: string) => string | undefined): Clamp[] {
  const holds = rules.filter((r) => r.hold);
  const clamps: Clamp[] = [];
  if (!holds.length) return clamps;
  fx.mode.channels.forEach((name, offset) => {
    const ch = fx.def.channels.get(name);
    const index = fx.patch.address - 1 + offset;
    if (!ch || index < 0 || index >= 512) return;
    for (const r of holds) {
      if (!ruleApplies(r, fx, ch, zoneOfFixture)) continue;
      const key = `${fx.patch.id}/${name}/${r.id}`;
      const v = buffer[index]!;
      if (v < r.hold!.above) {
        since.delete(key);
        continue;
      }
      const start = since.get(key) ?? (since.set(key, now), now);
      if (now - start > r.hold!.seconds * 1000) {
        buffer[index] = r.hold!.above - 1;
        clamps.push({ fixture: fx.patch.id, channel: name, from: v, to: r.hold!.above - 1, rule: r.id });
      }
    }
  });
  return clamps;
}

/**
 * Pan/tilt speed bounds (`maxDegPerSecond`): each axis moves toward what is asked no faster than the
 * slowest rule allows, in degrees of the fixture's travel. `last` remembers each axis' last value
 * and time (16-bit, 0..1). Returns what it slowed.
 */
export function applySpeeds(rules: Rule[], fx: ResolvedFixture, buffer: Uint8Array, now: number, last: Map<string, { v: number; t: number }>, zoneOfFixture?: (id: string) => string | undefined): Clamp[] {
  const clamps: Clamp[] = [];
  const speeds = rules.filter((r) => r.maxDegPerSecond);
  if (!speeds.length) return clamps;
  const base = fx.patch.address - 1;
  for (const [axis, ch, travel] of [["pan", fx.pan, fx.panMax], ["tilt", fx.tilt, fx.tiltMax]] as const) {
    if (!ch) continue;
    const name = fx.mode.channels[ch.coarse]!;
    const def = fx.def.channels.get(name);
    const limits = def ? speeds.filter((r) => ruleApplies(r, fx, def, zoneOfFixture)).map((r) => r.maxDegPerSecond!) : [];
    if (!limits.length) continue;
    const fine = ch.fine !== undefined;
    const v = fine ? ((buffer[base + ch.coarse] ?? 0) * 256 + (buffer[base + ch.fine!] ?? 0)) / 65535 : (buffer[base + ch.coarse] ?? 0) / 255;
    const key = `${fx.patch.id}/${axis}`;
    const prev = last.get(key);
    let out = v;
    if (prev) {
      const step = ((Math.min(...limits) / travel) * Math.max(0, now - prev.t)) / 1000;
      if (Math.abs(v - prev.v) > step) out = prev.v + Math.sign(v - prev.v) * step;
    }
    last.set(key, { v: out, t: now });
    if (out === v) continue;
    const before = buffer[base + ch.coarse]!;
    if (fine) {
      const v16 = Math.round(out * 65535);
      buffer[base + ch.coarse] = v16 >> 8;
      buffer[base + ch.fine!] = v16 & 255;
    } else buffer[base + ch.coarse] = Math.round(out * 255);
    clamps.push({ fixture: fx.patch.id, channel: name, from: before, to: buffer[base + ch.coarse]!, rule: speeds.find((r) => r.maxDegPerSecond === Math.min(...limits))!.id });
  }
  return clamps;
}

/**
 * Steady channels (`steadySeconds`): a value changes at most once every so many seconds; a change
 * asked sooner waits. `last` remembers each channel's value and when it last changed.
 */
export function applySteady(rules: Rule[], fx: ResolvedFixture, buffer: Uint8Array, now: number, last: Map<string, { v: number; t: number }>, zoneOfFixture?: (id: string) => string | undefined): Clamp[] {
  const clamps: Clamp[] = [];
  const steady = rules.filter((r) => r.steadySeconds);
  if (!steady.length) return clamps;
  fx.mode.channels.forEach((name, offset) => {
    const ch = fx.def.channels.get(name);
    const index = fx.patch.address - 1 + offset;
    if (!ch || index < 0 || index >= 512) return;
    const rule = steady.filter((r) => ruleApplies(r, fx, ch, zoneOfFixture)).sort((a, b) => b.steadySeconds! - a.steadySeconds!)[0];
    if (!rule) return;
    const key = `${fx.patch.id}/${name}`;
    const v = buffer[index]!;
    const prev = last.get(key);
    if (!prev || prev.v === v) {
      if (!prev) last.set(key, { v, t: now });
      return;
    }
    if (now - prev.t >= rule.steadySeconds! * 1000) last.set(key, { v, t: now });
    else {
      buffer[index] = prev.v;
      clamps.push({ fixture: fx.patch.id, channel: name, from: v, to: prev.v, rule: rule.id });
    }
  });
  return clamps;
}

/** Applies the effective rules to a fixture's channels in a DMX buffer; returns what was moved. */
export function applyRules(rules: Rule[], fx: ResolvedFixture, buffer: Uint8Array, zoneOfFixture?: (id: string) => string | undefined): Clamp[] {
  const clamps: Clamp[] = [];
  const byId = new Map(rules.map((r) => [r.id, r]));
  fx.mode.channels.forEach((name, offset) => {
    const ch = fx.def.channels.get(name);
    if (!ch) return;
    const eff = effectiveRule(rules, fx, ch, zoneOfFixture);
    if (!eff) return;
    const index = fx.patch.address - 1 + offset;
    if (index < 0 || index >= 512) return;
    const original = buffer[index]!;
    let v = enforce(original, eff, ch);
    let last = v !== original ? (Object.values(eff.from).at(-1) ?? "") : "";
    for (const id of eff.locked) {
      const before = v;
      v = enforce(v, byId.get(id)!, ch); // locked bounds cannot be relaxed
      if (v !== before) last = id;
    }
    if (v !== original) {
      buffer[index] = v;
      clamps.push({ fixture: fx.patch.id, channel: name, from: original, to: v, rule: last });
    }
  });
  return clamps;
}
