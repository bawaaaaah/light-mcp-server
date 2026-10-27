/**
 * Venue and show commands: fixture library, patch, canvases, palettes, looks (go/stop), unified
 * groups (level, mute, flash), show settings, and « Panic neutre ».
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TechniqueSchema } from "../engine/techniques.js";
import { displayHex } from "../engine/display.js";
import { CommandError, type CommandRegistry } from "./registry.js";
import type { DmxEngine } from "../engine/dmx-engine.js";
import { CanvasSchema, PatchedFixtureSchema } from "../venue/venue.js";
import { GENERIC_DIMMER } from "../venue/qxf-import.js";
import { ChannelFaderSchema, FaderSmoothingSchema, GroupSchema, LookSchema, PaletteSchema, ShowSettingsSchema } from "../show/model.js";
import { slugify } from "../data/store.js";
import { swatchOf } from "../show/swatch.js";
import { exclusiveMoves, nextExclusiveName } from "../show/exclusive.js";
import { inUseMessage, usesOf, type ReferenceKind, type ShowParts } from "../show/references.js";
import type { ShowRuntime } from "../show/runtime.js";
import { effectiveRule, RuleProgramSchema, RuleSchema } from "../rules/rules.js";
import { DashboardSchema, defaultDashboard } from "../dashboards/dashboards.js";
import { describeStage, queryStage, ZoneSchema, zoneOf } from "../venue/stage.js";
import { FACING_NAMES, facingOf, orientTo, wrapYaw } from "../venue/orientation.js";
import { arrangeAlong, EDGES, mountHeight } from "../venue/arrange.js";
import { diff } from "../data/diff.js";
import { say } from "../../../core/lang.js";

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
  reg.register({
    name: "venue.fixture.list",
    title: "Patch",
    description: "Patched fixtures of the venue (address, mode, role, position, orientation; facing names the orientation when it is one of venue.fixture.orient's).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({}),
    run: () =>
      venue.fixtures.list().map((f) => {
        const facing = facingOf(f.orientation);
        return facing ? { ...f, facing } : f;
      }),
  });
  reg.register({
    name: "venue.fixture.channels",
    title: "Canaux des fixtures",
    description:
      "Channels of each patched fixture (with its universe, start address, type and marker colour) from its definition: offset (0-based from its address), name, attribute (intensity, color, strobe…), colour component of a colour channel and, for a channel cut into functions, its named ranges (min, max, name: a mode, a colour preset, a macro). Fixtures without a definition have none (give offsets by hand).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({}),
    run: () =>
      venue.fixtures.list().map((f) => {
        const r = venue.resolve(f.id);
        const channels =
          "error" in r
            ? []
            : r.mode.channels.map((name, offset) => {
                const ch = r.def.channels.get(name);
                const caps = ch?.capabilities ?? [];
                return { offset, name, attribute: ch?.attribute ?? "other", ...(ch?.color ? { color: ch.color } : {}), ...(caps.length > 1 ? { ranges: caps.map(({ min, max, name: n }) => ({ min, max, name: n })) } : {}) };
              });
        return { id: f.id, name: f.name, universe: f.universe, address: f.address, ...(f.color ? { color: f.color } : {}), ...("error" in r ? {} : { type: r.def.type }), channels };
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
      // patched anyway (two lamps on one address can be wanted), but said at once
      const warnings = ["error" in r ? r.error : "", ...venue.patchProblems(saved.id).map((o) => o.message)].filter(Boolean);
      return { fixture: saved, warning: warnings.length ? warnings.join(" ; ") : undefined };
    },
  });
  reg.register({
    name: "venue.fixture.orient",
    title: "Orienter une fixture",
    description:
      "Where a fixture points at rest, for the stage plan and moving-head aiming: facing audience, upstage (the wall behind the stage), houseLeft (jardin, the audience's left), houseRight (cour, the audience's right), ceiling or floor (these two keep the heading); or yaw (degrees: 0 audience, 90 cour, 180 upstage, -90 jardin) and pitch (-90 floor .. 90 ceiling); or turn, degrees added to the heading. A moving head pointed at the floor hangs, at the ceiling stands. roll turns the body around its beam: 0 a bar lies across, 90 it stands (its first head at the bottom).",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: z.string(), facing: z.enum(FACING_NAMES).optional(), yaw: z.number().optional(), pitch: z.number().min(-90).max(90).optional(), turn: z.number().optional(), roll: z.number().min(-180).max(180).optional() }),
    run: ({ id: fixtureId, facing, yaw, pitch, turn, roll }) => {
      const f = venue.fixtures.get(fixtureId);
      if (!f) throw new Error(say(`fixture inconnue : ${fixtureId}`, `unknown fixture: ${fixtureId}`));
      let o = { yaw: f.orientation?.yaw ?? 0, pitch: f.orientation?.pitch ?? 0 };
      if (facing) o = orientTo(o, facing);
      if (yaw !== undefined) o.yaw = yaw;
      if (pitch !== undefined) o.pitch = pitch;
      if (turn !== undefined) o.yaw += turn;
      const orientation = { invertPan: false, invertTilt: false, swapPanTilt: false, panOffset: 0, tiltOffset: 0, ...f.orientation, yaw: wrapYaw(o.yaw), pitch: o.pitch, ...(roll !== undefined ? { roll } : {}) };
      const saved = venue.fixtures.put({ ...f, orientation });
      return { fixture: saved, facing: facingOf(saved.orientation) };
    },
  });
  reg.register({
    name: "venue.fixture.mark",
    title: "Nommer ou colorer une fixture",
    description:
      "Renames a patched fixture and/or gives it a colour to tell it at a glance in the patch, on the stage and in the channel trees (#rrggbb; null removes it). The colour is never sent to the fixture. Its id, address and everything else stay.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: z.string(), name: z.string().trim().min(1).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional() }),
    run: ({ id: fixtureId, name, color }) => {
      const f = venue.fixtures.get(fixtureId);
      if (!f) throw new Error(say(`fixture inconnue : ${fixtureId}`, `unknown fixture: ${fixtureId}`));
      const { color: _old, ...rest } = f;
      const next = { ...rest, ...(name !== undefined ? { name } : {}), ...(color === null ? {} : (color ?? _old) ? { color: (color ?? _old)!.toLowerCase() } : {}) };
      return { fixture: venue.fixtures.put(next) };
    },
  });
  reg.register({
    name: "venue.fixture.arrange",
    title: "Placer des fixtures",
    description:
      "Places several fixtures at once, evenly spaced along one edge of a zone in the order given: front (the edge on the audience side), back, houseLeft (jardin side) or houseRight (cour side), from jardin to cour or from the front to the back; middle runs across the zone. height: metres above the zone floor (default from each mount: 5 hung, 1.8 on a stand, 3 on a wall, 0.3 on the floor); facing turns them all (as venue.fixture.orient).",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ fixtures: z.array(z.string()).min(1), zone: z.string(), edge: z.enum(EDGES).default("front"), height: z.number().min(0).max(30).optional(), facing: z.enum(FACING_NAMES).optional() }),
    run: ({ fixtures: ids, zone: zoneId, edge, height, facing }) => {
      const zone = show.zones.get(zoneId);
      if (!zone) throw new Error(say(`zone inconnue : ${zoneId}`, `unknown zone: ${zoneId}`));
      const missing = ids.filter((i) => !venue.fixtures.get(i));
      if (missing.length) throw new Error(say(`fixture inconnue : ${missing.join(", ")}`, `unknown fixture: ${missing.join(", ")}`));
      const points = arrangeAlong(zone.polygon, edge, ids.length);
      return ids.map((i, k) => {
        const f = venue.fixtures.get(i)!;
        // hung fixtures hang from the rig whatever the floor; the others stand on the zone
        const z = height !== undefined ? zone.floorHeight + height : mountHeight(f.mount) + (f.mount === "hung" || f.mount === "truss" || f.mount === "ceiling" ? 0 : zone.floorHeight);
        const orientation = facing ? { invertPan: false, invertTilt: false, swapPanTilt: false, panOffset: 0, tiltOffset: 0, ...f.orientation, ...orientTo(f.orientation, facing) } : f.orientation;
        const saved = venue.fixtures.put({ ...f, position: { ...points[k]!, z: Math.round(z * 10) / 10 }, ...(orientation ? { orientation } : {}) });
        return { id: i, position: saved.position, ...(orientation ? { facing: facingOf(saved.orientation) } : {}) };
      });
    },
  });
  reg.register({
    name: "dmx.explain",
    title: "Pourquoi ce canal",
    description: "Why a DMX channel has its value: output value, forcing from the DMX console, the fixture and channel it belongs to, the grand master and the DCAs dosing that fixture (own and effective levels), the channel faders and raw-channel looks writing it, and the rules that bounded it on the last frame.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design", "live"],
    schema: z.object({ universe: z.number().int().min(1), channel: z.number().int().min(1).max(512) }),
    run: ({ universe, channel }) => {
      engine.output.check(universe, channel); // an unknown universe is an error, not an empty answer
      return { universe, channel, value: engine.output.get(universe)[channel - 1] ?? 0, parked: engine.parked(universe)[channel], ...show.explainChannel(universe, channel) };
    },
  });
  reg.register({
    name: "venue.patch.check",
    title: "Vérifier le patch",
    description: "The patch's problems: fixtures whose DMX channels overlap (two of the same model and mode on one address, wired as twins, are not reported) with the shared channels and a sentence, and fixtures without a definition in the library (their channels are not decoded: add the .qxf).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({}),
    run: () => ({ overlaps: venue.patchProblems(), missingDefinitions: venue.missingDefinitions() }),
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
  reg.register({ name: "stage.describe", title: "Décrire la scène", description: "Plain-French description of the stage: zones, what is in them, what lights them, and where the oriented fixtures point.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design"], schema: z.object({}), run: () => describeStage(venue.fixtures.list(), show.zones.list()) });

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
  reg.register({
    name: "look.list",
    title: "Looks",
    description: "Looks of the show (technique, canvas, palette, timing, flags), whether they play, and the colour that sums each up (swatch, for its button). Brief by default: what only editing needs (technique parameters and steps, raw channels, move details, notes) is left out, since an imported show's exact steps weigh about a megabyte; look.get gives one look whole, brief: false every look whole.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design", "live"],
    schema: z.object({ brief: z.boolean().default(true) }),
    run: ({ brief }) =>
      show.looks.list().map((l) => {
        const extra = { active: show.isActive(l.id), swatch: swatch(l) };
        if (!brief) return { ...l, ...extra };
        const { technique, channels: _c, move, notes: _n, ...rest } = l;
        // partial: look.put refuses it, so a list → edit → put round trip cannot drop the steps or raw channels
        return { ...rest, technique: { kind: technique.kind }, ...(move ? { move: { shape: move.shape } } : {}), ...extra, partial: true };
      }),
  });
  reg.register({
    name: "look.get",
    title: "Look",
    description: "One look whole (technique with its parameters and steps, raw channels, move, notes), whether it plays, and its swatch.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design"],
    schema: id,
    run: ({ id: i }) => {
      const l = show.looks.get(i);
      if (!l) throw new Error(say(`look inconnu : ${i}`, `unknown look: ${i}`));
      return { ...l, active: show.isActive(l.id), swatch: swatch(l) };
    },
  });
  reg.register({
    name: "look.put",
    title: "Look",
    description: "Creates or updates a look: technique (plat, damier, palette (random: each block draws its colour at random), creux, masques, masques-colores, respiration, orage, flamme, flash, onde = waveform with phase spread/blocks/wings/shuffle, pas, aucune = no colour), canvas, palette, optional raw channels (machines, lamps: targets fixture+offset and DMX values per step, stepped with the look), timing (every beats|seconds, attack 0 claque..1 respire, order), optional move for moving heads (shape fixe|cercle|huit|pan|tilt|tapis|aleatoire = a new point drawn in the box every cycle, center, size, every, spread, wings, reverse, shuffle = phases in a shuffled order, fan, group).",
    right: "show:write",
    profiles: ["design"],
    // a look from the brief list (partial) is refused before anything else: saved, it would lose its steps or raw channels
    schema: z.object({
      look: z.preprocess(
        (v, ctx) => {
          if (v && typeof v === "object" && (v as { partial?: unknown }).partial === true) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: say("look partiel (liste résumée, sans ses pas ni ses canaux) : le lire entier avec look.get avant de le modifier", "partial look (brief list, without its steps or channels): read it whole with look.get before changing it") });
            return z.NEVER;
          }
          return v;
        },
        LookSchema,
      ),
    }),
    run: ({ look }) => {
      if (!venue.canvases.get(look.canvas)) throw new Error(say(`canevas inconnu : ${look.canvas}`, `unknown canvas: ${look.canvas}`));
      // « jamais coupé » (noCut): only techniques that never switch a cell off
      if (look.noCut && show.stepsOf(look).some((step) => step.some((c) => c !== null && Object.values(c).every((v) => !v)))) {
        throw new Error(say(`« ${look.name} » est marqué « jamais coupé » mais sa technique éteint des cellules (pas noirs, masques sans plancher, flash…)`, `“${look.name}” is marked “never cut” but its technique turns cells off (black steps, masks without a floor, flash…)`));
      }
      if (look.channels) {
        checkChannels(look.channels.targets);
        const bad = look.channels.steps.findIndex((row) => row.length !== look.channels!.targets.length);
        if (bad >= 0) throw new Error(say(`canaux bruts : le pas ${bad + 1} a ${look.channels.steps[bad]!.length} valeur(s) pour ${look.channels.targets.length} canal(aux)`, `raw channels: step ${bad + 1} has ${look.channels.steps[bad]!.length} value(s) for ${look.channels.targets.length} channel(s)`));
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
      if (!canvas) throw new Error(say(`canevas inconnu : ${look.canvas}`, `unknown canvas: ${look.canvas}`));
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
    description:
      "Starts a look (idempotent: starting a playing look does nothing); releases the other looks of its exclusive groups. A rule set to reject refuses it when it would bound it; one set to confirm asks first: tell the user which rule and why, and send confirm: true only on their yes.",
    right: "commands:trigger",
    profiles: ["design", "live"],
    schema: z.object({ id: z.string(), confirm: z.boolean().default(false).describe("the user agreed to launch it although a confirm rule bounds it") }),
    run: ({ id: i, confirm }, ctx) => {
      // rules that refuse or ask rather than clamp (rules-limits.md, onViolation)
      const bounds = show.strictBounds(i, { origin: ctx.origin, ...(ctx.role ? { role: ctx.role } : {}) });
      const named = (list: typeof bounds) => list.map((b) => `${b.rule.name || b.rule.id} (${[...new Set(b.clamps.map((c) => c.fixture))].join(", ")})`).join(" ; ");
      const rejected = bounds.filter((b) => b.rule.onViolation === "reject");
      if (rejected.length) throw new CommandError("failed", say(`look refusé : la règle ${named(rejected)} le bornerait`, `look refused: rule ${named(rejected)} would bound it`), { rules: rejected.map((b) => b.rule.id) });
      const asking = bounds.filter((b) => b.rule.onViolation === "confirm");
      if (asking.length && !confirm) {
        const canAnswer = ctx.origin === "ui" || ctx.origin === "mcp" || ctx.origin === "cli";
        throw new CommandError(
          "failed",
          canAnswer ? say(`la règle ${named(asking)} bornerait ce look : le lancer quand même ?`, `rule ${named(asking)} would bound this look: launch it anyway?`) : say(`look non lancé : la règle ${named(asking)} demande une confirmation`, `look not launched: rule ${named(asking)} asks for a confirmation`),
          { confirm: canAnswer, rules: asking.map((b) => b.rule.id) },
        );
      }
      return show.go(i, ctx.origin === "timeline" || ctx.origin === "mcp" || ctx.origin === "ableset");
    },
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
    name: "look.exclusive",
    title: "Groupe exclusif d'un look",
    description:
      "Puts looks in one exclusive group, as radio buttons: starting one releases only the others of that group, never those of another exclusive group. Takes them out of their other exclusive groups. `group`: an exclusive group's id; `create`: a new exclusive group (its name, or « Exclusif n »); neither: in no exclusive group.",
    right: "show:write",
    profiles: ["design", "live"],
    schema: z.object({ looks: z.array(z.string()).min(1), group: z.string().optional(), create: z.object({ name: z.string().optional() }).optional() }),
    run: ({ looks, group, create }) => {
      for (const l of looks) if (!show.looks.get(l)) throw new CommandError("invalid", say(`look inconnu : ${l}`, `unknown look: ${l}`));
      let target = group;
      if (create) {
        const name = create.name?.trim() || nextExclusiveName(show.groups.list(), say("Exclusif", "Exclusive"));
        const base = slugify(name);
        let id = base;
        for (let k = 2; show.groups.get(id); k++) id = `${base}-${k}`;
        show.groups.put(GroupSchema.parse({ id, name, exclusive: true }));
        target = id;
      } else if (target !== undefined && !show.groups.get(target)?.exclusive) {
        throw new CommandError("invalid", say(`pas un groupe exclusif : ${target}`, `not an exclusive group: ${target}`));
      }
      const changed = exclusiveMoves(show.groups.list(), looks, target);
      for (const g of changed) show.groups.put(g);
      return { group: target ?? null, changed: changed.map((g) => g.id) };
    },
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
    if (!g) throw new Error(say(`groupe inconnu : ${groupId}`, `unknown group: ${groupId}`));
    const master = { ...g.master, level: g.master?.level ?? 1, mute: g.master?.mute ?? false, ...patch };
    show.groups.putLive({ ...g, master }); // a fader moves many times a second: no backup per move
    if (g.playback) show.syncPlayback(groupId);
    return { id: groupId, level: master.level, mute: master.mute, effectiveLevel: show.effectiveLevel(groupId) };
  };
  reg.register({ name: "group.level", title: "Niveau de groupe", description: "Sets a group master level (0..1); adds a master to the group if it has none.", right: "commands:level", profiles: ["live", "design"], schema: z.object({ id: z.string(), level: z.number().min(0).max(1) }), run: ({ id: i, level }) => withMaster(i, { level }) });
  reg.register({
    name: "grandmaster.set",
    title: "Grand master",
    description: "Sets the grand master (0..1): it doses every fixture's intensity above all the DCAs. Kept with the show.",
    right: "commands:level",
    profiles: ["live", "design"],
    schema: z.object({ level: z.number().min(0).max(1) }),
    run: ({ level }) => ({ grandMaster: show.saveSettings({ grandMaster: level }).grandMaster }),
  });
  // Live touch-ups by AI (docs/specs/mcp.md, « Profil live »): small steps, within the rules, while the desk allows it.
  const LIVE_STEP = 0.25;
  reg.register({
    name: "live.adjust",
    title: "Retouche en direct",
    description:
      "Live touch-ups during the service, for an AI client, within the rules and the DCA limits, without asking each time — only while the show's « IA en live » setting (liveAi) is on, off by default. One call: a DCA level by a small step (delta up to ±0.25, or a level at most 0.25 from the current one) and its mute, a look started or stopped (never a manual-only or danger look; rules that refuse or ask still do). Returns what was done and what plays now.",
    right: "commands:level",
    profiles: ["live"],
    schema: z
      .object({
        dca: z.object({ id: z.string(), delta: z.number().min(-LIVE_STEP).max(LIVE_STEP).optional(), level: z.number().min(0).max(1).optional(), mute: z.boolean().optional() }).optional(),
        go: z.string().optional().describe("look to start"),
        stop: z.string().optional().describe("look to stop"),
      })
      .refine((a) => a.dca || a.go || a.stop, { message: "dca, go ou stop" }),
    run: async ({ dca, go, stop }, ctx) => {
      if (!show.settings.liveAi) throw new Error(say("IA en live désactivée : l'activer dans les réglages du show (page Show, « IA en live »)", "live AI is off: switch it on in the show settings (Show page, « Live AI »)"));
      const done: string[] = [];
      if (dca) {
        const g = show.groups.get(dca.id);
        if (!g?.master) throw new Error(say(`DCA inconnu : ${dca.id}`, `unknown DCA: ${dca.id}`));
        const now = g.master.level;
        const level = Math.min(1, Math.max(0, dca.level ?? now + (dca.delta ?? 0)));
        if (Math.abs(level - now) > LIVE_STEP + 1e-9) throw new Error(say(`pas plus de ${LIVE_STEP * 100} % d'un coup en direct (${g.name} est à ${Math.round(now * 100)} %)`, `no more than ${LIVE_STEP * 100} % at once live (${g.name} is at ${Math.round(now * 100)} %)`));
        if (level !== now) {
          await reg.invoke("group.level", { id: dca.id, level }, ctx);
          done.push(`${g.name} ${Math.round(now * 100)} → ${Math.round(level * 100)} %`);
        }
        if (dca.mute !== undefined && dca.mute !== g.master.mute) {
          await reg.invoke("group.mute", { id: dca.id, mute: dca.mute }, ctx);
          done.push(`${g.name} ${dca.mute ? "mute" : say("rétabli", "unmuted")}`);
        }
      }
      if (stop) {
        await reg.invoke("look.stop", { id: stop }, ctx);
        done.push(say(`arrêt de ${stop}`, `${stop} stopped`));
      }
      if (go) {
        const look = show.looks.get(go);
        if (look?.manualOnly || look?.danger) throw new Error(say(`« ${look.name} » est réservé à la main (${look.danger ? "danger" : "manuel seulement"})`, `“${look.name}” is for a human hand (${look.danger ? "danger" : "manual only"})`));
        await reg.invoke("look.go", { id: go }, ctx);
        done.push(say(`lancement de ${go}`, `${go} started`));
      }
      return { done, playing: show.activeLooks(), dca: dca ? { id: dca.id, ...show.groups.get(dca.id)!.master, effectiveLevel: show.effectiveLevel(dca.id) } : undefined };
    },
  });
  reg.register({ name: "group.mute", title: "Mute de groupe", description: "Mutes or unmutes a group master (the level is kept).", right: "commands:level", profiles: ["live"], schema: z.object({ id: z.string(), mute: z.boolean() }), run: ({ id: i, mute }) => withMaster(i, { mute }) });
  reg.register({ name: "group.flash", title: "Flash de groupe", description: "Holds a group at 100 % while on.", right: "commands:trigger", profiles: ["live"], schema: z.object({ id: z.string(), on: z.boolean() }), run: ({ id: i, on }) => (show.setFlash(i, on), { id: i, flash: on }) });

  // ---- channel faders (white, UV, strobe, machines — like QLC+ « Level » sliders)
  reg.register({ name: "fader.list", title: "Faders de canaux", description: "Channel faders: raw channels (white, UV, strobe, machines…) driven at a level, highest-takes-precedence with the show; on a fixture's dimmer the fader doses it instead (the show holds dimmers at full; at 0 the fixture is dark). A fader dosed by a DCA (dca) follows it.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => show.faders.list() });
  reg.register({
    name: "fader.put",
    title: "Fader de canaux",
    description: "Creates or updates a channel fader: name, channels as {fixture, offset from its address (0-based)}, level 0..1, optional dca (a group with a master whose level multiplies the fader's). The rules mask still applies after it.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ fader: ChannelFaderSchema }),
    run: ({ fader }) => {
      checkChannels(fader.channels);
      if (fader.dca && !show.groups.get(fader.dca)?.master) throw new Error(say(`DCA inconnu : ${fader.dca}`, `unknown DCA: ${fader.dca}`));
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
      if (!f) throw new Error(say(`fader inconnu : ${i}`, `unknown fader: ${i}`));
      return show.faders.putLive({ ...f, level });
    },
  });

  // ---- rules
  const where = z.enum(["venue", "show"]).default("show");
  const coll = (w: "venue" | "show") => (w === "venue" ? show.venueRules : show.rules);
  reg.register({ name: "rule.list", title: "Règles", description: "Rules of the venue and of the show (min/max, allowed values, forbidden capabilities like sound-active), and the values they moved on the last frame.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => ({ venue: show.venueRules.list(), show: show.rules.list(), clamps: show.lastClamps.slice(0, 100) }) });
  reg.register({ name: "rule.put", title: "Règle", description: "Creates or updates a rule. level: type (fixture model), venue or show; locked rules cannot be relaxed by more specific ones. maxHz bounds a strobe only where its definition gives frequencies in Hz (show.lint names the fixtures where it does nothing); hold bounds the time above a level, maxDegPerSecond the pan/tilt speed, steadySeconds how often a value may change, allowCapabilities the kinds of ranges allowed; onViolation (clamp, confirm, reject) says what a look launch does when the rule would bound it; appliesTo (origins such as mcp, roles) makes it a check on those callers' look launches instead of a bound on the output.", right: "show:write", profiles: ["setup"], schema: z.object({ where, rule: RuleSchema }), run: ({ where: w, rule }) => coll(w).put(rule) });
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
      if (clash) throw new Error(say(`Program Change ${program.programChange} (canal ${program.channel}) déjà pris par « ${clash.name} »`, `Program Change ${program.programChange} (channel ${program.channel}) already taken by “${clash.name}”`));
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
  /** A DCA's level and a fader's level are live state: putting a design back never moves the light. */
  const keepLive = (collection: string, old: unknown, now: unknown) => {
    const [o, n] = [old as { master?: unknown; level?: unknown }, now as { master?: unknown; level?: unknown } | undefined];
    return collection === "groups" && o.master && n?.master ? { ...o, master: n.master } : collection === "faders" && n ? { ...o, level: n.level } : old;
  };
  /** How long after its activity line a change's history copy may be stamped. */
  const UNDO_SLACK_MS = 2000;
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
    name: "history.deleted",
    title: "Récemment supprimés",
    description: "Looks, groups, channel faders or dashboards deleted from the show whose last copy is still in the history, newest first: id, name, stamp (for history.restore) and when it was deleted.",
    right: "show:write",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({ collection: versioned }),
    run: ({ collection }) => VERSIONED[collection].coll.deleted().slice(0, 50),
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
      if (!old || old.id !== i) throw new Error(say(`version introuvable : ${collection}/${i} ${stamp}`, `version not found: ${collection}/${i} ${stamp}`));
      return reg.invoke(v.put, { [v.key]: keepLive(collection, old, v.coll.get(i)) }, ctx);
    },
  });

  reg.register({
    name: "history.undo",
    title: "Annuler une modification",
    description:
      "Undoes one change to a look, group, channel fader or dashboard, as an activity.list line gives it (its undo, at and until): puts back the version that change replaced, so a deleted object comes back. Changes made to the object after it are undone too: the later activity lines on the same object say which, and by whom (tell the user before). A creation replaced nothing: delete the object instead.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ collection: versioned, id: z.string(), at: z.number(), until: z.number().optional() }),
    run: async ({ collection, id: i, at, until }, ctx) => {
      const versions = VERSIONED[collection].coll.versions(i); // newest first
      // the copy a change keeps is written while it runs: just after its line's time
      const end = (until ?? at) + UNDO_SLACK_MS;
      const replaced = versions.filter((x) => Date.parse(x.at) >= at && Date.parse(x.at) <= end);
      const before = replaced[replaced.length - 1];
      if (!before) throw new Error(say(`rien à annuler pour ${i} : cette modification n'a remplacé aucune version (une création s'annule en supprimant l'objet)`, `nothing to undo for ${i}: this change replaced no version (a creation is undone by deleting the object)`));
      await reg.invoke("history.restore", { collection, id: i, stamp: before.stamp }, ctx);
      return { id: i, restored: before.stamp };
    },
  });

  // A proposal before a write: what a put would change, validated by the same schema, nothing written.
  const DIFFABLE = {
    looks: show.looks,
    groups: show.groups,
    faders: show.faders,
    dashboards,
    palettes: show.palettes,
    zones: show.zones,
    rules: show.rules,
    venueRules: show.venueRules,
    fixtures: venue.fixtures,
    canvases: venue.canvases,
  } as const;
  type Diffable = keyof typeof DIFFABLE;
  type Store = { validate(v: unknown): { id: string }; get(id: string): unknown; delete(id: string): boolean };
  /** The write commands a proposal can hold (and light call … --check): their collection, the argument carrying the object, the arguments kept beside it. */
  const PUT_COMMANDS: Record<string, { collection: (a: Record<string, unknown>) => Diffable; key: string; keep?: string[] }> = {
    "look.put": { collection: () => "looks", key: "look" },
    "group.put": { collection: () => "groups", key: "group" },
    "fader.put": { collection: () => "faders", key: "fader" },
    "dashboard.put": { collection: () => "dashboards", key: "dashboard" },
    "palette.put": { collection: () => "palettes", key: "palette" },
    "stage.zone.put": { collection: () => "zones", key: "zone" },
    "rule.put": { collection: (a) => (a.where === "venue" ? "venueRules" : "rules"), key: "rule", keep: ["where"] },
    "venue.fixture.put": { collection: () => "fixtures", key: "fixture" },
    "venue.canvas.put": { collection: () => "canvases", key: "canvas" },
  };
  const putOf = (command: string) => {
    const p = PUT_COMMANDS[command];
    if (!p) throw new Error(say(`pas de proposition pour ${command} : ${Object.keys(PUT_COMMANDS).join(", ")}`, `no proposal for ${command}: ${Object.keys(PUT_COMMANDS).join(", ")}`));
    return p;
  };
  const targetOf = (command: string, args: Record<string, unknown>) => {
    const p = putOf(command);
    return { collection: p.collection(args), object: args[p.key] };
  };
  /** What putting `object` in `collection` would change, or why it is invalid. */
  const diffOf = (collection: Diffable, object: unknown) => {
    const coll = DIFFABLE[collection] as Store;
    let parsed: { id: string };
    try {
      parsed = coll.validate(object);
    } catch (err) {
      const issues = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".") || "(objet)"}${say(" : ", ": ")}${i.message}`) : [String(err)];
      return { valid: false as const, collection, issues };
    }
    const current = coll.get(parsed.id);
    return { valid: true as const, collection, id: parsed.id, new: current === undefined, changes: current === undefined ? [] : diff(current, parsed) };
  };
  reg.register({
    name: "show.diff",
    title: "Ce que changerait un enregistrement",
    description:
      "Proposal before a write: what putting this object would change, field by field (path, before, after), checked by the same schema as the put command (defaults filled in), nothing written. new = it does not exist yet. Show it to the user and write only on their yes; the put command may still refuse it for its own reasons (a cycle, a partial look). Give a collection (looks, groups, faders, dashboards, palettes, zones, rules (show), venueRules, fixtures, canvases) and the object, or the put command and its arguments (look.put, group.put, fader.put, dashboard.put, palette.put, stage.zone.put, rule.put, venue.fixture.put, venue.canvas.put). Several changes to apply together: show.propose.",
    right: "show:propose",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z
      .object({
        collection: z.enum(Object.keys(DIFFABLE) as [Diffable, ...Diffable[]]).optional(),
        object: z.record(z.string(), z.unknown()).optional(),
        command: z.string().optional(),
        args: z.record(z.string(), z.unknown()).optional(),
      })
      .refine((a) => (a.collection && a.object) || (a.command && a.args), { message: "collection et object, ou command et args" }),
    run: (a) => {
      const { collection, object } = a.command ? targetOf(a.command, a.args!) : { collection: a.collection!, object: a.object };
      return diffOf(collection, object);
    },
  });

  // Proposals (docs/specs/mcp.md, « Proposer puis appliquer »): several changes held together, shown
  // field by field, applied all or nothing by someone who may write, taken back together. In
  // memory: a proposal is for the session at hand, not for the show.
  type Change = { command: string; args: Record<string, unknown> };
  type Applied = Change & { collection: Diffable; id: string; before?: unknown };
  interface Proposal {
    id: string;
    title?: string;
    who?: string;
    origin: string;
    at: number;
    status: "pending" | "applied" | "reverted" | "discarded";
    changes: Change[];
    applied?: Applied[];
    appliedAt?: number;
    appliedBy?: string;
  }
  const proposals = new Map<string, Proposal>();
  const PROPOSAL_KEEP_MS = 24 * 3600_000;
  const proposalOf = (id: string) => {
    const p = proposals.get(id);
    if (!p) throw new Error(say(`proposition inconnue : ${id}`, `unknown proposal: ${id}`));
    return p;
  };
  const previewOf = (c: Change) => ({ command: c.command, ...diffOf(targetOf(c.command, c.args).collection, targetOf(c.command, c.args).object) });
  /** Puts the objects back as they were before (newest first): the ones created go. */
  const takeBack = async (done: Applied[], ctx: Parameters<Parameters<typeof reg.register>[0]["run"]>[1]) => {
    for (const a of [...done].reverse()) {
      const coll = DIFFABLE[a.collection] as Store;
      if (a.before === undefined) coll.delete(a.id);
      else {
        const p = putOf(a.command);
        await reg.invoke(a.command, { ...Object.fromEntries((p.keep ?? []).map((k) => [k, a.args[k]])), [p.key]: keepLive(a.collection, a.before, coll.get(a.id)) }, ctx);
      }
    }
  };
  const ChangeSchema = z.object({ command: z.enum(Object.keys(PUT_COMMANDS) as [string, ...string[]]), args: z.record(z.string(), z.unknown()) });
  reg.register({
    name: "show.propose",
    title: "Proposer des changements",
    description:
      "Holds several changes (put commands and their arguments, as show.diff takes them) as one proposal, nothing written: each is checked and described field by field. Someone who may write applies it all or nothing (show.apply, or the Show page), show.revert takes it back together. For an AI client: propose, show the user what it does, apply on their yes — or leave it for them in the interface.",
    right: "show:propose",
    profiles: ["setup", "design"],
    schema: z.object({ changes: z.array(ChangeSchema).min(1).max(50), title: z.string().max(200).optional() }),
    run: ({ changes, title }, ctx) => {
      const preview = changes.map(previewOf);
      const invalid = preview.filter((x) => !x.valid);
      if (invalid.length) return { valid: false, preview };
      const now = Date.now();
      for (const [k, p] of proposals) if (now - p.at > PROPOSAL_KEEP_MS) proposals.delete(k);
      const id = `p-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      proposals.set(id, { id, ...(title ? { title } : {}), ...(ctx.who ? { who: ctx.who } : {}), origin: ctx.origin, at: now, status: "pending", changes });
      return { valid: true, id, preview };
    },
  });
  reg.register({
    name: "show.proposals",
    title: "Propositions",
    description: "Proposals of the last day, newest first: who made them, from where, their status (pending, applied, reverted, discarded) and, for one not applied, what applying it now would change.",
    right: "show:propose",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({}),
    run: () =>
      [...proposals.values()]
        .filter((p) => Date.now() - p.at <= PROPOSAL_KEEP_MS)
        .sort((a, b) => b.at - a.at)
        .map((p) => ({
          id: p.id,
          title: p.title,
          who: p.who,
          origin: p.origin,
          at: p.at,
          status: p.status,
          appliedAt: p.appliedAt,
          appliedBy: p.appliedBy,
          preview: p.status === "applied" ? p.applied!.map((a) => ({ command: a.command, valid: true, collection: a.collection, id: a.id, new: a.before === undefined, changes: [] })) : p.changes.map(previewOf),
        })),
  });
  reg.register({
    name: "show.apply",
    title: "Appliquer une proposition",
    description: "Applies a pending (or reverted) proposal through the usual put commands and their checks, all or nothing: if one is refused, those already made are taken back and nothing has changed.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ id: z.string() }),
    run: async ({ id }, ctx) => {
      const p = proposalOf(id);
      if (p.status !== "pending" && p.status !== "reverted") throw new Error(say(`proposition déjà ${p.status === "applied" ? "appliquée" : "écartée"}`, `proposal already ${p.status}`));
      const done: Applied[] = [];
      try {
        for (const c of p.changes) {
          const { collection, object } = targetOf(c.command, c.args);
          const coll = DIFFABLE[collection] as Store;
          const target = coll.validate(object).id;
          const before = coll.get(target);
          await reg.invoke(c.command, c.args, ctx);
          done.push({ ...c, collection, id: target, ...(before !== undefined ? { before } : {}) });
        }
      } catch (err) {
        await takeBack(done, ctx);
        throw new Error(say(`proposition non appliquée, rien n'a changé : ${(err as Error).message}`, `proposal not applied, nothing changed: ${(err as Error).message}`));
      }
      Object.assign(p, { status: "applied", applied: done, appliedAt: Date.now(), ...(ctx.who ? { appliedBy: ctx.who } : {}) });
      return { id, applied: done.length };
    },
  });
  reg.register({
    name: "show.revert",
    title: "Défaire une proposition",
    description: "Takes an applied proposal back as a whole: the objects it changed return to what they were just before it (later changes to them go too), the ones it created are removed. show.apply applies it again (redo).",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ id: z.string() }),
    run: async ({ id }, ctx) => {
      const p = proposalOf(id);
      if (p.status !== "applied") throw new Error(say("proposition non appliquée : rien à défaire", "proposal not applied: nothing to take back"));
      await takeBack(p.applied!, ctx);
      p.status = "reverted";
      return { id, reverted: p.applied!.length };
    },
  });
  reg.register({
    name: "show.discard",
    title: "Écarter une proposition",
    description: "Drops a pending proposal without applying it.",
    right: "show:propose",
    profiles: ["setup", "design"],
    schema: z.object({ id: z.string() }),
    run: ({ id }) => {
      const p = proposalOf(id);
      if (p.status === "applied") throw new Error(say("proposition appliquée : la défaire d'abord (show.revert)", "proposal applied: take it back first (show.revert)"));
      p.status = "discarded";
      return { id, discarded: true };
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
      if (!obj) throw new Error(say(`${collection}/${oid} introuvable`, `${collection}/${oid} not found`));
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      return c.put({ ...obj, notes: notes ? `${notes}${/\(\d{4}-/.test(notes) ? "" : ` (${stamp})`}` : undefined });
    },
  });

  // ---- show settings & safety
  reg.register({ name: "show.settings", title: "Réglages du show", description: "Show settings: safe snapshot or safe look recalled by « Panic neutre », grand master, default button mode.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => show.settings });
  reg.register({
    name: "show.settings.set",
    title: "Modifier les réglages du show",
    description: "Updates show settings (safeSnapshot, safeLook, grandMaster, grandMasterSmoothing: the grand master glides to its level, msPerStep per 1/255 of the travel, null = at once, defaultButtonMode, liveAi: whether AI clients may touch up the service live with live.adjust, looksMerge: several looks on the same fixtures, « last » the last one started covers the others, « highest » each colour keeps its highest value).",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: ShowSettingsSchema.partial().omit({ schemaVersion: true, kind: true }).extend({ grandMasterSmoothing: FaderSmoothingSchema.nullable().optional() }),
    run: ({ grandMasterSmoothing, ...patch }) => {
      if (patch.safeLook && !show.looks.get(patch.safeLook)) throw new Error(say(`look inconnu : ${patch.safeLook}`, `unknown look: ${patch.safeLook}`));
      if (patch.safeSnapshot && !show.snapshots.get(patch.safeSnapshot)) throw new Error(say(`instantané inconnu : ${patch.safeSnapshot}`, `unknown snapshot: ${patch.safeSnapshot}`));
      // null clears the grand master's smoothing (a partial patch cannot carry « absent »)
      return show.saveSettings(grandMasterSmoothing === undefined ? patch : { ...patch, grandMasterSmoothing: grandMasterSmoothing ?? undefined });
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
      if (!snap) throw new Error(say(`instantané inconnu : ${i}`, `unknown snapshot: ${i}`));
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

  /** Panic's second half: everything stopped, then the show's safe state. */
  const safeState = () => {
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
    return { action: "blackout", reason: say("aucun look de secours défini", "no fallback look set") };
  };
  reg.register({
    name: "panic",
    title: "Panic neutre",
    description:
      "Safety: stops every look, the DMX console parks and the manual head positions, then recalls the show's safe state: its safe snapshot (the whole state saved ahead), else its safe look, else a Blackout.",
    right: "commands:panic",
    profiles: ["setup", "design", "live"],
    schema: z.object({}),
    run: () => {
      show.rememberBeforePanic(engine.isBlackout()); // a Panic pressed by mistake is undone for a minute (panic.undo)
      const result = safeState();
      show.notePanicDone(engine.isBlackout());
      return result;
    },
  });
  reg.register({
    name: "panic.undo",
    title: "Annuler le Panic",
    description: "Within a minute of a Panic, puts back what played just before it (looks, DCA, channel faders, grand master, program, Blackout); the DMX console forcing and hand-aimed heads it released stay released.",
    right: "commands:panic",
    profiles: ["live"],
    schema: z.object({}),
    run: () => {
      const before = show.takeBeforePanic();
      if (!before) throw new Error(say("rien à annuler : pas de Panic dans la dernière minute", "nothing to undo: no Panic in the last minute"));
      const done = show.applySnapshot(before);
      engine.setBlackout(before.blackout);
      return { undone: true, ...done };
    },
  });
}
