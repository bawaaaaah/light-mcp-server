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
import type { CapabilityTag, FixtureChannel } from "../venue/qxf-import.js";
import type { ResolvedFixture } from "../venue/venue.js";

export const RuleSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  level: z.enum(["type", "venue", "show"]).default("show"),
  scope: z.object({ model: z.string().optional(), fixture: z.string().optional() }).default({}),
  target: z.object({
    channel: z.string().optional(),
    attribute: z.enum(["intensity", "color", "colorWheel", "pan", "tilt", "strobe", "effect", "speed", "maintenance", "other"]).optional(),
    color: z.string().optional(),
    tag: z.enum(["soundActive", "autoProgram", "builtinMacro", "strobe", "reset", "uv"]).optional(),
  }),
  min: z.number().int().min(0).max(255).optional(),
  max: z.number().int().min(0).max(255).optional(),
  values: z.array(z.number().int().min(0).max(255)).optional(),
  forbidTags: z.array(z.enum(["soundActive", "autoProgram", "builtinMacro", "strobe", "reset", "uv"])).optional(),
  locked: z.boolean().default(false),
  notes: z.string().optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

const LEVEL_RANK = { type: 0, venue: 1, show: 2 } as const;

export interface Clamp {
  fixture: string;
  channel: string;
  from: number;
  to: number;
  rule: string;
}

function ruleApplies(rule: Rule, fx: ResolvedFixture, ch: FixtureChannel): boolean {
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

/** Nearest value outside forbidden capability ranges. */
function avoidForbidden(value: number, ch: FixtureChannel, forbid: string[]): number {
  const bad = ch.capabilities.filter((c) => c.tags.some((t) => forbid.includes(t)));
  if (!bad.some((c) => value >= c.min && value <= c.max)) return value;
  const allowed = ch.capabilities.filter((c) => !c.tags.some((t) => forbid.includes(t)));
  if (allowed.length === 0) return 0;
  let best = allowed[0]!.min;
  for (const c of allowed) for (const v of [c.min, c.max]) if (Math.abs(v - value) < Math.abs(best - value)) best = v;
  return best;
}

/**
 * Effective rules for one channel: sorted from broad to specific; a locked rule blocks the
 * relaxations below it (its bounds are re-applied after the more specific ones).
 */
export function applyRules(rules: Rule[], fx: ResolvedFixture, buffer: Uint8Array): Clamp[] {
  const clamps: Clamp[] = [];
  const sorted = [...rules].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
  fx.mode.channels.forEach((name, offset) => {
    const ch = fx.def.channels.get(name);
    if (!ch) return;
    const applicable = sorted.filter((r) => ruleApplies(r, fx, ch));
    if (applicable.length === 0) return;
    const index = fx.patch.address - 1 + offset;
    if (index < 0 || index >= 512) return;
    const original = buffer[index]!;
    let v = original;
    let last = "";
    const enforce = (r: Rule) => {
      const before = v;
      if (r.forbidTags?.length) v = avoidForbidden(v, ch, r.forbidTags);
      if (r.values?.length) v = r.values.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), r.values[0]!);
      if (r.min !== undefined && v < r.min) v = r.min;
      if (r.max !== undefined && v > r.max) v = r.max;
      if (v !== before) last = r.id;
    };
    for (const r of applicable) enforce(r);
    for (const r of applicable.filter((x) => x.locked)) enforce(r); // locked bounds cannot be relaxed
    if (v !== original) {
      buffer[index] = v;
      clamps.push({ fixture: fx.patch.id, channel: name, from: original, to: v, rule: last });
    }
  });
  return clamps;
}
