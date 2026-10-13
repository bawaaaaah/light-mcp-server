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
import { DashboardSchema, defaultDashboard } from "../dashboards/dashboards.js";
import { describeStage, queryStage, ZoneSchema } from "../venue/stage.js";

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

  // ---- stage
  reg.register({ name: "stage.zone.list", title: "Zones", description: "Stage zones (type, floor height, tags, protected).", right: "dashboards:view", readOnly: true, profiles: ["setup", "design"], schema: z.object({}), run: () => show.zones.list() });
  reg.register({ name: "stage.zone.put", title: "Zone", description: "Creates or updates a zone: polygon in metres (X stage left→right, Y front→upstage), floor height, type (stage, riser, floor, audience, wall, pillar, truss…), tags, protected.", right: "show:write", profiles: ["setup"], schema: z.object({ zone: ZoneSchema }), run: ({ zone }) => show.zones.put(zone) });
  reg.register({ name: "stage.zone.delete", title: "Supprimer une zone", description: "Deletes a zone.", right: "show:write", profiles: ["setup"], schema: id, run: ({ id: i }) => ({ deleted: show.zones.delete(i) }) });
  reg.register({
    name: "stage.query",
    title: "Interroger la scène",
    description: "Finds fixtures by role, zone they are in, zone they aim at, tags; optionally sorted along x/y/z (for sweeps). Each result says why it matched.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({ role: z.string().optional(), inZone: z.string().optional(), aimingAt: z.string().optional(), tags: z.array(z.string()).optional(), sortBy: z.enum(["x", "y", "z"]).optional() }),
    run: (q) => queryStage(venue.fixtures.list(), show.zones.list(), q).map((r) => ({ id: r.fixture.id, name: r.fixture.name, role: r.fixture.role, zone: r.zone, position: r.fixture.position, why: r.why })),
  });
  reg.register({ name: "stage.describe", title: "Décrire la scène", description: "Plain-French description of the stage: zones, what is in them and what lights them.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design"], schema: z.object({}), run: () => describeStage(venue.fixtures.list(), show.zones.list()) });

  // ---- palettes & looks
  reg.register({ name: "palette.list", title: "Palettes", description: "Colour palettes of the show.", right: "dashboards:view", readOnly: true, profiles: ["design"], schema: z.object({}), run: () => show.palettes.list() });
  reg.register({ name: "palette.put", title: "Palette", description: "Creates or updates a palette (used by reference: every look using it follows).", right: "show:write", profiles: ["design"], schema: z.object({ palette: PaletteSchema }), run: ({ palette }) => show.palettes.put(palette) });
  reg.register({ name: "look.list", title: "Looks", description: "Looks of the show (technique, canvas, palette, timing, flags) and whether they play.", right: "dashboards:view", readOnly: true, profiles: ["design", "live"], schema: z.object({}), run: () => show.looks.list().map((l) => ({ ...l, active: show.isActive(l.id) })) });
  reg.register({
    name: "look.put",
    title: "Look",
    description: "Creates or updates a look: technique (plat, damier, palette, creux, masques, masques-colores, respiration, orage, flamme, flash, onde = waveform with phase spread/blocks/wings, pas), canvas, palette, timing (every beats|seconds, attack 0 claque..1 respire, order).",
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

  // ---- dashboards
  const dashboards = show.store.collection("dashboards", DashboardSchema);
  reg.register({
    name: "dashboard.list",
    title: "Dashboards",
    description: "Dashboards of the show (grid of widgets bound to looks, groups, songs, actions). Creates a default one from the show when none exists.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design", "live"],
    schema: z.object({}),
    run: () => {
      if (dashboards.list().length === 0) return [defaultDashboard(show.looks.list(), show.groups.list())];
      return dashboards.list();
    },
  });
  reg.register({ name: "dashboard.put", title: "Dashboard", description: "Creates or updates a dashboard (columns, widgets with grid position, target, mode, roles allowed).", right: "show:write", profiles: ["design"], schema: z.object({ dashboard: DashboardSchema }), run: ({ dashboard }) => dashboards.put(dashboard) });
  reg.register({ name: "dashboard.delete", title: "Supprimer un dashboard", description: "Deletes a dashboard.", right: "show:write", profiles: ["design"], schema: id, run: ({ id: i }) => ({ deleted: dashboards.delete(i) }) });
  reg.register({
    name: "dashboard.generate",
    title: "Générer un dashboard",
    description: "Builds a dashboard from the show (safety bar, one row of buttons per exclusive group, group faders) and saves it.",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ id: z.string().default("principal"), name: z.string().default("Principal") }),
    run: ({ id: i, name }) => dashboards.put({ ...defaultDashboard(show.looks.list(), show.groups.list()), id: i, name }),
  });

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
