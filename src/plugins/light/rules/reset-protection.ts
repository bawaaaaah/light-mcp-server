/**
 * Reset channel protection (docs/specs/rules-limits.md, « Protection du canal Reset »): a built-in
 * locked rule holds every range tagged `reset` (qxf-import.ts, capabilityTags) out of reach of looks,
 * faders, rules and the DMX console. A moving head that resets in the middle of a song swings
 * around and goes dark for seconds: only a voluntary reset (`fixture.reset`) lifts it, for one
 * fixture and a few seconds. The rule lives in the engine, not in a venue's files: it cannot be
 * deleted nor relaxed, and `rule.list` shows it. Pure.
 */
import { say } from "../../../core/lang.js";
import type { ResolvedFixture } from "../venue/venue.js";
import { RuleSchema, type Rule } from "./rules.js";

export const RESET_RULE_ID = "protection-reset";

/** How long a voluntary reset lifts the protection of its fixture: enough for the fixture to read the value. */
export const RESET_WINDOW_MS = 3000;

const BASE: Rule = RuleSchema.parse({ id: RESET_RULE_ID, level: "venue", target: { tag: "reset" }, forbidTags: ["reset"], locked: true, onViolation: "clamp" });

/** The built-in rule, named in the language of whoever reads it. */
export function resetProtectionRule(): Rule {
  return {
    ...BASE,
    name: say("Protection du canal Reset (intégrée)", "Reset channel protection (built in)"),
    notes: say(
      "Règle du moteur, ni supprimable ni modifiable : les plages Reset restent au repos pour les looks, les faders, les règles et la console. « Réinitialiser l'appareil » (fixture.reset) la lève quelques secondes pour un seul projecteur.",
      "Engine rule, neither deletable nor editable: Reset ranges stay at rest for looks, faders, rules and the console. « Reset the fixture » (fixture.reset) lifts it for a few seconds, for one fixture only.",
    ),
  };
}

/** A rule id that only the engine may use. */
export const isBuiltinRule = (id: string): boolean => id === RESET_RULE_ID;

/** The channels of a fixture carrying a Reset range, with the value that triggers it: the start of its first Reset range. */
export function resetChannels(fx: Pick<ResolvedFixture, "def" | "mode">): { offset: number; name: string; value: number }[] {
  return fx.mode.channels.flatMap((name, offset) => {
    const cap = fx.def.channels.get(name)?.capabilities.find((c) => c.tags.includes("reset"));
    return cap ? [{ offset, name, value: cap.min }] : [];
  });
}
