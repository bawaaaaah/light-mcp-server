/**
 * Rules (venue and show) and rule programs.
 * Part of the show commands (show-commands.ts registers them all, with the scope they share: show-command-scope.ts).
 */
import { z } from "zod";
import { effectiveRule, RuleProgramSchema, RuleSchema } from "../rules/rules.js";
import { isBuiltinRule } from "../rules/reset-protection.js";
import { zoneOf } from "../venue/stage.js";
import { say } from "../../../core/lang.js";
import type { ShowCommandScope } from "./show-command-scope.js";

export function registerRuleCommands(common: ShowCommandScope): void {
  const { reg, show, venue, idSchema } = common;
  // ---- rules
  const where = z.enum(["venue", "show"]).default("show");
  const rulesOf = (w: "venue" | "show") => (w === "venue" ? show.venueRules : show.rules);
  /** The engine's own rules (the Reset protection) are neither replaced nor deleted: their ids are reserved. */
  const refuseBuiltin = (ruleId: string): void => {
    if (isBuiltinRule(ruleId)) throw new Error(say(`la règle ${ruleId} est intégrée au moteur : ni modifiable ni supprimable`, `rule ${ruleId} is built into the engine: it can be neither edited nor deleted`));
  };
  reg.register({ name: "rule.list", title: "Règles", titleEn: "Rules", description: "Rules of the venue and of the show (min/max, allowed values, forbidden capabilities like sound-active), the engine's built-in ones (builtin: the Reset channel protection, locked, neither deletable nor editable: a Reset channel is held at rest, never at another maintenance range; fixture.reset lifts it on one fixture's channels for a few seconds), and the values they moved on the last frame.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => ({ builtin: show.builtinRules(), venue: show.venueRules.list(), show: show.rules.list(), clamps: show.lastClamps.slice(0, 100) }) });
  reg.register({ name: "rule.put", title: "Règle", titleEn: "Rule", hints: "DI", changes: ["rules"], description: "Creates or updates a rule. level: type (fixture model), venue or show; locked rules cannot be relaxed by more specific ones. maxHz bounds a strobe only where its definition gives frequencies in Hz (show.lint names the fixtures where it does nothing); hold bounds the time above a level, maxDegPerSecond the pan/tilt speed, steadySeconds how often a value may change, allowCapabilities the kinds of ranges allowed; onViolation (clamp, confirm, reject) says what a look launch does when the rule would bound it; appliesTo (origins such as mcp, roles) makes it a check on those callers' look launches instead of a bound on the output.", right: "show:write", profiles: ["setup"], schema: z.object({ where, rule: RuleSchema }), run: ({ where: w, rule }) => {
      refuseBuiltin(rule.id);
      return rulesOf(w).put(rule);
    },
  });
  reg.register({
    name: "rule.effective",
    title: "Règles en vigueur",
    titleEn: "Rules in force",
    description: "Effective rule on each channel of a fixture: every bound with the rule it comes from (most specific level and scope wins), plus the locked rules re-applied on top.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({ fixture: z.string(), program: z.string().optional() }),
    run: ({ fixture, program }) => {
      const r = venue.resolve(fixture);
      if ("error" in r) throw new Error(r.error);
      const rules = show.rulesInForce(program ?? show.activeProgram);
      const names = new Map(rules.map((x) => [x.id, x.name || x.id]));
      const zones = show.zones.list();
      const zoneById = (id: string) => {
        const f = venue.fixtures.get(id);
        return f ? zoneOf(f, zones)?.id : undefined;
      };
      return r.mode.channels.flatMap((name, offset) => {
        const ch = r.def.channels.get(name);
        const eff = ch && effectiveRule(rules, r, ch, zoneById);
        if (!eff) return [];
        const { from, locked, ...bounds } = eff;
        return [{ channel: name, dmx: r.patch.address + offset, attribute: ch.attribute, ...bounds, from: Object.fromEntries(Object.entries(from).map(([k, id]) => [k, names.get(id) ?? id])), locked: locked.map((id) => names.get(id) ?? id) }];
      });
    },
  });
  // ---- rule programs (one active at a time: « prière », « annonces »…)
  reg.register({
    name: "program.list",
    title: "Programmes de règles",
    titleEn: "Rule programs",
    description: "Rule programs (name, MIDI Program Change number 0-based and channel) and the active one. Rules tagged with a program apply only while it is active.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design", "live"],
    schema: z.object({}),
    run: () => ({ active: show.activeProgram ?? null, programs: show.programs.list() }),
  });
  reg.register({
    name: "program.put",
    title: "Programme de règles",
    titleEn: "Rule program",
    hints: "DI",
    changes: ["rules"],
    description: "Creates or updates a rule program: name, MIDI Program Change (0-based like the MIDI byte; Live shows it +1, « #100 » = 99) and channel. A Program Change received on that channel activates it.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ program: RuleProgramSchema }),
    run: ({ program }) => {
      const clash = program.programChange !== undefined && show.programs.list().find((p) => p.id !== program.id && p.programChange === program.programChange && p.channel === program.channel);
      if (clash) throw new Error(say(`Program Change ${program.programChange} (canal ${program.channel}) déjà pris par « ${clash.name} »`, `Program Change ${program.programChange} (channel ${program.channel}) already taken by “${clash.name}”`));
      return show.programs.put(program);
    },
  });
  reg.register({
    name: "program.delete",
    title: "Supprimer un programme",
    titleEn: "Delete a program",
    hints: "DI",
    changes: ["rules"],
    description: "Deletes a rule program (its rules stay, unused, until reassigned).",
    right: "show:write",
    profiles: ["setup"],
    schema: idSchema,
    run: ({ id: i }) => {
      if (show.activeProgram === i) show.selectProgram(undefined);
      return { deleted: show.programs.delete(i) };
    },
  });
  reg.register({
    name: "program.select",
    title: "Activer un programme",
    titleEn: "Activate a program",
    hints: "I",
    changes: ["rules"],
    description: "Activates a rule program (or none, with id null): its rules apply from the next frame.",
    right: "commands:trigger",
    profiles: ["live", "design"],
    schema: z.object({ id: z.string().nullable() }),
    run: ({ id: i }) => ({ active: (show.selectProgram(i ?? undefined), show.activeProgram ?? null) }),
  });
  reg.register({ name: "rule.delete", title: "Supprimer une règle", titleEn: "Delete a rule", hints: "DI", changes: ["rules"], description: "Deletes a rule. The engine's built-in ones cannot be; a stored rule bearing a reserved id (saved before it was reserved) can.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ where, id: z.string() }),
    run: ({ where: w, id: i }) => {
      if (!rulesOf(w).get(i)) refuseBuiltin(i);
      return { deleted: rulesOf(w).delete(i) };
    },
  });
}
