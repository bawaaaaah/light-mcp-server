/**
 * Venue and show commands: fixture library, patch, canvases, palettes, looks (go/stop), unified
 * groups (level, mute, flash), show settings, and « Panic neutre ».
 */
import { z } from "zod";
import type { CommandRegistry } from "./registry.js";
import type { DmxEngine } from "../engine/dmx-engine.js";
import { CanvasSchema, PatchedFixtureSchema } from "../venue/venue.js";
import { GroupSchema, LookSchema, PaletteSchema, ShowSettingsSchema } from "../show/model.js";
import type { ShowRuntime } from "../show/runtime.js";
import { RuleSchema } from "../rules/rules.js";

export function registerShowCommands(reg: CommandRegistry, engine: DmxEngine, show: ShowRuntime): void {
  const venue = show.venue;
  const id = z.object({ id: z.string() });

  // ---- venue
  reg.register({
    name: "venue.library",
    title: "Bibliothèque de fixtures",
    description: "Fixture definitions available (manufacturer, model, modes with channel count and heads).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({ search: z.string().optional() }),
    run: ({ search }) =>
      venue.definitions
        .filter((d) => !search || `${d.manufacturer} ${d.model}`.toLowerCase().includes(search.toLowerCase()))
        .map((d) => ({ manufacturer: d.manufacturer, model: d.model, type: d.type, modes: d.modes.map((m) => ({ name: m.name, channels: m.channels.length, heads: m.heads.length })) })),
  });
  reg.register({ name: "venue.fixture.list", title: "Patch", description: "Patched fixtures of the venue (address, mode, role, position).", right: "dashboards:view", readOnly: true, profiles: ["setup", "design"], schema: z.object({}), run: () => venue.fixtures.list() });
  reg.register({
    name: "venue.fixture.put",
    title: "Patcher une fixture",
    description: "Creates or updates a patched fixture (manufacturer/model/mode from the library, universe, 1-based address, role, tags, position).",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ fixture: PatchedFixtureSchema }),
    run: ({ fixture }) => {
      const saved = venue.fixtures.put(fixture);
      const r = venue.resolve(saved.id);
      return { fixture: saved, warning: "error" in r ? r.error : undefined };
    },
  });
  reg.register({ name: "venue.fixture.delete", title: "Dépatcher", description: "Removes a fixture from the patch.", right: "show:write", profiles: ["setup"], schema: id, run: ({ id: i }) => ({ deleted: venue.fixtures.delete(i) }) });
  reg.register({ name: "venue.canvas.list", title: "Canevas", description: "Canvases of the venue and their rendering onto fixtures.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design"], schema: z.object({}), run: () => venue.canvases.list() });
  reg.register({
    name: "venue.canvas.put",
    title: "Définir un canevas",
    description: "Creates or updates a canvas (topology, cell count) and its rendering onto the venue's fixtures (cell ranges → fixture heads).",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ canvas: CanvasSchema }),
    run: ({ canvas }) => venue.canvases.put(canvas),
  });

  // ---- palettes & looks
  reg.register({ name: "palette.list", title: "Palettes", description: "Colour palettes of the show.", right: "dashboards:view", readOnly: true, profiles: ["design"], schema: z.object({}), run: () => show.palettes.list() });
  reg.register({ name: "palette.put", title: "Palette", description: "Creates or updates a palette (used by reference: every look using it follows).", right: "show:write", profiles: ["design"], schema: z.object({ palette: PaletteSchema }), run: ({ palette }) => show.palettes.put(palette) });
  reg.register({ name: "look.list", title: "Looks", description: "Looks of the show (technique, canvas, palette, timing, flags) and whether they play.", right: "dashboards:view", readOnly: true, profiles: ["design", "live"], schema: z.object({}), run: () => show.looks.list().map((l) => ({ ...l, active: show.isActive(l.id) })) });
  reg.register({
    name: "look.put",
    title: "Look",
    description: "Creates or updates a look: technique (plat, damier, palette, creux, masques, masques-colores, respiration, orage, flamme, flash, pas), canvas, palette, timing (every beats|seconds, attack 0 claque..1 respire, order).",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ look: LookSchema }),
    run: ({ look }) => {
      if (!venue.canvases.get(look.canvas)) throw new Error(`canevas inconnu : ${look.canvas}`);
      return show.looks.put(look);
    },
  });
  reg.register({ name: "look.delete", title: "Supprimer un look", description: "Deletes a look.", right: "show:write", profiles: ["design"], schema: id, run: ({ id: i }) => (show.stop(i), { deleted: show.looks.delete(i) }) });
  reg.register({
    name: "look.go",
    title: "Lancer un look",
    description: "Starts a look (idempotent: starting a playing look does nothing); releases the other looks of its exclusive groups.",
    right: "commands:trigger",
    profiles: ["design", "live"],
    schema: id,
    run: ({ id: i }, ctx) => {
      const look = show.looks.get(i);
      if (look?.manualOnly && (ctx.origin === "timeline" || ctx.origin === "mcp")) throw new Error(`« ${look.name} » est en manuel seulement`);
      return show.go(i);
    },
  });
  reg.register({ name: "look.stop", title: "Arrêter un look", description: "Stops a look.", right: "commands:trigger", profiles: ["design", "live"], schema: id, run: ({ id: i }) => ({ stopped: show.stop(i) }) });
  reg.register({ name: "look.stopall", title: "Tout arrêter", description: "Stops every playing look.", right: "commands:trigger", profiles: ["live"], schema: z.object({}), run: () => ({ stopped: show.stopAll() }) });

  // ---- groups
  reg.register({ name: "group.list", title: "Groupes", description: "Groups (members, sub-groups, master, exclusive, limits) with their effective level.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => show.groups.list().map((g) => ({ ...g, effectiveLevel: show.effectiveLevel(g.id) })) });
  reg.register({ name: "group.put", title: "Groupe", description: "Creates or updates a unified group: members (fixtures, looks, sub-groups), selector, optional master, exclusive, limits, included/excluded presets.", right: "show:write", profiles: ["setup", "design"], schema: z.object({ group: GroupSchema }), run: ({ group }) => show.groups.put(group) });
  reg.register({ name: "group.delete", title: "Supprimer un groupe", description: "Deletes a group.", right: "show:write", profiles: ["setup"], schema: id, run: ({ id: i }) => ({ deleted: show.groups.delete(i) }) });
  const withMaster = (groupId: string, patch: { level?: number; mute?: boolean }) => {
    const g = show.groups.get(groupId);
    if (!g) throw new Error(`groupe inconnu : ${groupId}`);
    const master = { level: g.master?.level ?? 1, mute: g.master?.mute ?? false, ...patch };
    show.groups.put({ ...g, master });
    return { id: groupId, ...master, effectiveLevel: show.effectiveLevel(groupId) };
  };
  reg.register({ name: "group.level", title: "Niveau de groupe", description: "Sets a group master level (0..1); adds a master to the group if it has none.", right: "commands:level", profiles: ["live", "design"], schema: z.object({ id: z.string(), level: z.number().min(0).max(1) }), run: ({ id: i, level }) => withMaster(i, { level }) });
  reg.register({ name: "group.mute", title: "Mute de groupe", description: "Mutes or unmutes a group master (the level is kept).", right: "commands:level", profiles: ["live"], schema: z.object({ id: z.string(), mute: z.boolean() }), run: ({ id: i, mute }) => withMaster(i, { mute }) });
  reg.register({ name: "group.flash", title: "Flash de groupe", description: "Holds a group at 100 % while on.", right: "commands:trigger", profiles: ["live"], schema: z.object({ id: z.string(), on: z.boolean() }), run: ({ id: i, on }) => (show.setFlash(i, on), { id: i, flash: on }) });

  // ---- rules
  const where = z.enum(["venue", "show"]).default("show");
  const coll = (w: "venue" | "show") => (w === "venue" ? show.venueRules : show.rules);
  reg.register({ name: "rule.list", title: "Règles", description: "Rules of the venue and of the show (min/max, allowed values, forbidden capabilities like sound-active), and the values they moved on the last frame.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => ({ venue: show.venueRules.list(), show: show.rules.list(), clamps: show.lastClamps.slice(0, 100) }) });
  reg.register({ name: "rule.put", title: "Règle", description: "Creates or updates a rule. level: type (fixture model), venue or show; locked rules cannot be relaxed by more specific ones.", right: "show:write", profiles: ["setup"], schema: z.object({ where, rule: RuleSchema }), run: ({ where: w, rule }) => coll(w).put(rule) });
  reg.register({ name: "rule.delete", title: "Supprimer une règle", description: "Deletes a rule.", right: "show:write", profiles: ["setup"], schema: z.object({ where, id: z.string() }), run: ({ where: w, id: i }) => ({ deleted: coll(w).delete(i) }) });

  // ---- show settings & safety
  reg.register({ name: "show.settings", title: "Réglages du show", description: "Show settings: safe look recalled by « Panic neutre », grand master, default button mode.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => show.settings });
  reg.register({
    name: "show.settings.set",
    title: "Modifier les réglages du show",
    description: "Updates show settings (safeLook, grandMaster, defaultButtonMode).",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: ShowSettingsSchema.partial().omit({ schemaVersion: true, kind: true }),
    run: (patch) => {
      if (patch.safeLook && !show.looks.get(patch.safeLook)) throw new Error(`look inconnu : ${patch.safeLook}`);
      return show.saveSettings(patch);
    },
  });
  reg.register({
    name: "panic",
    title: "Panic neutre",
    description: "Safety: stops every look and the DMX console parks, then recalls the show's safe look; without a safe look it does a Blackout.",
    right: "commands:panic",
    profiles: ["setup", "design", "live"],
    schema: z.object({}),
    run: () => {
      show.stopAll();
      engine.release();
      const safe = show.settings.safeLook;
      if (safe && show.looks.get(safe)) {
        engine.setBlackout(false);
        show.go(safe);
        return { action: "safe-look", look: safe };
      }
      engine.setBlackout(true);
      return { action: "blackout", reason: "aucun look de secours défini" };
    },
  });
}
