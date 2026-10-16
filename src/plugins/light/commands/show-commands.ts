/**
 * Venue and show commands: fixture library, patch, canvases, palettes, looks (go/stop), unified
 * groups (level, mute, flash), show settings, and « Panic neutre ».
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TechniqueSchema } from "../engine/techniques.js";
import { displayHex } from "../engine/display.js";
import type { CommandRegistry } from "./registry.js";
import type { DmxEngine } from "../engine/dmx-engine.js";
import { CanvasSchema, PatchedFixtureSchema } from "../venue/venue.js";
import { GENERIC_DIMMER } from "../venue/qxf-import.js";
import { ChannelFaderSchema, GroupSchema, LookSchema, PaletteSchema, ShowSettingsSchema } from "../show/model.js";
import { slugify } from "../data/store.js";
import { swatchOf } from "../show/swatch.js";
import { inUseMessage, usesOf, type ReferenceKind, type ShowParts } from "../show/references.js";
import type { ShowRuntime } from "../show/runtime.js";
import { effectiveRule, RuleProgramSchema, RuleSchema } from "../rules/rules.js";
import { DashboardSchema, defaultDashboard } from "../dashboards/dashboards.js";
import { describeStage, queryStage, ZoneSchema, zoneOf } from "../venue/stage.js";

export function registerShowCommands(reg: CommandRegistry, engine: DmxEngine, show: ShowRuntime): void {
  const venue = show.venue;
  const id = z.object({ id: z.string() });
  /**
   * What uses a look, a group or a fader (show/references.ts). Songs and mappings are opened on
   * call: a store collection keeps the schema of its first opening, and the plugin opens those two
   * with their own schemas after these commands are registered.
   */
  const parts = (): ShowParts => ({
    groups: show.groups.list(),
    faders: show.faders.list(),
    mappings: show.store.collection("mappings", z.object({ id: z.string() }).passthrough()).list() as unknown as ShowParts["mappings"],
    dashboards: dashboards.list(),
    snapshots: show.snapshots.list(),
    songs: show.store.collection("songs", z.object({ id: z.string() }).passthrough()).list() as unknown as ShowParts["songs"],
    safeLook: show.settings.safeLook,
  });
  /** Deleting what is still used is refused (the error says where), unless `force`. */
  const removable = (kind: ReferenceKind, i: string, name: string | undefined, force: boolean) => {
    const uses = usesOf(kind, i, parts());
    if (uses.length && !force) throw new Error(inUseMessage(name ?? i, uses));
  };
  const deletable = z.object({ id: z.string(), force: z.boolean().default(false).describe("delete even if a group, fader, mapping, dashboard, snapshot or song still uses it") });

  /** Raw channels (fixture + offset) must exist: refused otherwise. */
  const checkChannels = (channels: { fixture: string; offset: number }[]) => {
    for (const c of channels) {
      const problem = venue.channelProblem(c);
      if (problem) throw new Error(problem);
    }
  };

  // ---- venue
  reg.register({
    name: "venue.library",
    title: "Bibliothèque de fixtures",
    description: "Fixture definitions available (manufacturer, model, modes with channel count and heads), the .qxf files then QLC+'s built-in generic dimmer.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({ search: z.string().optional() }),
    run: ({ search }) =>
      (venue.refreshDefinitions(), [...venue.definitions, GENERIC_DIMMER])
        .filter((d) => !search || `${d.manufacturer} ${d.model}`.toLowerCase().includes(search.toLowerCase()))
        .map((d) => ({ manufacturer: d.manufacturer, model: d.model, type: d.type, modes: d.modes.map((m) => ({ name: m.name, channels: m.channels.length, heads: m.heads.length })) })),
  });
  reg.register({ name: "venue.fixture.list", title: "Patch", description: "Patched fixtures of the venue (address, mode, role, position).", right: "dashboards:view", readOnly: true, profiles: ["setup", "design"], schema: z.object({}), run: () => venue.fixtures.list() });
  reg.register({
    name: "venue.fixture.channels",
    title: "Canaux des fixtures",
    description: "Channels of each patched fixture from its definition: offset (0-based from its address), name and attribute (intensity, color, strobe…). Fixtures without a definition have none (give offsets by hand).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({}),
    run: () =>
      venue.fixtures.list().map((f) => {
        const r = venue.resolve(f.id);
        const channels = "error" in r ? [] : r.mode.channels.map((name, offset) => ({ offset, name, attribute: r.def.channels.get(name)?.attribute ?? "other" }));
        return { id: f.id, name: f.name, channels };
      }),
  });
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
  reg.register({
    name: "venue.fixture.delete",
    title: "Dépatcher",
    description: "Removes a fixture from the patch. Returns what still refers to it (groups, channel faders, raw channels of looks, canvases), to fix by hand; `show.lint` reports them too.",
    right: "show:write",
    profiles: ["setup"],
    schema: id,
    run: ({ id: i }) => {
      const usedBy = [
        ...show.groups.list().filter((g) => g.members.fixtures.includes(i)).map((g) => `groupe ${g.name}`),
        ...show.faders.list().filter((f) => f.channels.some((c) => c.fixture === i)).map((f) => `fader ${f.name}`),
        ...show.looks.list().filter((l) => l.channels?.targets.some((c) => c.fixture === i)).map((l) => `look ${l.name}`),
        ...venue.canvases.list().filter((c) => c.render.some((r) => r.targets.some((t) => t.fixture === i))).map((c) => `canevas ${c.name}`),
      ];
      return { deleted: venue.fixtures.delete(i), usedBy };
    },
  });
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

  reg.register({
    name: "venue.canvas.auto",
    title: "Canevas automatique",
    description: "Builds a canvas from fixtures in the given order: one cell per head (or per fixture without heads). Topology line, line-mirror or ring.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ id: z.string(), name: z.string(), fixtures: z.array(z.string()).min(1), topology: z.enum(["line", "line-mirror", "ring"]).default("line") }),
    run: ({ id: cid, name, fixtures, topology }) => {
      const render: { from: number; to: number; targets: { fixture: string; head: number }[] }[] = [];
      let cell = 0;
      for (const fid of fixtures) {
        const r = venue.resolve(fid);
        if ("error" in r) throw new Error(r.error);
        const heads = r.mode.heads.length ? r.mode.heads.map((_, h) => h) : [-1];
        for (const h of heads) render.push({ from: cell, to: cell++, targets: [{ fixture: fid, head: h }] });
      }
      return venue.canvases.put({ id: cid, name, topology, cells: cell, render });
    },
  });

  // ---- palettes & looks
  reg.register({ name: "palette.list", title: "Palettes", description: "Colour palettes of the show.", right: "dashboards:view", readOnly: true, profiles: ["design"], schema: z.object({}), run: () => show.palettes.list() });
  reg.register({ name: "palette.put", title: "Palette", description: "Creates or updates a palette (used by reference: every look using it follows).", right: "show:write", profiles: ["design"], schema: z.object({ palette: PaletteSchema }), run: ({ palette }) => show.palettes.put(palette) });
  const swatch = (l: Parameters<typeof show.resolvedTechnique>[0]) => {
    try {
      return swatchOf(show.resolvedTechnique(l));
    } catch {
      return undefined; // a palette gone: no colour to show
    }
  };
  reg.register({ name: "look.list", title: "Looks", description: "Looks of the show (technique, canvas, palette, timing, flags), whether they play, and the colour that sums each up (swatch, for its button).", right: "dashboards:view", readOnly: true, profiles: ["design", "live"], schema: z.object({}), run: () => show.looks.list().map((l) => ({ ...l, active: show.isActive(l.id), swatch: swatch(l) })) });
  reg.register({
    name: "look.put",
    title: "Look",
    description: "Creates or updates a look: technique (plat, damier, palette, creux, masques, masques-colores, respiration, orage, flamme, flash, onde = waveform with phase spread/blocks/wings, pas, aucune = no colour), canvas, palette, optional raw channels (machines, lamps: targets fixture+offset and DMX values per step, stepped with the look), timing (every beats|seconds, attack 0 claque..1 respire, order), optional move for moving heads (shape fixe|cercle|huit|pan|tilt|tapis, center, size, every, spread, fan, group).",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ look: LookSchema }),
    run: ({ look }) => {
      if (!venue.canvases.get(look.canvas)) throw new Error(`canevas inconnu : ${look.canvas}`);
      // « jamais coupé » (noCut): only techniques that never switch a cell off
      if (look.noCut && show.stepsOf(look).some((step) => step.some((c) => c !== null && Object.values(c).every((v) => !v)))) {
        throw new Error(`« ${look.name} » est marqué « jamais coupé » mais sa technique éteint des cellules (pas noirs, masques sans plancher, flash…)`);
      }
      if (look.channels) {
        checkChannels(look.channels.targets);
        const bad = look.channels.steps.findIndex((row) => row.length !== look.channels!.targets.length);
        if (bad >= 0) throw new Error(`canaux bruts : le pas ${bad + 1} a ${look.channels.steps[bad]!.length} valeur(s) pour ${look.channels.targets.length} canal(aux)`);
      }
      return show.looks.put(look);
    },
  });
  reg.register({
    name: "look.techniques",
    title: "Techniques",
    description: "Every technique kind with the JSON schema of its parameters (for editors).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design"],
    schema: z.object({}),
    run: () => TechniqueSchema.options.map((o) => ({ kind: o.shape.kind.value, schema: zodToJsonSchema(o, { $refStrategy: "none" }) })),
  });
  reg.register({
    name: "look.preview",
    title: "Aperçu d'un look",
    description: "Steps a look (saved or not) generates on its canvas: one display colour per cell (\"#rrggbb\", null = untouched), with the canvas shape. Nothing is played.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design"],
    schema: z.object({ look: LookSchema }),
    run: ({ look }) => {
      const canvas = venue.canvases.get(look.canvas);
      if (!canvas) throw new Error(`canevas inconnu : ${look.canvas}`);
      return { cells: canvas.cells, topology: canvas.topology, columns: canvas.columns, steps: show.stepsOf(look).map((step) => step.map((c) => (c ? displayHex(c) : null))) };
    },
  });
  reg.register({
    name: "look.delete",
    title: "Supprimer un look",
    description: "Deletes a look. Refused while something uses it (see show.references), unless force.",
    right: "show:write",
    profiles: ["design"],
    schema: deletable,
    run: ({ id: i, force }) => (removable("look", i, show.looks.get(i)?.name, force), show.stop(i), { deleted: show.looks.delete(i) }),
  });
  reg.register({
    name: "look.go",
    title: "Lancer un look",
    description: "Starts a look (idempotent: starting a playing look does nothing); releases the other looks of its exclusive groups.",
    right: "commands:trigger",
    profiles: ["design", "live"],
    schema: id,
    run: ({ id: i }, ctx) => show.go(i, ctx.origin === "timeline" || ctx.origin === "mcp"),
  });
  reg.register({ name: "look.stop", title: "Arrêter un look", description: "Stops a look.", right: "commands:trigger", profiles: ["design", "live"], schema: id, run: ({ id: i }) => ({ stopped: show.stop(i) }) });
  reg.register({ name: "look.stopall", title: "Tout arrêter", description: "Stops every playing look.", right: "commands:trigger", profiles: ["live"], schema: z.object({}), run: () => ({ stopped: show.stopAll() }) });

  // ---- groups
  reg.register({ name: "group.list", title: "Groupes", description: "Groups (members, sub-groups, master, exclusive, limits) with their effective level.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => show.groups.list().map((g) => ({ ...g, effectiveLevel: show.effectiveLevel(g.id) })) });
  reg.register({ name: "group.put", title: "Groupe", description: "Creates or updates a unified group: members (fixtures, looks, sub-groups), selector, optional master, exclusive, limits, included/excluded presets.", right: "show:write", profiles: ["setup", "design"], schema: z.object({ group: GroupSchema }), run: ({ group }) => show.groups.put(group) });
  reg.register({
    name: "group.delete",
    title: "Supprimer un groupe",
    description: "Deletes a group. Refused while something uses it (sub-group, channel fader DCA, mapping, dashboard, snapshot, song), unless force.",
    right: "show:write",
    profiles: ["setup"],
    schema: deletable,
    run: ({ id: i, force }) => (removable("group", i, show.groups.get(i)?.name, force), { deleted: show.groups.delete(i) }),
  });
  reg.register({
    name: "show.references",
    title: "Où c'est utilisé",
    description: "Where a look, a group (DCA) or a channel fader is used: groups, channel faders, MIDI mappings, dashboards, snapshots, songs, safe state. Empty when nothing uses it.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({ kind: z.enum(["look", "group", "fader"]), id: z.string() }),
    run: ({ kind, id: i }) => ({ uses: usesOf(kind, i, parts()) }),
  });
  const withMaster = (groupId: string, patch: { level?: number; mute?: boolean }) => {
    const g = show.groups.get(groupId);
    if (!g) throw new Error(`groupe inconnu : ${groupId}`);
    const master = { level: g.master?.level ?? 1, mute: g.master?.mute ?? false, ...patch };
    show.groups.putLive({ ...g, master }); // a fader moves many times a second: no backup per move
    if (g.playback) show.syncPlayback(groupId);
    return { id: groupId, ...master, effectiveLevel: show.effectiveLevel(groupId) };
  };
  reg.register({ name: "group.level", title: "Niveau de groupe", description: "Sets a group master level (0..1); adds a master to the group if it has none.", right: "commands:level", profiles: ["live", "design"], schema: z.object({ id: z.string(), level: z.number().min(0).max(1) }), run: ({ id: i, level }) => withMaster(i, { level }) });
  reg.register({ name: "group.mute", title: "Mute de groupe", description: "Mutes or unmutes a group master (the level is kept).", right: "commands:level", profiles: ["live"], schema: z.object({ id: z.string(), mute: z.boolean() }), run: ({ id: i, mute }) => withMaster(i, { mute }) });
  reg.register({ name: "group.flash", title: "Flash de groupe", description: "Holds a group at 100 % while on.", right: "commands:trigger", profiles: ["live"], schema: z.object({ id: z.string(), on: z.boolean() }), run: ({ id: i, on }) => (show.setFlash(i, on), { id: i, flash: on }) });

  // ---- channel faders (white, UV, strobe, machines — like QLC+ « Level » sliders)
  reg.register({ name: "fader.list", title: "Faders de canaux", description: "Channel faders: raw channels (white, UV, strobe, machines…) driven at a level, highest-takes-precedence with the show.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => show.faders.list() });
  reg.register({
    name: "fader.put",
    title: "Fader de canaux",
    description: "Creates or updates a channel fader: name, channels as {fixture, offset from its address (0-based)}, level 0..1, optional dca (a group with a master whose level multiplies the fader's). The rules mask still applies after it.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ fader: ChannelFaderSchema }),
    run: ({ fader }) => {
      checkChannels(fader.channels);
      if (fader.dca && !show.groups.get(fader.dca)?.master) throw new Error(`DCA inconnu : ${fader.dca}`);
      return show.faders.put(fader);
    },
  });
  reg.register({
    name: "fader.delete",
    title: "Supprimer un fader de canaux",
    description: "Deletes a channel fader. Refused while something uses it (mapping, dashboard, snapshot, song), unless force.",
    right: "show:write",
    profiles: ["setup"],
    schema: deletable,
    run: ({ id: i, force }) => (removable("fader", i, show.faders.get(i)?.name, force), { deleted: show.faders.delete(i) }),
  });
  reg.register({
    name: "fader.level",
    title: "Niveau d'un fader de canaux",
    description: "Sets a channel fader's level (0..1).",
    right: "commands:level",
    profiles: ["live", "design"],
    schema: z.object({ id: z.string(), level: z.number().min(0).max(1) }),
    run: ({ id: i, level }) => {
      const f = show.faders.get(i);
      if (!f) throw new Error(`fader inconnu : ${i}`);
      return show.faders.putLive({ ...f, level });
    },
  });

  // ---- rules
  const where = z.enum(["venue", "show"]).default("show");
  const coll = (w: "venue" | "show") => (w === "venue" ? show.venueRules : show.rules);
  reg.register({ name: "rule.list", title: "Règles", description: "Rules of the venue and of the show (min/max, allowed values, forbidden capabilities like sound-active), and the values they moved on the last frame.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => ({ venue: show.venueRules.list(), show: show.rules.list(), clamps: show.lastClamps.slice(0, 100) }) });
  reg.register({ name: "rule.put", title: "Règle", description: "Creates or updates a rule. level: type (fixture model), venue or show; locked rules cannot be relaxed by more specific ones.", right: "show:write", profiles: ["setup"], schema: z.object({ where, rule: RuleSchema }), run: ({ where: w, rule }) => coll(w).put(rule) });
  reg.register({
    name: "rule.effective",
    title: "Règles en vigueur",
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
    description: "Creates or updates a rule program: name, MIDI Program Change (0-based like the MIDI byte; Live shows it +1, « #100 » = 99) and channel. A Program Change received on that channel activates it.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ program: RuleProgramSchema }),
    run: ({ program }) => {
      const clash = program.programChange !== undefined && show.programs.list().find((p) => p.id !== program.id && p.programChange === program.programChange && p.channel === program.channel);
      if (clash) throw new Error(`Program Change ${program.programChange} (canal ${program.channel}) déjà pris par « ${clash.name} »`);
      return show.programs.put(program);
    },
  });
  reg.register({
    name: "program.delete",
    title: "Supprimer un programme",
    description: "Deletes a rule program (its rules stay, unused, until reassigned).",
    right: "show:write",
    profiles: ["setup"],
    schema: id,
    run: ({ id: i }) => {
      if (show.activeProgram === i) show.selectProgram(undefined);
      return { deleted: show.programs.delete(i) };
    },
  });
  reg.register({
    name: "program.select",
    title: "Activer un programme",
    description: "Activates a rule program (or none, with id null): its rules apply from the next frame.",
    right: "commands:trigger",
    profiles: ["live", "design"],
    schema: z.object({ id: z.string().nullable() }),
    run: ({ id: i }) => ({ active: (show.selectProgram(i ?? undefined), show.activeProgram ?? null) }),
  });
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
      if (dashboards.list().length === 0) return [defaultDashboard(show.looks.list(), show.groups.list(), show.movingHeads().length > 0, show.faders.list())];
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
    run: ({ id: i, name }) => dashboards.put({ ...defaultDashboard(show.looks.list(), show.groups.list(), show.movingHeads().length > 0, show.faders.list()), id: i, name }),
  });

  // ---- versions: the copy kept of an object at each change (FolderStore history), put back on demand
  const VERSIONED = { looks: { coll: show.looks, put: "look.put", key: "look" }, groups: { coll: show.groups, put: "group.put", key: "group" }, faders: { coll: show.faders, put: "fader.put", key: "fader" }, dashboards: { coll: dashboards, put: "dashboard.put", key: "dashboard" } } as const;
  const versioned = z.enum(["looks", "groups", "faders", "dashboards"]);
  reg.register({
    name: "history.list",
    title: "Versions",
    description: "Earlier versions of a look, group, channel fader or dashboard (a copy is kept at each change and at deletion, so a deleted one is listed too), newest first: stamp and when it was replaced.",
    right: "show:write",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({ collection: versioned, id: z.string() }),
    run: ({ collection, id: i }) => VERSIONED[collection].coll.versions(i).slice(0, 100),
  });
  reg.register({
    name: "history.restore",
    title: "Restaurer une version",
    description: "Puts back an earlier version (stamp from history.list) through the usual put command and its checks; the current version goes to the history in turn, so a restore is undone the same way.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ collection: versioned, id: z.string(), stamp: z.string() }),
    run: async ({ collection, id: i, stamp }, ctx) => {
      const v = VERSIONED[collection];
      const old = v.coll.version(i, stamp) as { id?: string; master?: unknown; level?: unknown } | undefined;
      if (!old || old.id !== i) throw new Error(`version introuvable : ${collection}/${i} ${stamp}`);
      // a DCA's level and a fader's level are live state: putting back a design never moves the light
      const now = v.coll.get(i) as { master?: unknown; level?: unknown } | undefined;
      const restored = collection === "groups" && old.master && now?.master ? { ...old, master: now.master } : collection === "faders" && now ? { ...old, level: now.level } : old;
      return reg.invoke(v.put, { [v.key]: restored }, ctx);
    },
  });

  // ---- notes everywhere
  const noteCollections = () =>
    ({
      fixtures: venue.fixtures,
      canvases: venue.canvases,
      zones: show.zones,
      rules: show.rules,
      palettes: show.palettes,
      looks: show.looks,
      groups: show.groups,
      songs: show.store.collection("songs", z.object({ id: z.string() }).passthrough()),
      mappings: show.store.collection("mappings", z.object({ id: z.string() }).passthrough()),
      dashboards: dashboards,
    }) as Record<string, { list(): { id: string; name?: string; title?: string; label?: string; notes?: string }[]; get(id: string): unknown; put(v: unknown): unknown }>;
  reg.register({
    name: "notes.search",
    title: "Rechercher dans les notes",
    description: "Searches the notes attached to every object (fixtures, zones, looks, groups, songs, mappings, dashboards…). Empty query = every annotated object.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design", "live"],
    schema: z.object({ query: z.string().default("") }),
    run: ({ query }) => {
      const q = query.toLowerCase();
      const out: { collection: string; id: string; name: string; notes: string }[] = [];
      for (const [collection, c] of Object.entries(noteCollections())) {
        for (const o of c.list()) {
          if (!o.notes) continue;
          const name = o.name ?? o.title ?? o.label ?? o.id;
          if (!q || o.notes.toLowerCase().includes(q) || name.toLowerCase().includes(q)) out.push({ collection, id: o.id, name, notes: o.notes });
        }
      }
      return out;
    },
  });
  reg.register({
    name: "notes.set",
    title: "Écrire une note",
    description: "Sets (or clears with an empty text) the notes of any object: collection (fixtures, canvases, zones, rules, palettes, looks, groups, songs, mappings, dashboards) and id.",
    right: "show:write",
    profiles: ["setup", "design", "live"],
    schema: z.object({ collection: z.enum(["fixtures", "canvases", "zones", "rules", "palettes", "looks", "groups", "songs", "mappings", "dashboards"]), id: z.string(), notes: z.string() }),
    run: ({ collection, id: oid, notes }) => {
      const c = noteCollections()[collection]!;
      const obj = c.get(oid) as Record<string, unknown> | undefined;
      if (!obj) throw new Error(`${collection}/${oid} introuvable`);
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      return c.put({ ...obj, notes: notes ? `${notes}${/\(\d{4}-/.test(notes) ? "" : ` (${stamp})`}` : undefined });
    },
  });

  // ---- show settings & safety
  reg.register({ name: "show.settings", title: "Réglages du show", description: "Show settings: safe snapshot or safe look recalled by « Panic neutre », grand master, default button mode.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => show.settings });
  reg.register({
    name: "show.settings.set",
    title: "Modifier les réglages du show",
    description: "Updates show settings (safeSnapshot, safeLook, grandMaster, defaultButtonMode).",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: ShowSettingsSchema.partial().omit({ schemaVersion: true, kind: true }),
    run: (patch) => {
      if (patch.safeLook && !show.looks.get(patch.safeLook)) throw new Error(`look inconnu : ${patch.safeLook}`);
      if (patch.safeSnapshot && !show.snapshots.get(patch.safeSnapshot)) throw new Error(`instantané inconnu : ${patch.safeSnapshot}`);
      return show.saveSettings(patch);
    },
  });
  // ---- snapshots: the whole live state, saved ahead (the safe state of « Panic neutre »)
  reg.register({ name: "snapshot.list", title: "Instantanés", description: "Snapshots of the show: the whole live state saved ahead (looks playing, DCA levels and mutes, channel faders, grand master, rule program, Blackout).", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => show.snapshots.list() });
  reg.register({
    name: "snapshot.save",
    title: "Enregistrer un instantané",
    description: "Saves what plays now and every level as a snapshot (a new one, or over `id`).",
    right: "show:write",
    profiles: ["design", "live"],
    schema: z.object({ name: z.string().min(1), id: z.string().optional(), notes: z.string().optional() }),
    run: ({ name, id: given, notes }) => {
      let target = given ?? slugify(name);
      for (let i = 2; !given && show.snapshots.get(target); i++) target = `${slugify(name)}-${i}`;
      return show.snapshots.put({ id: target, name, notes, ...show.captureSnapshot(engine.isBlackout()) });
    },
  });
  reg.register({
    name: "snapshot.recall",
    title: "Rappeler un instantané",
    description: "Puts a snapshot back at once: only its looks play, its DCA, faders, grand master, program and Blackout are set. Objects deleted since are skipped and listed.",
    right: "commands:snapshot",
    profiles: ["live", "design"],
    schema: id,
    run: ({ id: i }) => {
      const snap = show.snapshots.get(i);
      if (!snap) throw new Error(`instantané inconnu : ${i}`);
      const done = show.applySnapshot(snap);
      engine.setBlackout(snap.blackout);
      return { id: i, ...done };
    },
  });
  reg.register({
    name: "snapshot.delete",
    title: "Supprimer un instantané",
    description: "Deletes a snapshot (and unsets it as the safe state).",
    right: "show:write",
    profiles: ["design"],
    schema: id,
    run: ({ id: i }) => {
      if (show.settings.safeSnapshot === i) show.saveSettings({ safeSnapshot: undefined });
      return { deleted: show.snapshots.delete(i) };
    },
  });

  reg.register({
    name: "panic",
    title: "Panic neutre",
    description:
      "Safety: stops every look, the DMX console parks and the manual head positions, then recalls the show's safe state: its safe snapshot (the whole state saved ahead), else its safe look, else a Blackout.",
    right: "commands:panic",
    profiles: ["setup", "design", "live"],
    schema: z.object({}),
    run: () => {
      show.stopAll();
      show.releasePositions();
      engine.release();
      const snap = show.settings.safeSnapshot ? show.snapshots.get(show.settings.safeSnapshot) : undefined;
      if (snap) {
        const done = show.applySnapshot(snap);
        engine.setBlackout(snap.blackout);
        return { action: "safe-snapshot", snapshot: snap.id, ...done };
      }
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
