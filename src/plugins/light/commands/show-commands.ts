/**
 * Venue and show commands: fixture library, patch, canvases, palettes, looks (go/stop), unified
 * groups (level, mute, flash), show settings, and « Panic neutre ».
 */
import { createHash } from "node:crypto";
import { UNDOABLE_COLLECTIONS } from "../activity.js";
import { z } from "zod";
import { TechniqueSchema } from "../engine/techniques.js";
import { displayHex } from "../engine/display.js";
import { ANSWERING_ORIGINS, CommandError, type CommandContext, type CommandRegistry } from "./registry.js";
import { flashProfile, MAX_FLASHES_PER_SECOND } from "../show/flashes.js";
import type { DmxEngine } from "../engine/dmx-engine.js";
import { CanvasSchema, PatchedFixtureSchema, type Canvas } from "../venue/venue.js";
import { adaptLook, applyOps, CanvasOpSchema, canvasProblems, fits, impactMessage, impactOf, paintedRows, putMoves, rowsOfTechnique, withRows, type AffectedLook, type CanvasOp, type EditContext, type Impact, type LookRows } from "../venue/canvas-edit.js";
import { accentProblems, headsOf } from "../venue/heads.js";
import { modelKeyOrUndefined, WheelOverridesSchema, type HeadOverrides } from "../venue/overrides.js";
import { GENERIC_DIMMER } from "../venue/qxf-import.js";
import { trackNamesProblem } from "../venue/tracks.js";
import { channelModes } from "../venue/channel-modes.js";
import { slotValue, wheelCapabilities } from "../venue/color-wheel.js";
import { sameNameMessage, sameSignatureMessage } from "../venue/definition-duplicates.js";
import { ChannelFaderSchema, FaderSmoothingSchema, GroupSchema, LookSchema, PaletteSchema, ShowSettingsSchema, type Look, type Snapshot } from "../show/model.js";
import { slugify, stableStringify } from "../data/store.js";
import { swatchOf } from "../show/swatch.js";
import { exclusiveMoves, nextExclusiveName } from "../show/exclusive.js";
import { folderOf, inTree, isReservedFolder, nestOf, normalizeFolder, renamedPath, withFolder } from "../show/folders.js";
import { IntentionSchema, INTENTION_REFS_HELP, newIntentionId, type AmbiguousRef } from "../knowledge/intentions.js";
import { normalizeMood } from "../knowledge/knowledge.js";
import { inUseMessage, usesOf, type ReferenceKind, type ShowParts } from "../show/references.js";
import type { ShowRuntime } from "../show/runtime.js";
import { effectiveRule, RuleProgramSchema, RuleSchema } from "../rules/rules.js";
import { isBuiltinRule, RESET_ORIGINS, RESET_WINDOW_MS, resetChannels } from "../rules/reset-protection.js";
import { TYPE_TAGS } from "../venue/grouping.js";
import { DashboardSchema, defaultDashboard } from "../dashboards/dashboards.js";
import { describeStage, queryStage, ZoneSchema, zoneOf } from "../venue/stage.js";
import { FACING_NAMES, facingOf, orientTo, wrapYaw } from "../venue/orientation.js";
import { arrangeAlong, EDGES, mountHeight } from "../venue/arrange.js";
import { diff } from "../data/diff.js";
import { say } from "../../../core/lang.js";
import { patchSchema } from "../../../core/zod-patch.js";

/** Puts a snapshot back the way `snapshot.recall` does: the runtime applies it, then the Blackout is set. */
export function recallSnapshot(engine: DmxEngine, show: ShowRuntime, snap: Snapshot): { looks: string[]; skipped: string[] } {
  try {
    return show.applySnapshot(snap);
  } finally {
    engine.setBlackout(snap.blackout);
  }
}

/** Recalls the open show's startup snapshot, if it names one that exists; the output standby is not touched. */
export function recallStartupSnapshot(engine: DmxEngine, show: ShowRuntime): { id: string; name: string } | { missing: string } | undefined {
  const id = show.settings.startupSnapshot;
  if (!id) return undefined;
  const snap = show.snapshots.get(id);
  if (!snap) return { missing: id };
  recallSnapshot(engine, show, snap);
  return { id: snap.id, name: snap.name };
}

/**
 * `sharedWith`: the other shows playing on the open venue, by name (file-commands.ts sharedWith); a
 * lone show command set (tests) has none. An error reading them is not swallowed: a delete must not
 * pass the shared-venue guard because the check failed. `standby`: whether the output is on standby (a reset
 * sent then reaches nothing).
 */
export interface ShowCommandOptions {
  sharedWith?: () => string[];
  standby?: () => boolean;
  /** Where an intention is used, other shows of this machine included (T15): what show.references says of one. */
  intentionReferences?: (id: string) => string[];
  /** A look's tags as stored (T15b): `ambiance:` tags written by name become the id one intention only answers to. */
  migrateTags?: (tags: string[]) => string[];
  /** The `ambiance:` tags of a look several intentions answer to (T15b): warned of by look.put. */
  ambiguousTags?: (tags: string[]) => AmbiguousRef[];
  /** A new intention's id, free in every layer (T15b): a proposed creation gets it when proposed. */
  newIntentionId?: () => string;
}

/** Writes a proposal carries beside its put commands (venue.fixture.mode: another show's looks, a fader emptied). */
export interface ProposalHooks {
  /** Part of show.apply's all or nothing: on a throw, `revert` then the puts' take-back run. A proposal with hooks is never redone. */
  apply(): Promise<void>;
  /** Takes back what `apply` wrote (only what is still as it wrote it); returns what it left alone, said. */
  revert(): Promise<string[]>;
  /** Throws when the open show or venue is no longer the one the proposal was applied on (show.revert refuses then). */
  guard?(): void;
}

/** What the show commands hand to the commands registered beside them (commands/fixture-mode-commands.ts). */
export interface ShowCommandsApi {
  /** Attaches writes to a pending proposal: made once show.apply has applied it, taken back once show.revert has reverted it. */
  hookProposal(id: string, hooks: ProposalHooks): void;
}

export function registerShowCommands(reg: CommandRegistry, engine: DmxEngine, show: ShowRuntime, options: ShowCommandOptions = {}): ShowCommandsApi {
  const { sharedWith = () => [], standby = () => false, intentionReferences, migrateTags, ambiguousTags, newIntentionId: freshIntentionId = () => newIntentionId(Date.now()) } = options;
  const venue = show.venue;
  const idSchema = z.object({ id: z.string() });
  /**
   * What uses a look, a group, a fader or a canvas (show/references.ts). Songs and mappings are opened on
   * call: a store collection keeps the schema of its first opening, and the plugin opens those two
   * with their own schemas after these commands are registered.
   */
  const parts = (): ShowParts => ({
    groups: show.groups.list(),
    faders: show.faders.list(),
    mappings: show.store.collection("mappings", z.object({ id: z.string() }).passthrough()).list() as unknown as ShowParts["mappings"],
    dashboards: dashboards.list(),
    snapshots: show.snapshots.list(),
    looks: show.looks.list(),
    canvases: venue.canvases.list(),
    songs: show.store.collection("songs", z.object({ id: z.string() }).passthrough()).list() as unknown as ShowParts["songs"],
    rules: show.rules.list(),
    venueRules: show.venueRules.list(),
    safeLook: show.settings.safeLook,
    safeSnapshot: show.settings.safeSnapshot,
    startupSnapshot: show.settings.startupSnapshot,
  });
  /** Deleting what is still used is refused (the error says where), unless `force`. */
  const removable = (kind: ReferenceKind, i: string, name: string | undefined, force: boolean, otherShows: string[] = []) => {
    const uses = usesOf(kind, i, parts());
    if ((uses.length || otherShows.length) && !force) throw new Error(inUseMessage(name ?? i, uses, otherShows));
    return uses;
  };
  /**
   * The other shows on the open venue, for a fixture's unforced delete. When one of their show.json
   * cannot be read, the delete is refused (after what uses the fixture, said first), saying how to delete
   * anyway: `detail.force` lets a screen offer that forced delete, `detail.reason` is what went wrong.
   */
  const sharedWithOrRefuse = (fixtureId: string, name: string): string[] => {
    try {
      return sharedWith();
    } catch (err) {
      removable("fixture", fixtureId, name, false);
      const reason = (err as Error).message;
      throw new CommandError("invalid", `${reason}. ${say("Le supprimer quand même, sans vérifier les autres shows de ce lieu : force: true", "Delete it anyway, without checking the venue's other shows: force: true")}`, { force: true, reason });
    }
  };
  const deletable = z.object({ id: z.string(), force: z.boolean().default(false).describe("delete even if a group, fader, mapping, dashboard, snapshot or song still uses it") });
  const canvasDeletable = z.object({ id: z.string(), force: z.boolean().default(false).describe("delete even if a look still uses it") });

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
    description: "Patched fixtures of the venue (address, mode, role, position, orientation; facing names the orientation when it is one of venue.fixture.orient's; movable says the fixture carries pan or tilt channels: the invert switches live on these only; channels its DMX footprint, the channel count of its mode, missing when its definition or mode is not found).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({}),
    run: () =>
      venue.fixtures.list().map((f) => {
        const r = venue.resolve(f.id);
        const facing = facingOf(f.orientation);
        const base = venue.absent.has(f.id) ? { ...f, absent: true } : f;
        return { ...base, ...("error" in r ? {} : { channels: r.mode.channels.length, ...(r.pan || r.tilt ? { movable: true } : {}) }), ...(facing ? { facing } : {}) };
      }),
  });
  reg.register({
    name: "venue.fixture.presence",
    title: "Matériel installé ou absent",
    description:
      "Says which fixtures of the venue are installed for the open show. An absent fixture stays in the patch (address, position, mode) but is dark, sends nothing on DMX and is left out of the address-overlap check; the venue and other shows are untouched. Give fixtures (ids) and/or tag (every fixture with that tag), and present true or false.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ fixtures: z.array(z.string()).default([]), tag: z.string().optional(), present: z.boolean() }),
    run: ({ fixtures, tag, present }) => {
      const ids = new Set(fixtures);
      if (tag) for (const f of venue.fixtures.list()) if (f.tags.includes(tag)) ids.add(f.id);
      const unknown = [...ids].filter((i) => !venue.fixtures.get(i));
      if (unknown.length) throw new Error(say(`fixture inconnue : ${unknown.join(", ")}`, `unknown fixture: ${unknown.join(", ")}`));
      // ids this venue does not have are kept: they are another venue's, should the show go back to it (show.venue.set)
      const absent = new Set(show.settings.absentFixtures);
      for (const i of ids) {
        if (present) absent.delete(i);
        else absent.add(i);
      }
      show.saveSettings({ absentFixtures: [...absent].sort() });
      return { absent: [...absent].filter((i) => venue.fixtures.get(i)).sort(), changed: [...ids].sort() };
    },
  });
  reg.register({
    name: "venue.fixture.channels",
    title: "Canaux des fixtures",
    description:
      "Channels of each patched fixture (with its model, universe, start address, type and marker colour) from its definition: offset (0-based from its address), name, attribute (intensity, color, strobe…), colour component of a colour channel and, for a channel cut into functions, its named ranges (min, max, name: a mode, a colour preset, a macro) and the same ranges read as working modes (modes: name, min, max, variants — consecutive ranges sharing a name once a number or a speed word is taken off, « Auto 1 », « Auto 2 » — and continuous for one wide range whose value is a speed; fixture.channel.mode sets one). Fixtures without a definition have none (give offsets by hand).",
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
                // modes: the same ranges grouped (variants of one mode, a continuous one), computed, never stored (venue/channel-modes.ts)
                return { offset, name, attribute: ch?.attribute ?? "other", ...(ch?.color ? { color: ch.color } : {}), ...(caps.length > 1 ? { ranges: caps.map(({ min, max, name: n }) => ({ min, max, name: n })), modes: channelModes(caps) } : {}) };
              });
        return { id: f.id, name: f.name, model: `${f.manufacturer} ${f.model}`, universe: f.universe, address: f.address, ...(f.color ? { color: f.color } : {}), ...("error" in r ? {} : { type: r.def.type }), channels };
      }),
  });
  reg.register({
    name: "venue.fixture.put",
    title: "Patcher une fixture",
    description: "Creates or updates a patched fixture (manufacturer/model/mode from the library, universe, 1-based address, role, tags, position). A universe beyond the output's is refused (unless the fixture is already there); `warning` says what is patched anyway: channels shared with another fixture, a fixture ending past channel 512 (its last channels are dropped), a missing definition, absent for this show.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ fixture: PatchedFixtureSchema }),
    run: ({ fixture }) => {
      // a universe the output does not have: its light would go nowhere. A fixture already there (an
      // older patch, a smaller config) can still be edited where it is.
      const before = venue.fixtures.get(fixture.id);
      if (fixture.universe > engine.output.count && fixture.universe !== before?.universe)
        throw new CommandError("invalid", say(`univers ${fixture.universe} hors de 1..${engine.output.count} (les univers de la sortie, Réglages)`, `universe ${fixture.universe} out of 1..${engine.output.count} (the output's universes, Settings)`));
      // ticked tracks (T5) named as venue.tracks.put accepts them
      const def = fixture.overrides?.tracks?.fade && venue.definitionFor(fixture.manufacturer, fixture.model);
      const tracksProblem = def ? trackNamesProblem(def, fixture.overrides!.tracks!.fade!) : undefined;
      if (tracksProblem) throw new CommandError("invalid", tracksProblem);
      const saved = venue.fixtures.put(fixture);
      const r = venue.resolve(saved.id);
      // patched anyway (two lamps on one address can be wanted), but said at once
      const warnings = [
        "error" in r ? r.error : "",
        ...venue.patchProblems(saved.id).map((o) => o.message),
        ...venue.patchBeyond(saved.id).map((b) => b.message),
        // absence goes by id: a fixture patched again under an absent one's id stays dark, and must be told
        venue.absent.has(saved.id) ? say("absent pour ce show : rien n'est envoyé (venue.fixture.presence pour l'installer)", "absent for this show: nothing is sent (venue.fixture.presence to install it)") : "",
      ].filter(Boolean);
      return { fixture: saved, warning: warnings.length ? warnings.join(" ; ") : undefined };
    },
  });
  reg.register({
    name: "venue.fixture.orient",
    title: "Orienter une fixture",
    description:
      "Where a fixture points at rest, for the stage plan and moving-head aiming: facing audience, upstage (the wall behind the stage), houseLeft (jardin, the audience's left), houseRight (cour, the audience's right), ceiling or floor (these two keep the heading); or yaw (degrees: 0 audience, 90 cour, 180 upstage, -90 jardin) and pitch (-90 floor .. 90 ceiling); or turn, degrees added to the heading. A moving head pointed at the floor hangs, at the ceiling stands. roll turns the body around its beam: 0 a bar lies across, 90 it stands (its first head at the bottom). For a moving head whose pan or tilt runs the other way round (a maker's wiring choice), invertPan / invertTilt flips the 0..1 position on its channel(s); both stay as stored when not given.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: z.string(), facing: z.enum(FACING_NAMES).optional(), yaw: z.number().optional(), pitch: z.number().min(-90).max(90).optional(), turn: z.number().optional(), roll: z.number().min(-180).max(180).optional(), invertPan: z.boolean().optional(), invertTilt: z.boolean().optional() }),
    run: ({ id: fixtureId, facing, yaw, pitch, turn, roll, invertPan, invertTilt }) => {
      const f = venue.fixtures.get(fixtureId);
      if (!f) throw new Error(say(`fixture inconnue : ${fixtureId}`, `unknown fixture: ${fixtureId}`));
      let o = { yaw: f.orientation?.yaw ?? 0, pitch: f.orientation?.pitch ?? 0 };
      if (facing) o = orientTo(o, facing);
      if (yaw !== undefined) o.yaw = yaw;
      if (pitch !== undefined) o.pitch = pitch;
      if (turn !== undefined) o.yaw += turn;
      const orientation = {
        invertPan: false,
        invertTilt: false,
        swapPanTilt: false,
        panOffset: 0,
        tiltOffset: 0,
        ...f.orientation,
        yaw: wrapYaw(o.yaw),
        pitch: o.pitch,
        ...(roll !== undefined ? { roll } : {}),
        ...(invertPan !== undefined ? { invertPan } : {}),
        ...(invertTilt !== undefined ? { invertTilt } : {}),
      };
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
  // ---- heads and accent heads (venue/heads.ts): corrected per model, overridden per fixture (venue/overrides.ts)
  const headsScope = z.enum(["model", "fixture"]).default("model").describe("model: every fixture of its manufacturer and model follows; fixture: this one only, over its model's");
  const keyOrUndefined = (f: { manufacturer: string; model: string }) => modelKeyOrUndefined(f.manufacturer, f.model);
  /** A fixture's heads as it resolves, and as its model's correction alone gives them (what « this model » edits). */
  const headsOfFixture = (fixtureId: string) => {
    const f = venue.fixtures.get(fixtureId);
    if (!f) throw new Error(say(`fixture inconnue : ${fixtureId}`, `unknown fixture: ${fixtureId}`));
    const r = venue.resolve(fixtureId);
    if ("error" in r) throw new Error(r.error);
    const key = keyOrUndefined(f);
    const model = key ? venue.models.get(key)?.overrides.heads : undefined;
    const channel = (offset: number) => ({ offset, name: r.mode.channels[offset]!, color: r.def.channels.get(r.mode.channels[offset]!)?.color });
    const list = (found: { heads: ReadonlyMap<number, Partial<Record<string, number>>>; accent: ReadonlySet<number> }) =>
      [...found.heads].map(([head, comps]) => ({ head, accent: found.accent.has(head), channels: Object.values(comps).flatMap((o) => (o === undefined ? [] : [o])).sort((a, b) => a - b).map(channel) }));
    const ofModel = headsOf(r.def, r.mode, model);
    return {
      r,
      view: {
        fixture: f.id,
        deduced: r.deducedHeads,
        heads: list(r),
        follow: r.follow,
        escaped: r.escapedColours.map(channel),
        overrides: { ...(model ? { model } : {}), ...(f.overrides?.heads ? { fixture: f.overrides.heads } : {}) },
        /** The model's heads with its correction only, and how many patched fixtures of that model it reaches. */
        model: { heads: list(ofModel), follow: model?.follow ?? true, fixtures: key ? venue.fixtures.list().filter((x) => keyOrUndefined(x) === key).length : 1 },
      },
    };
  };
  /** Writes (or, with undefined, removes) the heads part of a fixture's or its model's overrides; the other parts stay. */
  const putHeads = (fixtureId: string, scope: "model" | "fixture", heads: HeadOverrides | undefined) => venue.putOverridePart(fixtureId, scope, "heads", heads);
  reg.register({
    name: "venue.fixture.heads",
    title: "Têtes d'une fixture",
    description:
      "A fixture's colour heads: those its definition declares, or, when it declares none but repeats its colour components (« Red 1 / Green 1 … Red 2 … », « Halo Red »), those deduced from its channel names (deduced: true). Each head lists its channels; accent marks a halo (or an unnumbered ring, a backlight): it follows the look (follow) but is no full colour of the fixture (left out of the preview, of what a look lights and of venue.canvas.auto). Head numbers never move when the accent changes. escaped: colour channels no head reaches although their component is in one. overrides: the corrections of its model and its own (merged field by field: the fixture's accent or follow over the model's). model: the heads with the model's correction alone, and how many patched fixtures of that model it reaches.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({ fixture: z.string() }),
    run: ({ fixture }) => headsOfFixture(fixture).view,
  });
  reg.register({
    name: "venue.fixture.heads.set",
    title: "Régler le halo d'une fixture",
    description:
      "Corrects a fixture's accent heads (a halo, a ring, a backlight), for its model (default) or this fixture only. accent: the colour channels (names, as venue.fixture.heads gives them) of the accent heads, whole heads only and never every head (an accent needs a full head beside it), checked against every mode of the model (a mode that has none of them keeps the detection by name); [] = no accent (every head is a full one); null = back to the detection by name. follow false: an accent head stays dark unless a look paints it (no colour from the other heads nor from a whole-fixture colour); null = back to the default (true). What is not given stays as set.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ fixture: z.string(), scope: headsScope, accent: z.array(z.string()).nullable().optional(), follow: z.boolean().nullable().optional() }),
    run: ({ fixture, scope, accent, follow }) => {
      const { r, view } = headsOfFixture(fixture);
      if (accent?.length) {
        const { unknown, partial, every } = accentProblems(r.def, accent);
        if (unknown.length) throw new Error(say(`pas un canal de couleur de ce modèle : ${unknown.join(", ")}`, `not a colour channel of this model: ${unknown.join(", ")}`));
        if (partial.length)
          throw new Error(
            say(
              `un halo est fait de têtes entières : ${partial.map((p) => `${p.head.join(", ")} (mode ${p.mode})`).join(" ; ")} n'y sont qu'en partie`,
              `an accent is made of whole heads: ${partial.map((p) => `${p.head.join(", ")} (mode ${p.mode})`).join("; ")} are only partly in it`,
            ),
          );
        // marked so, every head would be a full one again (headsOf): refused rather than saved and silently undone
        if (every.length)
          throw new Error(
            say(
              `un halo a besoin d'au moins une zone pleine à côté : toutes les têtes y seraient (mode ${every.join(", ")})`,
              `an accent needs at least one full zone beside it: every head would be in it (mode ${every.join(", ")})`,
            ),
          );
      }
      const current = (scope === "model" ? view.overrides.model : view.overrides.fixture) ?? {};
      const { accent: oldAccent, follow: oldFollow, ...rest } = current;
      const nextAccent = accent === null ? undefined : (accent ?? oldAccent);
      const nextFollow = follow === null ? undefined : (follow ?? oldFollow);
      const next: HeadOverrides = { ...rest, ...(nextAccent ? { accent: nextAccent } : {}), ...(nextFollow !== undefined ? { follow: nextFollow } : {}) };
      putHeads(fixture, scope, Object.keys(next).length ? next : undefined);
      return headsOfFixture(fixture).view;
    },
  });
  reg.register({
    name: "venue.fixture.heads.clear",
    title: "Annuler la correction des têtes",
    description: "Removes the whole heads correction (accent and follow) of a fixture's model (default) or of this fixture only: the halo is found by its channel names again and follows the look (or the model's correction applies again).",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ fixture: z.string(), scope: headsScope }),
    run: ({ fixture, scope }) => {
      headsOfFixture(fixture); // an unknown fixture is an error
      putHeads(fixture, scope, undefined);
      return headsOfFixture(fixture).view;
    },
  });
  // ---- colour wheel (T18): the colour → slot correspondence, per model, overridable per fixture (venue/color-wheel.ts)
  /**
   * A fixture's colour wheel as its definition gives it — every range of the wheel channel, with or without a
   * colour: one the definition gives none can be given one — and where its overrides live; undefined when it has
   * none that answers painted colours (no wheel, no definition, or colour mixing: an RGB fixture's wheel is
   * left to raw channels).
   */
  const wheelOrNone = (fixtureId: string) => {
    const f = venue.fixtures.get(fixtureId);
    if (!f) throw new Error(say(`fixture inconnue : ${fixtureId}`, `unknown fixture: ${fixtureId}`));
    const r = venue.resolve(fixtureId);
    if ("error" in r || !r.wheel || !r.lampOnly) return undefined;
    const caps = r.def.channels.get(r.mode.channels[r.wheel.offset] ?? "")?.capabilities ?? [];
    // key undefined: a model named without a letter or digit, whose wheel is set per fixture only
    return { f, wheel: r.wheel, slots: wheelCapabilities(caps), key: keyOrUndefined(f) };
  };
  const wheelOfFixture = (fixtureId: string) => {
    const found = wheelOrNone(fixtureId);
    if (!found) throw new Error(say(`${venue.fixtures.get(fixtureId)?.name ?? fixtureId} n'a pas de roue de couleurs choisie par la couleur peinte (lampe et roue)`, `${venue.fixtures.get(fixtureId)?.name ?? fixtureId} has no colour wheel chosen by the painted colour (a lamp and a wheel)`));
    return found;
  };
  const wheelScope = z.enum(["model", "fixture"]).describe("model: every fixture of this manufacturer and model; fixture: this one only, replacing the model's settings as a whole");
  reg.register({
    name: "venue.wheel.get",
    title: "Roue de couleurs",
    description:
      "A lamp fixture's colour wheel (docs/specs/venue-fixtures-stage.md, « Roue de couleurs »): every range of its wheel channel as the definition gives it (DMX range, value sent = the middle, name, colour; a split slot has two; « open » = no filter, white; « colorless » = the definition gives it no colour: it is never chosen until venue.wheel.put gives it its real colour), the overrides of its model and of this fixture (a slot's real colour, the colours it answers to, slots left out, split slots allowed, slot change at mid-fade or through black and how long the wheel takes to turn), and which applies. changeMs: the time in force. null when the fixture has no such wheel (none, no definition, or colour mixing).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: idSchema,
    run: ({ id: fixtureId }) => {
      const found = wheelOrNone(fixtureId);
      if (!found) return null;
      const { f, wheel, slots, key } = found;
      return {
        fixture: { id: f.id, name: f.name, manufacturer: f.manufacturer, model: f.model },
        offset: wheel.offset + 1,
        slots: slots.map((s) => ({ min: s.min, max: s.max, value: slotValue(s), name: s.name, ...(s.color ? { color: displayHex(s.color) } : { colorless: true }), ...(s.color2 ? { color2: displayHex(s.color2) } : {}), ...(s.open ? { open: true } : {}) })),
        model: (key && venue.models.get(key)?.overrides.wheel) ?? null,
        own: f.overrides?.wheel ?? null,
        applies: f.overrides?.wheel ? "fixture" : key && venue.models.get(key)?.overrides.wheel ? "model" : "definition",
        doubles: wheel.doubles,
        change: wheel.change,
        changeMs: wheel.changeMs,
      };
    },
  });
  reg.register({
    name: "venue.wheel.put",
    title: "Régler la roue de couleurs",
    description:
      "Sets the colour → slot correspondence of a lamp fixture's colour wheel, for its whole model (scope model) or for this fixture only (scope fixture, which then replaces the model's settings as a whole). slots, keyed by a slot's first DMX value (\"16\"): color (#rrggbb) its real colour when the definition is wrong or gives none (a range without colour becomes a slot), answers the colours it answers to beside its own (an asked colour nearest one of them lands on it), off never chosen from a painted colour. doubles: split slots may be chosen when a look asks their two colours of the fixture (default true). change: \"mid\" the slot changes at mid-fade in a crossfade (default), \"black\" the dimmer goes through black there, held at 0 for changeMs after the change (the time the wheel takes to turn, default 300 ms: to measure on the fixture). Replaces the wheel settings of that scope.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: z.string(), scope: wheelScope, wheel: WheelOverridesSchema }),
    run: ({ id: fixtureId, scope, wheel: settings }) => {
      const { f, slots } = wheelOfFixture(fixtureId);
      const unknown = Object.keys(settings.slots ?? {}).filter((k) => !slots.some((s) => String(s.min) === k));
      if (unknown.length) throw new Error(say(`case inconnue sur cette roue : ${unknown.join(", ")} (une case se nomme par la première valeur de sa plage)`, `no such slot on this wheel: ${unknown.join(", ")} (a slot is named by the first value of its range)`));
      const lower = (hex: string) => hex.toLowerCase();
      const clean = {
        ...settings,
        ...(settings.slots ? { slots: Object.fromEntries(Object.entries(settings.slots).map(([k, s]) => [k, { ...s, ...(s.color ? { color: lower(s.color) } : {}), ...(s.answers ? { answers: s.answers.map(lower) } : {}) }])) } : {}),
      };
      // a model named without a letter or digit is refused (modelKey): its fixtures are set one by one
      venue.putOverridePart(f.id, scope, "wheel", clean);
      return { scope, wheel: clean };
    },
  });
  reg.register({
    name: "venue.wheel.clear",
    title: "Effacer les réglages de la roue",
    description: "Removes the colour wheel settings of a fixture's model (scope model) or of this fixture (scope fixture): the model's settings, or the definition, apply again.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: z.string(), scope: wheelScope }),
    run: ({ id: fixtureId, scope }) => {
      const { f, key } = wheelOfFixture(fixtureId);
      const set = scope === "fixture" ? f.overrides?.wheel : key ? venue.models.get(key)?.overrides.wheel : undefined;
      if (!set) return { cleared: false };
      venue.putOverridePart(f.id, scope, "wheel", undefined);
      return { cleared: true };
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
        const zPos = height !== undefined ? zone.floorHeight + height : mountHeight(f.mount) + (f.mount === "hung" || f.mount === "truss" || f.mount === "ceiling" ? 0 : zone.floorHeight);
        const orientation = facing ? { invertPan: false, invertTilt: false, swapPanTilt: false, panOffset: 0, tiltOffset: 0, ...f.orientation, ...orientTo(f.orientation, facing) } : f.orientation;
        const saved = venue.fixtures.put({ ...f, position: { ...points[k]!, z: Math.round(zPos * 10) / 10 }, ...(orientation ? { orientation } : {}) });
        return { id: i, position: saved.position, ...(orientation ? { facing: facingOf(saved.orientation) } : {}) };
      });
    },
  });
  reg.register({
    name: "dmx.explain",
    title: "Pourquoi ce canal",
    description: "Why a DMX channel has its value: output value, forcing from the DMX console, the fixture and channel it belongs to, the grand master and the DCAs dosing that fixture (own and effective levels), the channel faders and raw-channel looks writing it, and the rules that bounded it on the last frame. On a pan or tilt channel of a moving head: motion = who places that axis in the motion layer (layer manual/target/look/hold/rest/lock, owner and its look's name, the glide under way: from, to, remainingMs) and the claims it masks (masked); rawLooks then lists a look only when it holds the axis. On a colour channel: its head (fixture.head, accent for a halo) and the looks painting it (paintingLooks: those whose canvas reaches its head, in the order they compose; leaving for one fading out, covered for one a later look covers under looksMerge « last »). track: on a fixture whose tracks are enabled (venue.tracks.get), \"fade\" when the channel follows the transitions, \"jump\" when it jumps (pan/tilt left out).",
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
    description: "The patch's problems: fixtures whose DMX channels overlap (two of the same model and mode on one address, wired as twins, are not reported) with the shared channels and a sentence, fixtures ending past channel 512 (beyondUniverse: their last channels are never sent), information notes (info: gaps, unused channels between two fixtures, as [{universe, gaps: [{universe, from, to, after, before}], message}] one line per universe; sameNames, fixtures of one model sharing a name; noPosition, moving heads or fixtures given a mount or a target zone but no stage position), and fixtures without a definition in the library (their channels are not decoded: add the .qxf), and duplicate definitions across the whole library (duplicateDefinitions: one model in several .qxf files, with the file used today, the first in reading order, and how the others differ; one structure under two names). `show.lint` reports only those of models the venue patches.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({}),
    run: () => {
      const dup = venue.duplicateDefinitions();
      return {
        overlaps: venue.patchProblems(),
        beyondUniverse: venue.patchBeyond(),
        missingDefinitions: venue.missingDefinitions(),
        duplicateDefinitions: { sameName: dup.sameName.map((g) => ({ ...g, message: sameNameMessage(g) })), sameSignature: dup.sameSignature.map((g) => ({ ...g, message: sameSignatureMessage(g) })) },
        info: venue.patchNotes(),
      };
    },
  });
  reg.register({
    name: "fixture.reset",
    title: "Réinitialiser l'appareil",
    description: `Resets a fixture on purpose: each of its Reset channels (ranges tagged reset in its definition) gets the middle of its Reset range (the « all » one when there are several) for ${RESET_WINDOW_MS / 1000} s, over the show and the DMX console, the built-in Reset protection lifted on those channels only (a twin on the same address shares them); then the protection comes back. A moving head swings and may go dark while it resets: not during a song. Ask the user first, naming the fixture and the range, and send confirm: true only on their yes. Only from the interface, an AI client or the command line (never MIDI, OSC, OS2L nor a song). Refused for a fixture without a Reset channel, during a Blackout or on output standby (checked before asking), or when another locked rule or the end of the universe (a channel past 512) keeps every Reset channel from its value; warning when it keeps some of them.`,
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: z.string(), confirm: z.boolean().default(false).describe("the user agreed to reset this fixture now") }),
    run: ({ id: i, confirm }, ctx) => {
      if (!RESET_ORIGINS.includes(ctx.origin))
        throw new CommandError(
          "failed",
          say(
            `réinitialisation refusée depuis ${ctx.origin} : elle n'est acceptée que depuis l'interface, un client IA (sur l'accord de l'utilisateur) ou la ligne de commande, où quelqu'un peut confirmer`,
            `reset refused from ${ctx.origin}: it is only accepted from the interface, an AI client (on the user's yes) or the command line, where someone can confirm`,
          ),
        );
      const f = venue.fixtures.get(i);
      if (!f) throw new Error(say(`fixture inconnue : ${i}`, `unknown fixture: ${i}`));
      if (venue.absent.has(i)) throw new Error(say(`${i} est absent pour ce show : rien ne lui est envoyé`, `${i} is absent for this show: nothing is sent to it`));
      const r = venue.resolve(i);
      const channels = "error" in r ? [] : resetChannels(r);
      if (!channels.length) throw new Error(say(`${f.name} n'a pas de canal Reset dans sa définition`, `${f.name} has no Reset channel in its definition`));
      // before asking the user: a yes would be for nothing
      if (engine.isBlackout()) throw new CommandError("failed", say("Blackout en cours : la valeur Reset ne sortirait pas (le lever d'abord)", "Blackout is on: the Reset value would not go out (lift it first)"));
      if (standby()) throw new CommandError("failed", say("sortie en veille : rien n'atteint les projecteurs (Réglages → Reprendre la main)", "output on standby: nothing reaches the fixtures (Settings → Take over)"));
      if (ctx.origin === "mcp" && !confirm) {
        const ranges = channels.map((c) => `${c.name} : ${c.range}${c.others.length ? say(` (autres plages Reset non envoyées : ${c.others.join(", ")})`, ` (other Reset ranges, not sent: ${c.others.join(", ")})`) : ""}`).join(", ");
        throw new CommandError(
          "failed",
          say(
            `réinitialiser « ${f.name} » (${ranges}) ? Il bouge et peut s'éteindre ${RESET_WINDOW_MS / 1000} s : pas pendant un chant. Le demander à l'utilisateur, puis renvoyer confirm: true`,
            `reset “${f.name}” (${ranges})? It moves and may go dark for ${RESET_WINDOW_MS / 1000} s: not during a song. Ask the user, then send confirm: true`,
          ),
          { confirm: true },
        );
      }
      const { until: _until, ...done } = show.startReset(i);
      // what really goes out: another locked rule (a venue's « max 199 ») may keep the value from its range
      const blocked = show.resetOutcome(i, engine.render()).filter((o) => o.beyond || o.sent !== o.value);
      const why = blocked.map((o) =>
        o.beyond
          ? say(`${o.name} est au-delà du canal 512 (l'appareil déborde de son univers) : jamais envoyé`, `${o.name} is past channel 512 (the fixture runs off its universe): never sent`)
          : say(`${o.name} reste à ${o.sent} au lieu de ${o.value}${o.rules.length ? ` (règle ${o.rules.join(", ")})` : ""}`, `${o.name} stays at ${o.sent} instead of ${o.value}${o.rules.length ? ` (rule ${o.rules.join(", ")})` : ""}`),
      ).join(" ; ");
      if (blocked.length === done.channels.length) {
        show.cancelResets(i);
        engine.requestFrame();
        throw new CommandError("failed", say(`réinitialisation non envoyée : ${why}`, `reset not sent: ${why}`));
      }
      return { ...done, ...(blocked.length ? { warning: say(`réinitialisation partielle : ${why}`, `partial reset: ${why}`) } : {}) };
    },
  });
  reg.register({
    name: "venue.grouping.propose",
    title: "Proposer des groupes par type",
    description: `Proposes, without writing anything, a tag per kind of fixture (${TYPE_TAGS.join(", ")}, French words in any language: read from the definition's type, its pan/tilt and machine outputs) for the fixtures lacking it, and a group per kind of at least two fixtures that no group gathers yet (one selecting exactly that tag, or holding exactly those fixtures); a fixed type group made earlier (id type-<tag>) lacking fixtures of its kind is proposed for completion (complete.missing) instead. No group nor tag is renamed or removed, but a tag added brings its fixtures into the existing groups selecting by tags: affected lists them (show: another show on the same venue, which shares the fixtures' tags); tell the user before applying. Apply with venue.grouping.apply.`,
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({}),
    run: () => show.typeGrouping(),
  });
  reg.register({
    name: "venue.grouping.apply",
    title: "Créer des groupes par type",
    description:
      "Applies what venue.grouping.propose proposes, for the kinds chosen only: tags adds each kind's tag to its fixtures lacking it (other tags untouched); groups creates a kind's group, live (selector on the tag: a fixture tagged later joins it; its fixtures get the tag) or fixed (the list of its fixtures today), or completes the fixed type group proposed for completion (live ignored). A kind with nothing proposed is refused, and then nothing is written. Tags added change the existing groups selecting by them (affected, as venue.grouping.propose says, in the answer). Not idempotent: a second call finds nothing proposed. Not atomic either: tags and groups are written one file after another, so a disk error midway leaves what was written before it (call venue.grouping.propose again to see what is left).",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({
      tags: z.array(z.enum(TYPE_TAGS)).default([]).describe("kinds whose proposed tags are added to their fixtures"),
      groups: z.array(z.object({ tag: z.enum(TYPE_TAGS), live: z.boolean().default(true).describe("true: follows the tag (updated automatically); false: a fixed list") })).default([]),
    }),
    run: ({ tags: askedTags, groups: askedGroups }) => {
      // the same kind twice counts once (its first choice)
      const tags = [...new Set(askedTags)];
      const groups = askedGroups.filter((g, i) => askedGroups.findIndex((x) => x.tag === g.tag) === i);
      const proposal = show.typeGrouping();
      const unknown = [...new Set([...tags.filter((t) => !proposal.tags.some((p) => p.tag === t)), ...groups.filter((g) => !proposal.groups.some((p) => p.tag === g.tag)).map((g) => g.tag)])];
      if (unknown.length) throw new Error(say(`rien n'est proposé pour : ${unknown.join(", ")} (venue.grouping.propose)`, `nothing is proposed for: ${unknown.join(", ")} (venue.grouping.propose)`));
      // everything is built and checked first, then written: a refusal leaves nothing half done
      const plans = groups.map(({ tag, live }) => {
        const p = proposal.groups.find((x) => x.tag === tag)!;
        const old = p.complete ? show.groups.get(p.id) : undefined;
        if (p.complete && !old) throw new Error(say(`groupe inconnu : ${p.id}`, `unknown group: ${p.id}`));
        const group = old ? GroupSchema.parse({ ...old, members: { ...old.members, fixtures: p.fixtures } }) : GroupSchema.parse({ id: p.id, name: p.name, ...(live ? { selector: { tags: [tag] } } : { members: { fixtures: p.fixtures } }) });
        return { group, done: { id: p.id, name: p.name, tag, live: Boolean(live && !old), fixtures: p.fixtures, ...(old ? { completed: true } : {}) } };
      });
      // a live group gathers by its tag: its fixtures need it, whether asked or not
      const tagKinds = new Set([...tags, ...plans.filter((x) => x.done.live).map((x) => x.done.tag)]);
      const retagged = proposal.tags
        .filter((x) => tagKinds.has(x.tag))
        .flatMap((p) => {
          const f = venue.fixtures.get(p.fixture);
          return f && !f.tags.includes(p.tag) ? [{ fixture: PatchedFixtureSchema.parse({ ...f, tags: [...f.tags, p.tag] }), tag: p.tag }] : [];
        });
      for (const { fixture } of retagged) venue.fixtures.put(fixture);
      for (const { group } of plans) show.groups.put(group);
      return { tagged: retagged.map((x) => ({ fixture: x.fixture.id, tag: x.tag })), created: plans.map((x) => x.done), affected: proposal.affected.filter((a) => tagKinds.has(a.tag)) };
    },
  });
  reg.register({
    name: "venue.fixture.delete",
    title: "Dépatcher",
    description:
      "Removes a fixture from the patch. Refused while something in the open show uses it (groups, channel faders, raw channels of looks, canvases, rules scoped to it, MIDI mappings and song track actions naming it: the error names them; see show.references), unless force; also refused, unless force, when the venue is shared with other shows (they lose the fixture too, the error names them) or when one of the other shows' settings cannot be read (they are not checked). `usedBy` lists what was using it when forced. An id that is not in the patch: deleted false, nothing checked.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: z.string(), force: z.boolean().default(false).describe("delete even if the show uses it or the venue is shared with other shows") }),
    run: ({ id: i, force }) => {
      const f = venue.fixtures.get(i);
      // not in the patch: nothing to delete, whatever may still name the id
      if (!f) return { deleted: false, usedBy: [] };
      const others = force ? [] : sharedWithOrRefuse(i, f.name); // forced: another show's damaged settings must not block the delete
      const usedBy = removable("fixture", i, f.name, force, others);
      const deleted = venue.fixtures.delete(i);
      // out of the patch, out of the show's absent list: a fixture patched later under this id is installed
      // and its rest position goes with it (not a use: it never blocks the delete). Other shows of a shared venue keep a stale id, which is ignored (only movingHeads() are read)
      if (deleted) {
        const { [i]: _gone, ...restPositions } = show.settings.restPositions;
        const absentFixtures = show.settings.absentFixtures.filter((x) => x !== i);
        if (Object.hasOwn(show.settings.restPositions, i) || absentFixtures.length !== show.settings.absentFixtures.length) show.saveSettings({ absentFixtures, restPositions });
      }
      return { deleted, usedBy };
    },
  });
  reg.register({ name: "venue.canvas.list", title: "Canevas", description: "Canvases of the venue and their rendering onto fixtures.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design"], schema: z.object({}), run: () => venue.canvases.list() });
  // ---- canvases: every write over an existing canvas checks what it does to the looks on it (venue/canvas-edit.ts)
  const canvasCtx: EditContext = { headsOf: (f) => venue.canvasHeads(f) };
  const looksOn = (canvasId: string) => show.looks.list().filter((l) => l.canvas === canvasId);
  const unknownCanvas = (i: string) => new CommandError("failed", say(`canevas inconnu : ${i}`, `unknown canvas: ${i}`), { unknown: "canvas" });
  /** The other shows on the venue, for a change that moves cells (their looks are not checked); one that cannot be read counts. */
  const othersOnVenue = (): string[] => {
    try {
      return sharedWith();
    } catch (err) {
      return [say(`autres shows illisibles (${(err as Error).message})`, `other shows unreadable (${(err as Error).message})`)];
    }
  };
  /** First rows of a look's steps, before and after an adaptation: enough to see it, not a whole imported look. */
  const PREVIEW_ROWS = 8;
  const revisionOf = (canvas: Canvas) => createHash("sha1").update(stableStringify(canvas)).digest("hex").slice(0, 12);
  /** Refused when the canvas is not the one an earlier answer gave: changed elsewhere (`detail.stale`), or gone (`detail.unknown`). */
  const sameRevision = (i: string, current: Canvas | undefined, revision: string | undefined) => {
    if (revision === undefined) return;
    if (!current) throw unknownCanvas(i);
    if (revision !== revisionOf(current)) throw new CommandError("failed", say(`le canevas « ${current.name} » a changé ailleurs depuis : le recharger`, `canvas “${current.name}” changed elsewhere since: reload it`), { stale: true, revision: revisionOf(current) });
  };
  const warningsOf = (canvas: Canvas) =>
    canvasProblems(canvas, canvasCtx)
      .filter((p) => p.level === "attention")
      .map((p) => p.message);
  /** How a canvas write is let through: `force` whatever it breaks, `shared` knowing the venue's other shows are not checked. */
  interface Passes {
    force: boolean;
    shared: boolean;
  }
  /**
   * Refuses a change that breaks looks of exact steps (unless forced) or moves cells of a shared venue (unless
   * forced or `shared`); `detail.impact` lets a screen ask. The other shows are read only when they matter.
   */
  const refuseUnlessPassed = (name: string, impact: Impact, broken: AffectedLook[], pass: Passes, how: "edit" | "put" | "restore", adaptable: { id: string }[] = []) => {
    if (pass.force) return;
    const others = impact.shifted && !pass.shared ? othersOnVenue() : [];
    if (!broken.length && !others.length) return;
    // only the looks still broken can be adapted: one already adapted is not offered again
    const can = adaptable.filter((a) => broken.some((l) => l.id === a.id));
    throw new CommandError("invalid", impactMessage(name, broken, others, how, new Set(can.map((a) => a.id))), { impact, broken: broken.map((l) => l.id), shared: others, adaptable: can });
  };
  /** What an edit would do: the canvas, its impact, the looks it breaks and how their rows would follow. */
  const planEdit = (current: Canvas, ops: CanvasOp[]) => {
    const edited = applyOps(current, ops, canvasCtx);
    const canvas = venue.canvases.parse(edited.canvas);
    const impact = impactOf(current, canvas, { origin: edited.origin }, looksOn(current.id));
    const broken = impact.looksAffected.filter((l) => l.reason === "steps");
    const adaptable = broken.flatMap((a) => {
      const look = show.looks.get(a.id);
      const before = look && rowsOfTechnique(look.technique);
      const after = look && adaptLook(look, current, edited.origin);
      if (!look || !before || !after) return [];
      return [{ id: a.id, name: a.name, rows: before.length, before: paintedRows(look, before.slice(0, PREVIEW_ROWS) as LookRows), after: paintedRows(look, after.slice(0, PREVIEW_ROWS) as LookRows), stored: { before, after } }];
    });
    return { canvas, impact, broken, adaptable };
  };
  /** What putting a whole canvas would do; over an existing one, compared cell by cell (a put says nothing of where each cell went). Looks whose steps come with it follow. */
  const checkCanvasPut = (canvas: Canvas, rows: ReadonlyMap<string, LookRows>, pass: Passes, how: "put" | "restore" = "put") => {
    const old = venue.canvases.get(canvas.id);
    if (!old) return;
    const impact = impactOf(old, canvas, { moved: putMoves(old, canvas) }, looksOn(canvas.id));
    refuseUnlessPassed(
      canvas.name,
      impact,
      impact.looksAffected.filter((l) => l.reason === "steps" && !rows.has(l.id)),
      pass,
      how,
    );
  };
  /**
   * Writes a canvas and the rows of the looks that follow it, all or nothing: every look is checked on the
   * canvas as it will be before the first write, and what was written is put back if a write fails. Only the
   * rows change in a look (its steps, masks or patterns): a rename made meanwhile stays.
   */
  const writeCanvas = (canvas: Canvas, rows: ReadonlyMap<string, LookRows>): Canvas => {
    const next = [...rows].map(([lookId, r]) => {
      const look = show.looks.get(lookId);
      if (!look) throw new Error(say(`look inconnu : ${lookId}`, `unknown look: ${lookId}`));
      if (look.canvas !== canvas.id) throw new Error(say(`« ${look.name} » ne joue pas sur le canevas ${canvas.id}`, `“${look.name}” does not play on canvas ${canvas.id}`));
      const changed = show.looks.parse({ ...look, technique: withRows(look.technique, r) });
      if (changed.technique.kind === "pas" && !fits(changed.technique.steps, canvas.cells))
        throw new Error(say(`« ${look.name} » : chaque pas doit avoir ${canvas.cells} colonne(s), une par cellule`, `“${look.name}”: each step must have ${canvas.cells} column(s), one per cell`));
      try {
        return { before: look, after: checkLook(changed, canvas) };
      } catch (err) {
        throw new Error(say(`« ${look.name} » (${look.id}) : ${(err as Error).message}`, `“${look.name}” (${look.id}): ${(err as Error).message}`));
      }
    });
    // the steps first, then the canvas they follow; written straight to the store (every check is made, and the
    // command that writes is the one line of the activity), so a failed write leaves nothing to explain
    const written: Look[] = [];
    try {
      for (const l of next) {
        show.looks.put(l.after);
        written.push(l.before);
      }
      return venue.canvases.put(canvas);
    } catch (err) {
      for (const l of written) show.looks.put(l); // the canvas is written last: it did not change
      throw err;
    }
  };
  const rowsSchema = z
    .record(z.string(), z.union([z.array(z.array(z.string())), z.array(z.string())]))
    .default({})
    .describe("the looks whose steps follow the canvas, by look id: the steps of a look of exact steps (technique pas, one column per cell), or the masks / patterns of a mask technique; written with the canvas, all or nothing");
  const sharedFlag = z.boolean().default(false).describe("the venue is shared with other shows and that is known: move cells without checking their looks");
  /** Puts a whole canvas (venue.canvas.put, venue.canvas.auto): checked, then written with the looks' rows. */
  const putCanvas = async (value: unknown, opts: Passes & { steps?: Record<string, LookRows>; revision?: string | undefined; how?: "put" | "restore" }) => {
    const canvas = venue.canvases.parse(value);
    sameRevision(canvas.id, venue.canvases.get(canvas.id), opts.revision);
    const rows = new Map(Object.entries(opts.steps ?? {}));
    checkCanvasPut(canvas, rows, opts, opts.how);
    const stored = writeCanvas(canvas, rows);
    const warnings = warningsOf(stored);
    return { ...stored, revision: revisionOf(stored), ...(warnings.length ? { warnings } : {}) };
  };
  reg.register({
    name: "venue.canvas.get",
    title: "Canevas",
    description: "One canvas and its revision (to give back to venue.canvas.edit or venue.canvas.put, which refuse a canvas changed since).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: idSchema,
    run: ({ id: i }) => {
      const canvas = venue.canvases.get(i);
      if (!canvas) throw unknownCanvas(i);
      const warnings = warningsOf(canvas);
      return { canvas, revision: revisionOf(canvas), ...(warnings.length ? { warnings } : {}) };
    },
  });
  reg.register({
    name: "venue.canvas.put",
    title: "Définir un canevas",
    description:
      "Creates or updates a canvas (topology, cell count) and its rendering onto the venue's fixtures (cell ranges → fixture heads). Over an existing canvas, compared cell by cell: when cells move (another count, or the same cells in another order), refused unless force when a look of exact steps on it (technique pas, or a mask read cell by cell) would no longer line up (the error names them) — or give their steps with the canvas (steps), written together, all or nothing — and refused unless shared (or force) when the venue is shared with other shows (their looks are not checked). revision: the one venue.canvas.get gave; refused if the canvas changed since or is gone. warnings: ranges reversed or past the end, fixtures not in the patch, heads they do not have (written anyway: an import may come before the patch). To change a few cells, venue.canvas.edit says what moves and adapts the steps itself.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ canvas: CanvasSchema, steps: rowsSchema, force: z.boolean().default(false).describe("write even if looks of exact steps no longer line up with the cells"), shared: sharedFlag, revision: z.string().optional() }),
    run: ({ canvas, ...opts }) => putCanvas(canvas, opts),
  });
  reg.register({
    name: "venue.canvas.edit",
    title: "Éditer un canevas",
    description:
      "Edits a canvas cell by cell, all operations at once or none: add (fixtures, one cell per full head as venue.canvas.auto, or the heads named, at a position), remove (cells), move (cells, contiguous or not, into the gap before cell `to`), reverse (from..to), duplicate (cells), retarget (cells → other fixture heads, the count unchanged), set (name, topology, columns, notes). Cells are 0-based, read as the previous operations left them; the ranges are written back compacted. impact: cell count before and after, whether cells moved (shifted), and the looks on the canvas it affects: reason steps for a look read cell by cell (technique pas, or a mask as long as the canvas) whose columns no longer line up — refused unless adapt (their columns follow their cells: a removed cell's column goes, an added cell is left untouched; adaptable shows the first rows before and after; the looks and the canvas are written together, all or nothing; steps gives the rows of each adapted look before and after) or force — and reason cells for a generated pattern that changes proportion (it still plays). On a venue shared with other shows, moving cells is refused unless shared (or force). dryRun: what it would do, nothing written. revision: the one an earlier answer (or venue.canvas.get) gave; refused if the canvas changed since.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({
      id: z.string(),
      ops: z.array(CanvasOpSchema).max(200),
      dryRun: z.boolean().default(false),
      force: z.boolean().default(false).describe("write even if looks of exact steps no longer line up with the cells, or the venue is shared"),
      shared: sharedFlag,
      adapt: z.union([z.boolean(), z.array(z.string())]).default(false).describe("adapt the steps of the looks of exact steps it breaks (true: all of them; or their ids)"),
      revision: z.string().optional(),
    }),
    dry: (args) => args.dryRun,
    run: ({ id: i, ops, dryRun, force, shared, adapt, revision }) => {
      const current = venue.canvases.get(i);
      if (!current) throw unknownCanvas(i);
      sameRevision(i, current, revision);
      const { canvas, impact, broken, adaptable: plan } = planEdit(current, ops);
      const chosen = plan.filter((a) => adapt === true || (Array.isArray(adapt) && adapt.includes(a.id)));
      const adapted = chosen.map((a) => a.id);
      const adaptable = plan.map(({ stored: _s, ...a }) => a);
      const warnings = warningsOf(canvas);
      const answer = { canvas, revision: revisionOf(canvas), impact, adaptable, adapted, ...(warnings.length ? { warnings } : {}) };
      if (dryRun) return { ...answer, dryRun: true };
      refuseUnlessPassed(
        canvas.name,
        impact,
        broken.filter((l) => !adapted.includes(l.id)),
        { force, shared },
        "edit",
        adaptable,
      );
      writeCanvas(canvas, new Map(chosen.map((a) => [a.id, a.stored.after])));
      return { ...answer, steps: Object.fromEntries(chosen.map((a) => [a.id, a.stored])) };
    },
  });
  reg.register({
    name: "venue.canvas.delete",
    title: "Supprimer un canevas",
    description: "Deletes a canvas. Refused while a look uses it (the error names the looks, the snapshots and the Panic or startup recall that rely on it), unless force. With force, the looks playing on it are stopped.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: canvasDeletable,
    run: ({ id: i, force }) => {
      const canvas = venue.canvases.get(i);
      if (!canvas) throw new Error(say(`canevas inconnu : ${i}`, `unknown canvas: ${i}`));
      removable("canvas", i, canvas.name, force);
      // Looks still playing on it would stay « active » as ghosts and could not be relaunched.
      for (const l of show.looks.list()) if (l.canvas === i) show.stop(l.id);
      return { deleted: venue.canvases.delete(i) };
    },
  });

  // ---- stage
  reg.register({ name: "stage.zone.list", title: "Zones", description: "Stage zones (type, floor height, tags, protected).", right: "dashboards:view", readOnly: true, profiles: ["setup", "design"], schema: z.object({}), run: () => show.zones.list() });
  reg.register({ name: "stage.zone.put", title: "Zone", description: "Creates or updates a zone: polygon in metres (X stage left→right, Y front→upstage), floor height, type (stage, riser, floor, audience, wall, pillar, truss…), tags, protected.", right: "show:write", profiles: ["setup"], schema: z.object({ zone: ZoneSchema }), run: ({ zone }) => show.zones.put(zone) });
  reg.register({ name: "stage.zone.delete", title: "Supprimer une zone", description: "Deletes a zone.", right: "show:write", profiles: ["setup"], schema: idSchema, run: ({ id: i }) => ({ deleted: show.zones.delete(i) }) });
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
    description: "Builds a canvas from fixtures in the given order: one cell per full head, declared or deduced from the channel names (or per fixture without heads); an accent head (a halo) gets none, a whole-fixture colour reaches it. Topology line, line-mirror or ring. Over an existing canvas, checked as venue.canvas.put (force).",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ id: z.string(), name: z.string(), fixtures: z.array(z.string()).min(1), topology: z.enum(["line", "line-mirror", "ring"]).default("line"), force: z.boolean().default(false).describe("over an existing canvas: as venue.canvas.put"), shared: sharedFlag }),
    run: ({ id: cid, name, fixtures, topology, force, shared }) => {
      const render: { from: number; to: number; targets: { fixture: string; head: number }[] }[] = [];
      let cell = 0;
      for (const fid of fixtures) {
        const r = venue.resolve(fid);
        if ("error" in r) throw new Error(r.error);
        // its full heads, declared or deduced (an accent head, a halo, gets no cell: a colour for the whole fixture reaches it)
        const heads = [...r.heads.keys()].filter((h) => !r.accent.has(h));
        for (const h of heads) render.push({ from: cell, to: cell++, targets: [{ fixture: fid, head: h }] });
      }
      return putCanvas({ id: cid, name, topology, cells: cell, render }, { force, shared });
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
    schema: idSchema,
    run: ({ id: i }) => {
      const l = show.looks.get(i);
      if (!l) throw new Error(say(`look inconnu : ${i}`, `unknown look: ${i}`));
      return { ...l, active: show.isActive(l.id), swatch: swatch(l) };
    },
  });
  const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);
  /**
   * The checks a look passes before it is stored: look.put, and every look a folder command rewrites
   * (all checked before the first write). Its folder tag comes back normalised (segments trimmed, no
   * empty one), so a folder typed « Foo » with a trailing space is the folder « Foo ».
   */
  const checkLook = (look: Look, canvas: Canvas | undefined = venue.canvases.get(look.canvas)): Look => {
    if (!canvas) throw new Error(say(`canevas inconnu : ${look.canvas}`, `unknown canvas: ${look.canvas}`));
    // « jamais coupé » (noCut): only techniques that never switch a cell off
    if (look.noCut && show.stepsOf(look, canvas).some((step) => step.some((c) => c !== null && Object.values(c).every((v) => !v)))) {
      throw new Error(say(`« ${look.name} » est marqué « jamais coupé » mais sa technique éteint des cellules (pas noirs, masques sans plancher, flash…)`, `“${look.name}” is marked “never cut” but its technique turns cells off (black steps, masks without a floor, flash…)`));
    }
    if (look.channels) {
      checkChannels(look.channels.targets);
      const bad = look.channels.steps.findIndex((row) => row.length !== look.channels!.targets.length);
      if (bad >= 0) throw new Error(say(`canaux bruts : le pas ${bad + 1} a ${look.channels.steps[bad]!.length} valeur(s) pour ${look.channels.targets.length} canal(aux)`, `raw channels: step ${bad + 1} has ${look.channels.steps[bad]!.length} value(s) for ${look.channels.targets.length} channel(s)`));
    }
    const folder = folderOf(look.tags);
    // only a move *into* a reserved name is refused: a look an older show already filed there stays editable
    const stored = show.looks.get(look.id);
    if (folder !== undefined && isReservedFolder(folder) && folder !== (stored ? folderOf(stored.tags) : undefined)) throw new Error(say("« Sans dossier » désigne déjà les looks rangés nulle part : choisir un autre nom de dossier", "“No folder” already names the looks filed nowhere: choose another folder name"));
    const tags = folder === undefined ? look.tags : withFolder(look.tags, folder);
    return sameTags(tags, look.tags) ? look : { ...look, tags };
  };
  reg.register({
    name: "look.put",
    title: "Look",
    description: "Creates or updates a look: technique (plat, damier, palette (random: each block draws its colour at random), creux, masques, masques-colores, respiration, orage, flamme, flash, onde = waveform with phase spread/blocks/wings/shuffle, pas, aucune = no colour), canvas, palette, optional raw channels (machines, lamps: targets fixture+offset and DMX values per step, stepped with the look), timing (every beats|seconds, attack 0 claque..1 respire, order), optional move for moving heads (shape fixe|cercle|huit|pan|tilt|tapis|aleatoire = a new point drawn in the box every cycle, center, size, every, spread, wings, reverse, shuffle = phases in a shuffled order, fan, group, fade = {beats: n} or {seconds: n} glide to this move, 0 = cut, absent = the show's moveFade; enabled = reserved, no effect yet). Its ambiance:<intention> tags: a name one intention only answers to is stored as its id; one several answer to stays a name and is returned in ambiguous. " + INTENTION_REFS_HELP,
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
      const saved = show.looks.put(checkLook(migrateTags ? { ...look, tags: migrateTags(look.tags) } : look));
      // an ambiance: tag several intentions answer to stays a name (T15b): said, with which one it goes to
      const ambiguous = ambiguousTags?.(saved.tags) ?? [];
      return ambiguous.length ? { ...saved, ambiguous } : saved;
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
    run: () => TechniqueSchema.options.map((o) => ({ kind: o.shape.kind.value, schema: z.toJSONSchema(o, { io: "input", reused: "inline", unrepresentable: "any" }) })),
  });

  // ---- folders: the looks' `dossier:` tag (show/folders.ts), not an object of its own — a folder
  // born from tags lives as long as its looks; one named ahead (show.folder.create) stays, stored
  // with the show's settings. Every look goes through look.put (its checks and history apply), all of
  // them checked first: a look that no longer passes refuses the whole command before any write.
  /** A folder named as it already is (a command's source): any existing name, « Sans dossier » of an older show included, so it can still be renamed or disbanded. */
  const folderSource = z
    .string()
    .trim()
    .min(1)
    .max(100)
    // slashes at the ends and empty segments are simply dropped (« /X/ » is « X »); what is left must name a folder
    .refine((v) => normalizeFolder(v) !== "", { error: () => say("un nom de dossier ne peut pas être vide", "a folder name cannot be empty") })
    .transform(normalizeFolder)
    .describe("a folder name or path (« Famille/Sous-dossier »)");
  /** A folder a command files looks into or names: not under « Sans dossier », which the list keeps for the looks filed nowhere. */
  const folderName = folderSource
    .refine((v) => !isReservedFolder(v), { error: () => say("« Sans dossier » désigne déjà les looks rangés nulle part : choisir un autre nom", "“No folder” already names the looks filed nowhere: choose another name") })
    .describe("a folder name or path (« Famille/Sous-dossier »), free to create");
  /** Every look in the folder `name`, its whole sub-tree included. */
  const underFolder = (name: string) => show.looks.list().filter((l) => inTree(l.tags, name));
  const setNamedFolders = (next: string[]) => show.saveSettings({ folders: [...new Set(next)].sort((a, b) => a.localeCompare(b)) });
  /** Files each look in its new folder (undefined: « sans dossier »): every look checked first, then only the ones that change written. */
  const refile = async (moves: { look: Look; folder: string | undefined }[], ctx: CommandContext) => {
    const changed = moves.map(({ look, folder }) => ({ ...look, tags: withFolder(look.tags, folder) })).filter((l, i) => !sameTags(l.tags, moves[i]!.look.tags));
    for (const l of changed) {
      try {
        checkLook(l);
      } catch (err) {
        // which look holds the whole folder back: without its name, an orphan look is a needle in the folder
        const why = (err as Error).message;
        throw new Error(say(`« ${l.name} » (${l.id}) : ${why}`, `“${l.name}” (${l.id}): ${why}`));
      }
    }
    for (const l of changed) await reg.invoke("look.put", { look: l }, ctx);
    return moves.length;
  };
  const moveThroughLookPut = (looks: Look[], folder: string | undefined, ctx: CommandContext) => refile(looks.map((look) => ({ look, folder })), ctx);
  reg.register({
    name: "show.folder.create",
    title: "Créer un dossier",
    description: "Names a folder ahead: it exists empty until a look moves into it, and until show.folder.delete dissolves it (a folder only born from looks' tags lives as long as they do).",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ folder: folderName }),
    run: ({ folder }) => {
      setNamedFolders([...show.settings.folders, folder]);
      return { created: folder };
    },
  });
  reg.register({
    name: "show.folder.move",
    title: "Déplacer des looks",
    description: "Puts whole looks (read here, so their steps and raw channels keep) in one folder: the `dossier:` tag of each one is rewritten. Without a folder name, back « sans dossier ».",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ ids: z.array(z.string()).min(1).describe("looks to move, whole unknown ids refused before any write"), folder: folderName.optional() }),
    run: async ({ ids, folder }, ctx) => {
      const looks = [...new Set(ids)].map((i) => {
        const l = show.looks.get(i);
        if (!l) throw new Error(say(`look inconnu : ${i}`, `unknown look: ${i}`));
        return l;
      });
      return { moved: await moveThroughLookPut(looks, folder, ctx) };
    },
  });
  reg.register({
    name: "show.folder.rename",
    title: "Renommer un dossier",
    description: "Renames the `dossier:` tag of every look of the folder, its sub-folders included (their path keeps its tail); renaming onto an existing folder merges the two. A look twice tagged counts under its first folder, and its extra tags are cleaned by the rewrite. Folders named ahead in the subtree move with it.",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ from: folderSource, to: folderName }),
    run: async ({ from, to }, ctx) => {
      if (to.startsWith(from + "/")) throw new Error(say(`« ${to} » serait un sous-dossier de « ${from} »`, `“${to}” would become a sub-folder of “${from}”`));
      if (from === to) return { renamed: 0, from, to };
      const subtree = underFolder(from);
      await refile(subtree.map((look) => ({ look, folder: renamedPath(folderOf(look.tags)!, from, to) })), ctx);
      const stored = show.settings.folders.map((f) => renamedPath(f, from, to));
      if (stored.some((f, i) => f !== show.settings.folders[i])) setNamedFolders(stored);
      return { renamed: subtree.length, from, to };
    },
  });
  reg.register({
    name: "show.folder.delete",
    title: "Dissoudre un dossier",
    description: "Empties a folder, its sub-folders included: every look of them goes back « sans dossier » (the looks stay), and folders named ahead in the subtree stop existing.",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ folder: folderSource }),
    run: async ({ folder }, ctx) => {
      const disbanded = await moveThroughLookPut(underFolder(folder), undefined, ctx);
      const left = show.settings.folders.filter((f) => f !== folder && !f.startsWith(folder + "/"));
      if (left.length !== show.settings.folders.length) setNamedFolders(left);
      return { disbanded };
    },
  });
  reg.register({
    name: "show.folder.nest",
    title: "Nicher un dossier",
    description: "Moves a folder — its looks and sub-folders along — under a parent folder (« B » under « A » becomes « A/B »), or back to the top level when `under` is absent.",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ src: folderSource, under: folderSource.optional() }),
    run: async ({ src, under }, ctx) => {
      const target = nestOf(src, under);
      if (target === src) return { nested: 0, from: src, to: target };
      const exists = underFolder(src).length > 0 || show.settings.folders.some((f) => f === src || f.startsWith(src + "/"));
      if (!exists) throw new Error(say(`dossier inconnu : ${src}`, `unknown folder: ${src}`));
      // dropped where a folder of that name already sits: refused rather than merged unseen (show.folder.rename merges on purpose)
      if (underFolder(target).length > 0 || show.settings.folders.some((f) => f === target || f.startsWith(target + "/"))) throw new Error(say(`« ${target} » existe déjà : renommer « ${src} » pour les fusionner`, `“${target}” already exists: rename “${src}” onto it to merge them`));
      const out = (await reg.invoke("show.folder.rename", { from: src, to: target }, ctx)) as { renamed: number };
      return { nested: out.renamed, from: src, to: target };
    },
  });
  reg.register({
    name: "look.preview",
    title: "Aperçu d'un look",
    description: "Steps a look (saved or not) generates on its canvas: one display colour per cell (\"#rrggbb\", null = untouched), with the canvas shape. `flashes`: `perLoop` is the worst cell's dark-to-lit changes over one cycle of the steps in the order they are played (0 when the look fades or holds still; a cell a step leaves untouched counts as dark, as a preview draws it), `period` the number of steps of that cycle (more than the steps for ping-pong; 2 for a random or weighted order, which can put a flash every two steps), `windows[w]` the most flashes in `w` steps in a row of it (w = 0..period), `max` the photosensitive limit in flashes per second (WCAG 2.3.1): a client counts the flashes of the worst second as `perLoop × whole cycles + windows[rest]` over the steps that start in one second (`ceil(1 / seconds per step)`). A fading attack still counts a change out of an untouched cell, which a preview cuts. Nothing is played.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design"],
    schema: z.object({ look: LookSchema }),
    run: ({ look }) => {
      const canvas = venue.canvases.get(look.canvas);
      if (!canvas) throw new Error(say(`canevas inconnu : ${look.canvas}`, `unknown canvas: ${look.canvas}`));
      const steps = show.stepsOf(look);
      return { cells: canvas.cells, topology: canvas.topology, columns: canvas.columns, steps: steps.map((step) => step.map((c) => (c ? displayHex(c) : null))), flashes: { ...flashProfile(steps, look.timing.attack, look.timing.order, true), max: MAX_FLASHES_PER_SECOND } };
    },
  });
  reg.register({
    name: "look.delete",
    title: "Supprimer un look",
    description: "Deletes a look. Refused while something uses it (see show.references), unless force.",
    right: "show:write",
    profiles: ["design"],
    schema: deletable,
    run: ({ id: i, force }) => (removable("look", i, show.looks.get(i)?.name, force), show.drop(i), { deleted: show.looks.delete(i) }),
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
        const canAnswer = ANSWERING_ORIGINS.includes(ctx.origin);
        throw new CommandError(
          "failed",
          canAnswer ? say(`la règle ${named(asking)} bornerait ce look : le lancer quand même ?`, `rule ${named(asking)} would bound this look: launch it anyway?`) : say(`look non lancé : la règle ${named(asking)} demande une confirmation`, `look not launched: rule ${named(asking)} asks for a confirmation`),
          { confirm: canAnswer, rules: asking.map((b) => b.rule.id) },
        );
      }
      return show.go(i, ctx.origin === "timeline" || ctx.origin === "mcp" || ctx.origin === "ableset");
    },
  });
  reg.register({ name: "look.stop", title: "Arrêter un look", description: "Stops a look.", right: "commands:trigger", profiles: ["design", "live"], schema: idSchema, run: ({ id: i }) => ({ stopped: show.stop(i) }) });
  reg.register({ name: "look.stopall", title: "Tout arrêter", description: "Stops every playing look.", right: "commands:trigger", profiles: ["live"], schema: z.object({}), run: () => ({ stopped: show.stopAll() }) });

  // ---- groups
  reg.register({ name: "group.list", title: "Groupes", description: "Groups (members, sub-groups, selector, master, exclusive, limits) with their effective level and fixtureCount, the fixtures they gather now (a live selector and sub-groups included).", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => {
      const index = show.dcaIndex(); // one snapshot for every group's level
      return show.groups.list().map((g) => ({ ...g, effectiveLevel: show.effectiveLevel(g.id, index), fixtureCount: show.fixturesOf(g.id).size }));
    },
  });
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
    description: "Where a look, a group (DCA), a channel fader, a canvas, a patched fixture or an intention (mood key) is used: groups, channel faders, raw channels of looks, canvases, MIDI mappings, dashboards, snapshots, songs (an intention: their overall mood), looks (canvas; an intention: their ambiance: tag), safe state; for an intention of the personal library with nothing below, the other shows of this machine naming it. Empty when nothing uses it.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({ kind: z.enum(["look", "group", "fader", "canvas", "fixture", "intention"]), id: z.string() }),
    // an intention of the personal library also serves the other shows of this machine: the plugin says which (T15)
    run: ({ kind, id: i }) => ({ uses: kind === "intention" && intentionReferences ? intentionReferences(i) : usesOf(kind, i, parts()) }),
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
      if (fader.range && fader.range.min > fader.range.max) throw new Error(say(`plage du fader inversée : le minimum (${fader.range.min}) dépasse le maximum (${fader.range.max})`, `fader range reversed: the minimum (${fader.range.min}) is above the maximum (${fader.range.max})`));
      if (fader.dca && !show.groups.get(fader.dca)?.master) throw new Error(say(`DCA inconnu : ${fader.dca}`, `unknown DCA: ${fader.dca}`));
      return show.faders.put(fader);
    },
  });
  /** Whether a fader's range leaves part of the travel out (an explicit 0..255 is the whole travel). */
  const narrowed = (range: { min: number; max: number } | undefined) => range !== undefined && (range.min > 0 || range.max < 255);
  reg.register({
    name: "fader.channel",
    title: "Fader d'un canal",
    description: "The fader of one fixture channel, created at its first touch: returns the channel fader driving exactly that channel and nothing else over its whole travel (one narrowed to a function is not reused), or creates one (id panel-<fixture>-<offset>, at `level`; without one, so that creating it switches nothing off: at 1 on the master dimmer of a colour fixture, which such a fader doses, else at the value the channel has on the output now). An existing one is left as it is: move it with fader.level.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ fixture: z.string(), offset: z.number().int().min(0), name: z.string().min(1).optional().describe("the new fader's name; default « <fixture> · <offset + 1> »"), level: z.number().min(0).max(1).optional() }),
    run: ({ fixture, offset, name, level }) => {
      // only a fader over the whole travel is this channel's: one narrowed to a function (T12) is something else
      const own = show.faders.list().find((f) => f.channels.length === 1 && f.channels[0]!.fixture === fixture && f.channels[0]!.offset === offset && !narrowed(f.range));
      if (own) return { ...own, created: false };
      checkChannels([{ fixture, offset }]);
      const patch = venue.fixtures.get(fixture)!;
      const now = engine.output.get(patch.universe)[patch.address - 1 + offset] ?? 0;
      const taken = new Set(show.faders.list().map((f) => f.id));
      const base = `panel-${fixture}-${offset}`;
      let faderId = base;
      for (let k = 2; taken.has(faderId); k++) faderId = `${base}-${k}`;
      // a fader on a colour fixture's master dimmer doses it (runtime.compose): at 1 it changes nothing
      const unchanged = show.dosesDimmer(fixture, offset) ? 1 : Math.round((now / 255) * 1000) / 1000;
      const fader = show.faders.put({ id: faderId, name: name ?? `${patch.name} · ${offset + 1}`, channels: [{ fixture, offset }], level: level ?? unchanged });
      return { ...fader, created: true };
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
  const rulesOf = (w: "venue" | "show") => (w === "venue" ? show.venueRules : show.rules);
  /** The engine's own rules (the Reset protection) are neither replaced nor deleted: their ids are reserved. */
  const refuseBuiltin = (ruleId: string): void => {
    if (isBuiltinRule(ruleId)) throw new Error(say(`la règle ${ruleId} est intégrée au moteur : ni modifiable ni supprimable`, `rule ${ruleId} is built into the engine: it can be neither edited nor deleted`));
  };
  reg.register({ name: "rule.list", title: "Règles", description: "Rules of the venue and of the show (min/max, allowed values, forbidden capabilities like sound-active), the engine's built-in ones (builtin: the Reset channel protection, locked, neither deletable nor editable: a Reset channel is held at rest, never at another maintenance range; fixture.reset lifts it on one fixture's channels for a few seconds), and the values they moved on the last frame.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => ({ builtin: show.builtinRules(), venue: show.venueRules.list(), show: show.rules.list(), clamps: show.lastClamps.slice(0, 100) }) });
  reg.register({ name: "rule.put", title: "Règle", description: "Creates or updates a rule. level: type (fixture model), venue or show; locked rules cannot be relaxed by more specific ones. maxHz bounds a strobe only where its definition gives frequencies in Hz (show.lint names the fixtures where it does nothing); hold bounds the time above a level, maxDegPerSecond the pan/tilt speed, steadySeconds how often a value may change, allowCapabilities the kinds of ranges allowed; onViolation (clamp, confirm, reject) says what a look launch does when the rule would bound it; appliesTo (origins such as mcp, roles) makes it a check on those callers' look launches instead of a bound on the output.", right: "show:write", profiles: ["setup"], schema: z.object({ where, rule: RuleSchema }), run: ({ where: w, rule }) => {
      refuseBuiltin(rule.id);
      return rulesOf(w).put(rule);
    },
  });
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
    schema: idSchema,
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
  reg.register({ name: "rule.delete", title: "Supprimer une règle", description: "Deletes a rule. The engine's built-in ones cannot be; a stored rule bearing a reserved id (saved before it was reserved) can.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ where, id: z.string() }),
    run: ({ where: w, id: i }) => {
      if (!rulesOf(w).get(i)) refuseBuiltin(i);
      return { deleted: rulesOf(w).delete(i) };
    },
  });

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
  reg.register({ name: "dashboard.delete", title: "Supprimer un dashboard", description: "Deletes a dashboard.", right: "show:write", profiles: ["design"], schema: idSchema, run: ({ id: i }) => ({ deleted: dashboards.delete(i) }) });
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
  // the show's intentions too (T15): a version put back goes through intention.put, a mask stays a mask
  const intentions = show.store.collection("intentions", IntentionSchema);
  const VERSIONED = {
    looks: { coll: show.looks, put: "look.put", key: "look" },
    groups: { coll: show.groups, put: "group.put", key: "group" },
    faders: { coll: show.faders, put: "fader.put", key: "fader" },
    dashboards: { coll: dashboards, put: "dashboard.put", key: "dashboard" },
    canvases: { coll: venue.canvases, put: "venue.canvas.put", key: "canvas" },
    intentions: { coll: intentions, put: "intention.put", key: "intention" },
  } as const;
  const versioned = z.enum(["looks", "groups", "faders", "dashboards", "canvases", "intentions"]);
  /** Putting a canvas back is checked as any canvas put (looks of exact steps, a shared venue): `force` passes it on. */
  const restoreForce = z.boolean().default(false).describe("canvases: put it back even if looks of exact steps no longer line up with its cells (as venue.canvas.put)");
  /** A DCA's level and a fader's level are live state: putting a design back never moves the light. */
  const keepLive = (collection: string, old: unknown, now: unknown) => {
    const [o, n] = [old as { master?: unknown; level?: unknown }, now as { master?: unknown; level?: unknown } | undefined];
    if (collection === "intentions") return { ...(old as object), aliases: (old as { aliases?: unknown }).aliases ?? [] }; // put back as it was: a rename it took back leaves no former label (T15b)
    return collection === "groups" && o.master && n?.master ? { ...o, master: n.master } : collection === "faders" && n ? { ...o, level: n.level } : old;
  };
  /** How long after its activity line a change's history copy may be stamped. */
  const UNDO_SLACK_MS = 2000;
  reg.register({
    name: "history.list",
    title: "Versions",
    description: "Earlier versions of a look, group, channel fader, dashboard, canvas or intention of the show (a copy is kept at each change and at deletion, so a deleted one is listed too), newest first: stamp and when it was replaced.",
    right: "show:write",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({ collection: versioned, id: z.string() }),
    run: ({ collection, id: i }) => VERSIONED[collection].coll.versions(i).slice(0, 100),
  });
  reg.register({
    name: "history.deleted",
    title: "Récemment supprimés",
    description: "Looks, groups, channel faders, dashboards, canvases (of the venue) or intentions of the show deleted whose last copy is still in the history, newest first: id, name, stamp (for history.restore) and when it was deleted.",
    right: "show:write",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({ collection: versioned }),
    run: ({ collection }) => VERSIONED[collection].coll.deleted().slice(0, 50),
  });
  reg.register({
    name: "history.restore",
    title: "Restaurer une version",
    description: "Puts back an earlier version (stamp from history.list) through the usual put command and its checks (a canvas: refused unless force when looks of exact steps would no longer line up, as venue.canvas.put; shared for a venue shared with other shows); the current version goes to the history in turn, so a restore is undone the same way.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ collection: versioned, id: z.string(), stamp: z.string(), force: restoreForce, shared: sharedFlag }),
    run: async ({ collection, id: i, stamp, force, shared }, ctx) => {
      const v = VERSIONED[collection];
      const old = v.coll.version(i, stamp) as { id?: string; master?: unknown; level?: unknown } | undefined;
      if (!old || old.id !== i) throw new Error(say(`version introuvable : ${collection}/${i} ${stamp}`, `version not found: ${collection}/${i} ${stamp}`));
      if (collection === "canvases") return putCanvas(old, { force, shared, how: "restore" });
      return reg.invoke(v.put, { [v.key]: keepLive(collection, old, v.coll.get(i)) }, ctx);
    },
  });

  reg.register({
    name: "history.undo",
    title: "Annuler une modification",
    description:
      "Undoes one change to a look, group, channel fader, dashboard or canvas, as an activity.list line gives it (its undo, at and until): puts back the version that change replaced, so a deleted object comes back. Changes made to the object after it are undone too: the later activity lines on the same object say which, and by whom (tell the user before). A creation replaced nothing: delete the object instead. A canvas is put back as history.restore does (force, shared), and the looks whose steps that same change adapted (venue.canvas.edit with adapt) get their steps back with it, written together.",
    right: "show:write",
    profiles: ["setup", "design"],
    // what the activity log offers undo on (activity.ts): intentions go back through history.restore
    schema: z.object({ collection: z.enum(UNDOABLE_COLLECTIONS), id: z.string(), at: z.number(), until: z.number().optional(), force: restoreForce, shared: sharedFlag }),
    run: async ({ collection, id: i, at, until, force, shared }, ctx) => {
      const versions = VERSIONED[collection].coll.versions(i); // newest first
      // the copy a change keeps is written while it runs: just after its line's time
      const end = (until ?? at) + UNDO_SLACK_MS;
      const replaced = versions.filter((x) => Date.parse(x.at) >= at && Date.parse(x.at) <= end);
      const before = replaced[replaced.length - 1];
      if (!before) throw new Error(say(`rien à annuler pour ${i} : cette modification n'a remplacé aucune version (une création s'annule en supprimant l'objet)`, `nothing to undo for ${i}: this change replaced no version (a creation is undone by deleting the object)`));
      if (collection === "canvases") {
        // the looks whose steps the same change adapted go back with the canvas: the version each kept while it ran.
        // Only when the undo moves cells, and only for the looks it would break without them: a look.put that
        // merely fell in the same two seconds (a rename of the canvas, then steps typed) is not this change's.
        const canvas = venue.canvases.parse(venue.canvases.version(i, before.stamp));
        const now = venue.canvases.get(i);
        const needy = new Set(now ? impactOf(now, canvas, { moved: putMoves(now, canvas) }, looksOn(i)).looksAffected.flatMap((l) => (l.reason === "steps" ? [l.id] : [])) : []);
        const steps: Record<string, LookRows> = {};
        for (const l of looksOn(i)) {
          if (!needy.has(l.id)) continue;
          const kept = show.looks.versions(l.id).filter((x) => Date.parse(x.at) >= at && Date.parse(x.at) <= end);
          const was = kept.length ? (show.looks.version(l.id, kept[kept.length - 1]!.stamp) as Look | undefined) : undefined;
          const rows = was?.technique.kind === l.technique.kind ? rowsOfTechnique(was.technique) : undefined;
          if (rows && (was!.technique.kind !== "pas" || fits(rows as string[][], canvas.cells))) steps[l.id] = rows;
        }
        await putCanvas(canvas, { force, shared, steps, how: "restore" });
      } else await reg.invoke("history.restore", { collection, id: i, stamp: before.stamp }, ctx);
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
    // a creation of intention.put (no id) gets its generated id when proposed (show.propose pins it, T15b); a
    // lone show.diff reads it as new. A label without a letter or a digit is refused, as the command does
    intentions: {
      validate: (v: unknown) => {
        const o = (v && typeof v === "object" ? v : {}) as { id?: unknown; label?: unknown };
        return intentions.validate({ ...o, id: o.id ?? (normalizeMood(typeof o.label === "string" ? o.label : "") ? newIntentionId(0) : "") });
      },
      get: (i: string) => intentions.get(i),
      delete: (i: string) => intentions.delete(i),
      put: (v: unknown) => intentions.put(v),
    },
  } as const;
  type Diffable = keyof typeof DIFFABLE;
  type Store = { validate(v: unknown): { id: string }; get(id: string): unknown; delete(id: string): boolean; put(v: unknown): unknown };
  /**
   * The write commands a proposal can hold (and light call … --check): their collection, the argument carrying the object, the arguments kept beside it.
   * An edit (venue.canvas.edit) carries operations, not the object: `plan` computes what it would write (and what it does to the looks, or why
   * it cannot be proposed), and `restore` is the put that takes it back.
   */
  const PUT_COMMANDS: Record<string, { collection: (a: Record<string, unknown>) => Diffable; key: string; keep?: string[]; plan?: (a: Record<string, unknown>) => { object: unknown; impact?: Impact }; restore?: string }> = {
    "look.put": { collection: () => "looks", key: "look" },
    "group.put": { collection: () => "groups", key: "group" },
    "fader.put": { collection: () => "faders", key: "fader" },
    "dashboard.put": { collection: () => "dashboards", key: "dashboard" },
    "palette.put": { collection: () => "palettes", key: "palette" },
    "stage.zone.put": { collection: () => "zones", key: "zone" },
    "rule.put": { collection: (a) => (a.where === "venue" ? "venueRules" : "rules"), key: "rule", keep: ["where"] },
    "venue.fixture.put": { collection: () => "fixtures", key: "fixture" },
    "venue.canvas.put": {
      collection: () => "canvases",
      key: "canvas",
      // looks' steps written with the canvas would show in no preview, and no take-back would put them back
      plan: (a) => {
        if (a.steps && typeof a.steps === "object" && Object.keys(a.steps).length) throw new Error(say("les pas donnés avec le canevas (steps) ne se prévisualisent pas : passer les looks par look.put", "steps given with the canvas (steps) cannot be previewed: give the looks with look.put"));
        return { object: a.canvas };
      },
    },
    "venue.canvas.edit": {
      collection: () => "canvases",
      key: "canvas",
      restore: "venue.canvas.put",
      plan: (a) => {
        if (a.adapt) throw new Error(say("une proposition n'adapte pas les pas des looks : l'enlever (adapt) et éditer le canevas directement", "a proposal does not adapt the steps of looks: drop adapt and edit the canvas directly"));
        if (a.dryRun) throw new Error(say("une proposition n'est pas un essai : enlever dryRun", "a proposal is not a dry run: drop dryRun"));
        const current = venue.canvases.get(String(a.id));
        if (!current) throw unknownCanvas(String(a.id));
        // the revision the proposal was made on (show.propose pins it): a canvas changed since is not the one that was shown
        sameRevision(current.id, current, typeof a.revision === "string" ? a.revision : undefined);
        const { canvas, impact, broken, adaptable } = planEdit(current, z.array(CanvasOpSchema).parse(a.ops ?? []));
        // what apply would refuse is said now, with the proposal: a forced one carries its impact in the preview
        refuseUnlessPassed(canvas.name, impact, broken, { force: a.force === true, shared: a.shared === true }, "edit", adaptable);
        return { object: canvas, impact };
      },
    },
    // the show's intentions only: the personal library is not the show's to propose
    "intention.put": {
      collection: (a) => {
        if (a.scope === "personal") throw new CommandError("invalid", say("pas de proposition pour une intention de la bibliothèque personnelle : seulement celles du show", "no proposal for an intention of the personal library: only the show's"));
        return "intentions";
      },
      key: "intention",
      keep: ["scope"],
    },
  };
  const putOf = (command: string) => {
    const p = PUT_COMMANDS[command];
    if (!p) throw new Error(say(`pas de proposition pour ${command} : ${Object.keys(PUT_COMMANDS).join(", ")}`, `no proposal for ${command}: ${Object.keys(PUT_COMMANDS).join(", ")}`));
    return p;
  };
  const targetOf = (command: string, args: Record<string, unknown>) => {
    const p = putOf(command);
    return { collection: p.collection(args), ...(p.plan ? p.plan(args) : { object: args[p.key] }) };
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
      "Proposal before a write: what putting this object would change, field by field (path, before, after), checked by the same schema as the put command (defaults filled in), nothing written. new = it does not exist yet. Show it to the user and write only on their yes; the put command may still refuse it for its own reasons (a cycle, a partial look). Give a collection (looks, groups, faders, dashboards, palettes, zones, rules (show), venueRules, fixtures, canvases) and the object, or the put command and its arguments (look.put, group.put, fader.put, dashboard.put, palette.put, stage.zone.put, rule.put, venue.fixture.put, venue.canvas.put, venue.canvas.edit: the canvas its operations would write, without adapting steps). Several changes to apply together: show.propose.",
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
  /** `wrote`: a fingerprint of what the apply left (live levels aside), to tell a later edit before taking it back. */
  type Applied = Change & { collection: Diffable; id: string; before?: unknown; wrote?: string };
  /** An object as an undo compares it: a fader's level and a group's master move live, they are no edit. */
  const fingerprint = (collection: string, obj: unknown): string => {
    if (obj === undefined) return "";
    const o = obj as Record<string, unknown>;
    const { level: _l, ...noLevel } = o;
    const { master: _m, ...noMaster } = o;
    return stableStringify(collection === "faders" ? noLevel : collection === "groups" ? noMaster : o);
  };
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
    /** Order of the applies (two can share a millisecond): which of two proposals came last. */
    appliedSeq?: number;
    /** Writes made with it outside the put commands (another show's looks, a fader emptied): done once it applies, taken back once it is reverted. */
    hooks?: ProposalHooks;
  }
  const proposals = new Map<string, Proposal>();
  let applySeq = 0;
  const PROPOSAL_KEEP_MS = 24 * 3600_000;
  const proposalOf = (id: string) => {
    const p = proposals.get(id);
    // `gone`: nothing to act on any more (a screen may forget it), unlike a refusal it could pass
    if (!p) throw new CommandError("failed", say(`proposition inconnue : ${id}`, `unknown proposal: ${id}`), { gone: true });
    return p;
  };
  const previewOf = (c: Change) => {
    let target: { collection: Diffable; object: unknown; impact?: Impact };
    try {
      target = targetOf(c.command, c.args);
    } catch (err) {
      // an edit whose operations cannot apply: invalid, as a put the schema refuses
      return { command: c.command, valid: false as const, collection: putOf(c.command).collection(c.args), issues: [err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (err as Error).message] };
    }
    return { command: c.command, ...diffOf(target.collection, target.object), ...(target.impact?.looksAffected.length ? { impact: target.impact } : {}) };
  };
  /**
   * Puts the objects back as they were before (newest first): the ones created go. A canvas is put back
   * like any canvas put (looks of exact steps checked) unless `force`: the rollback of a failed apply puts
   * back what was there a moment ago, and forces.
   *
   * Every canvas is checked before the first object goes back, so a refusal leaves the proposal whole. The
   * check is the cautious one: it reads the looks as they are now, not as the take-back will leave them, so a
   * proposal that changed a canvas and the steps of its looks together is refused though it would line up
   * again; `force` takes it back.
   */
  const takeBack = async (done: Applied[], ctx: Parameters<Parameters<typeof reg.register>[0]["run"]>[1], pass: Passes = { force: false, shared: false }) => {
    for (const a of done) if (a.collection === "canvases" && a.before !== undefined) checkCanvasPut(venue.canvases.parse(a.before), new Map(), pass, "restore");
    // newest first, the fixtures before anything else: looks, faders and canvases are checked against a fixture's
    // mode (checkChannels, its heads), so a mode change (venue.fixture.mode) must be undone before what it carried
    const newestFirst = [...done].reverse();
    // what each object was just before it went back: a put refused midway (a look whose channels the restored mode
    // no longer has) puts these back as they were, written directly, so the take-back is all or nothing too
    const touched: { a: Applied; was: unknown }[] = [];
    try {
      for (const a of [...newestFirst.filter((x) => x.collection === "fixtures"), ...newestFirst.filter((x) => x.collection !== "fixtures")]) {
        const coll = DIFFABLE[a.collection] as Store;
        touched.push({ a, was: coll.get(a.id) });
        if (a.before === undefined) coll.delete(a.id);
        else if (a.collection === "canvases") await putCanvas(a.before, { ...pass, how: "restore" });
        else {
          const p = putOf(a.command);
          await reg.invoke(p.restore ?? a.command, { ...Object.fromEntries((p.keep ?? []).map((k) => [k, a.args[k]])), [p.key]: keepLive(a.collection, a.before, coll.get(a.id)) }, ctx);
        }
      }
    } catch (err) {
      for (const { a, was } of touched.reverse()) {
        const coll = DIFFABLE[a.collection] as Store;
        if (was === undefined) coll.delete(a.id);
        else coll.put(was);
      }
      throw err;
    }
  };
  const ChangeSchema = z.object({ command: z.enum(Object.keys(PUT_COMMANDS) as [string, ...string[]]), args: z.record(z.string(), z.unknown()) });
  reg.register({
    name: "show.propose",
    title: "Proposer des changements",
    description:
      "Holds several changes (put commands and their arguments, as show.diff takes them) as one proposal, nothing written: each is checked and described field by field. One change per canvas (a whole put, or one venue.canvas.edit with several operations). Someone who may write applies it all or nothing (show.apply, or the Show page), show.revert takes it back together. For an AI client: propose, show the user what it does, apply on their yes — or leave it for them in the interface.",
    right: "show:propose",
    profiles: ["setup", "design"],
    schema: z.object({ changes: z.array(ChangeSchema).min(1).max(50), title: z.string().max(200).optional() }),
    run: ({ changes, title }, ctx) => {
      // a new intention gets its id now (T15b): applied, taken back and applied again, it is that one
      changes = changes.map((c) => {
        const i = c.command === "intention.put" ? (c.args.intention as { id?: unknown; label?: unknown } | undefined) : undefined;
        // an empty label stays without id: refused below as the command refuses it
        return i && typeof i === "object" && i.id === undefined && normalizeMood(typeof i.label === "string" ? i.label : "") ? { ...c, args: { ...c.args, intention: { ...i, id: freshIntentionId() } } } : c;
      });
      const preview: ReturnType<typeof previewOf>[] = changes.map(previewOf);
      // one change per canvas: a second one would be read on a canvas the first has already changed (cell indices, the revision pinned below)
      const canvasesSeen = new Set<string>();
      changes.forEach((c, k) => {
        const p = preview[k]!;
        if (!p.valid || p.collection !== "canvases") return;
        if (canvasesSeen.has(p.id)) preview[k] = { command: c.command, valid: false, collection: "canvases", issues: [say(`un seul changement par canevas (${p.id} est déjà changé par cette proposition) : un put complet ou une édition à plusieurs opérations`, `one change per canvas (${p.id} is already changed by this proposal): a whole put or one edit with several operations`)] };
        canvasesSeen.add(p.id);
      });
      const invalid = preview.filter((x) => !x.valid);
      if (invalid.length) return { valid: false, preview };
      // an edit is a list of cell indices: it is applied to the canvas that was shown, or not at all
      changes = changes.map((c) => {
        const current = c.command === "venue.canvas.edit" && c.args.revision === undefined ? venue.canvases.get(String(c.args.id)) : undefined;
        return current ? { ...c, args: { ...c.args, revision: revisionOf(current) } } : c;
      });
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
      // writes made beside the puts were planned on what was there then: they are not replayed later
      if (p.status === "reverted" && p.hooks) throw new CommandError("invalid", say(`« ${p.title ?? id} » ne se refait pas : le relancer (son plan est relu sur ce qui est là maintenant)`, `“${p.title ?? id}” cannot be redone: run it again (its plan is read again on what is there now)`));
      const done: Applied[] = [];
      try {
        for (const c of p.changes) {
          const { collection, object } = targetOf(c.command, c.args);
          const coll = DIFFABLE[collection] as Store;
          const target = coll.validate(object).id;
          const before = coll.get(target);
          await reg.invoke(c.command, c.args, ctx);
          done.push({ ...c, collection, id: target, ...(before !== undefined ? { before } : {}), ...(p.hooks ? { wrote: fingerprint(collection, coll.get(target)) } : {}) });
        }
        // the writes beside the puts belong to the all or nothing: on their failure everything goes back
        if (p.hooks) {
          try {
            await p.hooks.apply();
          } catch (err) {
            await p.hooks.revert();
            throw err;
          }
        }
      } catch (err) {
        try {
          await takeBack(done, ctx, { force: true, shared: true });
        } catch (back) {
          // the take-back itself failed: what it could not put back is said, never a bare error (the state is partial)
          const left = done.map((a) => `${a.collection}/${a.id}`).join(", ");
          throw new CommandError(
            "failed",
            say(
              `proposition non appliquée, et la remise en état a échoué : l'état est PARTIEL. Écrit et peut-être pas remis : ${left}. Cause : ${(err as Error).message} ; remise : ${(back as Error).message}`,
              `proposal not applied, and putting things back failed: the state is PARTIAL. Written and maybe not put back: ${left}. Cause: ${(err as Error).message}; take-back: ${(back as Error).message}`,
            ),
            { proposal: id, partial: done.map((a) => ({ collection: a.collection, id: a.id })) },
          );
        }
        throw new CommandError("failed", say(`proposition non appliquée, rien n'a changé : ${(err as Error).message}`, `proposal not applied, nothing changed: ${(err as Error).message}`), { proposal: id });
      }
      Object.assign(p, { status: "applied", applied: done, appliedAt: Date.now(), appliedSeq: ++applySeq, ...(ctx.who ? { appliedBy: ctx.who } : {}) });
      return { id, applied: done.length };
    },
  });
  reg.register({
    name: "show.revert",
    title: "Défaire une proposition",
    description:
      "Takes an applied proposal back as a whole: the objects it changed return to what they were just before it (later changes to them go too), the ones it created are removed; a put refused midway puts everything back as it was (nothing half undone). show.apply applies it again (redo), except a mode change (venue.fixture.mode), which is run again instead. A canvas is put back as venue.canvas.put does it, every canvas checked before the first object goes back, on the looks as they are now (force; shared for a venue shared with other shows). A mode change is taken back only over objects unchanged since (`detail.changed` lists the others; overwrite: true takes it back over them), and never while a later mode change still applied wrote the same objects (`detail.blockedBy`: take that one back first).",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({
      id: z.string(),
      force: z.boolean().default(false).describe("put a canvas back even if looks of exact steps no longer line up with its cells"),
      overwrite: z.boolean().default(false).describe("take a mode change back over objects edited since it"),
      shared: sharedFlag,
    }),
    run: async ({ id, force, overwrite, shared }, ctx) => {
      const p = proposalOf(id);
      if (p.status !== "applied") throw new CommandError("failed", say("proposition non appliquée : rien à défaire", "proposal not applied: nothing to take back"), { gone: true });
      p.hooks?.guard?.(); // made on another show or venue than the one open now: refused before anything moves
      if (p.hooks) {
        const storeOf = (a: Applied) => DIFFABLE[a.collection] as Store;
        const changed = p.applied!.filter((a) => a.wrote !== undefined && fingerprint(a.collection, storeOf(a).get(a.id)) !== a.wrote);
        const same = (a: Applied, b: Applied) => a.collection === b.collection && a.id === b.id;
        // a later mode change still applied wrote these objects: taking this one back first would put back offsets of a
        // mode the other fixture no longer has. Never forced: the later one goes back first
        const later = [...proposals.values()].filter((q) => q !== p && q.status === "applied" && q.hooks && (q.appliedSeq ?? 0) > (p.appliedSeq ?? 0) && q.applied!.some((b) => changed.some((a) => same(a, b))));
        if (later.length) {
          const titles = later.map((q) => say(`« ${q.title ?? q.id} »`, `“${q.title ?? q.id}”`)).join(", ");
          throw new CommandError("invalid", say(`défaire d'abord ${titles} : il a réécrit les mêmes objets depuis`, `take back ${titles} first: it rewrote the same objects since`), { blockedBy: later.map((q) => ({ id: q.id, title: q.title ?? q.id })) });
        }
        if (changed.length && !overwrite) {
          const kind: Record<string, string> = { fixtures: say("appareil", "fixture"), looks: "look", faders: "fader", canvases: say("canevas", "canvas"), groups: say("groupe", "group") };
          const list = changed.map((a) => ({ collection: a.collection, id: a.id, name: (storeOf(a).get(a.id) as { name?: string } | undefined)?.name ?? a.id }));
          const said = list.map((c) => `${kind[c.collection] ?? c.collection} ${say(`« ${c.name} »`, `“${c.name}”`)}`).join(", ");
          throw new CommandError("invalid", say(`changé depuis : ${said}. Le défaire remettrait leur état d'avant et perdrait ces modifications : overwrite: true`, `changed since: ${said}. Taking it back would put their earlier state back and lose these edits: overwrite: true`), { changed: list, overwrite: true });
        }
      }
      await takeBack(p.applied!, ctx, { force, shared });
      const warnings = (await p.hooks?.revert()) ?? [];
      p.status = "reverted";
      return { id, reverted: p.applied!.length, ...(warnings.length ? { warnings } : {}) };
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
  reg.register({ name: "show.settings", title: "Réglages du show", description: "Show settings: safe snapshot or safe look recalled by « Panic neutre », startup snapshot, grand master, default button mode, moveFade (default glide of the heads, {beats} or {seconds}), restPositions (per moving head, where it returns when nobody moves it).", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => show.settings });
  reg.register({
    name: "show.settings.set",
    title: "Modifier les réglages du show",
    description: "Updates show settings (safeSnapshot, startupSnapshot: the snapshot recalled when the application starts or the show is opened, safeLook, grandMaster, grandMasterSmoothing: the grand master glides to its level, msPerStep per 1/255 of the travel, null = at once, defaultButtonMode, liveAi: whether AI clients may touch up the service live with live.adjust, looksMerge: several looks on the same fixtures, « last » the last one started covers the others, « highest » each colour keeps its highest value, moveFade: default glide of the heads to a new position, {beats: n} at the current tempo or {seconds: n} (max 30), default {seconds: 1}, 0 = cut, restPositions: per fixture id the {pan, tilt} (0..1) a head nobody moves goes back to, absent = centre; prefer position.rest.set / position.rest.clear, which touch one head at a time).",
    right: "show:write",
    profiles: ["setup", "design"],
    // a patch: only the settings given change (partial() would reset the others to their defaults)
    // null clears a setting: JSON has no « undefined », so a cleared Panic fallback would otherwise never reach here
    schema: patchSchema(ShowSettingsSchema)
      .omit({ schemaVersion: true, kind: true })
      .extend({
        grandMasterSmoothing: FaderSmoothingSchema.nullable().optional(),
        safeLook: z.string().min(1).nullable().optional().describe("the look « Panic neutre » plays; null: none"),
        safeSnapshot: z.string().min(1).nullable().optional().describe("the snapshot « Panic neutre » recalls (wins over safeLook); null: none"),
        startupSnapshot: z.string().min(1).nullable().optional().describe("the snapshot recalled when the application starts (a recent crash resume wins) and when the show is opened; null: none"),
      }),
    run: ({ grandMasterSmoothing, safeLook, safeSnapshot, startupSnapshot, ...rest }) => {
      if (rest.folders) {
        // the list is normalised like a folder command's path, and « Sans dossier » is refused as a name
        rest.folders = [...new Set(rest.folders.map(normalizeFolder).filter(Boolean))];
        const kept = show.settings.folders;
        if (rest.folders.some((f) => isReservedFolder(f) && !kept.includes(f))) throw new Error(say("« Sans dossier » désigne déjà les looks rangés nulle part : choisir un autre nom de dossier", "“No folder” already names the looks filed nowhere: choose another folder name"));
      }
      const patch = {
        ...rest,
        ...(safeLook === undefined ? {} : { safeLook: safeLook ?? undefined }),
        ...(safeSnapshot === undefined ? {} : { safeSnapshot: safeSnapshot ?? undefined }),
        ...(startupSnapshot === undefined ? {} : { startupSnapshot: startupSnapshot ?? undefined }),
      };
      // only the keys ADDED are checked: a stale id kept from a shared venue's deleted fixture is tolerated
      for (const id of Object.keys(patch.restPositions ?? {})) if (!Object.hasOwn(show.settings.restPositions, id) && !venue.fixtures.get(id)) throw new Error(say(`projecteur inconnu : ${id}`, `unknown fixture: ${id}`));
      if (patch.safeLook && !show.looks.get(patch.safeLook)) throw new Error(say(`look inconnu : ${patch.safeLook}`, `unknown look: ${patch.safeLook}`));
      for (const id of [patch.safeSnapshot, patch.startupSnapshot]) if (id && !show.snapshots.get(id)) throw new Error(say(`instantané inconnu : ${id}`, `unknown snapshot: ${id}`));
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
    schema: idSchema,
    run: ({ id: i }) => {
      const snap = show.snapshots.get(i);
      if (!snap) throw new Error(say(`instantané inconnu : ${i}`, `unknown snapshot: ${i}`));
      return { id: i, ...recallSnapshot(engine, show, snap) };
    },
  });
  reg.register({
    name: "snapshot.delete",
    title: "Supprimer un instantané",
    description: "Deletes a snapshot (and unsets it as the safe or startup snapshot).",
    right: "show:write",
    profiles: ["design"],
    schema: idSchema,
    run: ({ id: i }) => {
      if (show.settings.safeSnapshot === i) show.saveSettings({ safeSnapshot: undefined });
      if (show.settings.startupSnapshot === i) show.saveSettings({ startupSnapshot: undefined });
      return { deleted: show.snapshots.delete(i) };
    },
  });

  /** Panic's second half: everything stopped, then the show's safe state. */
  const safeState = () => {
    // no head moves by itself (T25, question 4): they hold where they are until the safe state claims them, gliding
    show.holdPositions();
    show.stopAll();
    show.releasePositions();
    engine.release();
    const snap = show.settings.safeSnapshot ? show.snapshots.get(show.settings.safeSnapshot) : undefined;
    if (snap) {
      const done = recallSnapshot(engine, show, snap);
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
      "Safety: stops every look, a voluntary reset under way (fixture.reset), the DMX console parks and the manual head positions, then recalls the show's safe state: its safe snapshot (the whole state saved ahead), else its safe look, else a Blackout.",
    right: "commands:panic",
    profiles: ["setup", "design", "live"],
    schema: z.object({}),
    run: () => {
      show.rememberBeforePanic(engine.isBlackout()); // a Panic pressed by mistake is undone for a minute (panic.undo)
      show.cancelResets(); // a voluntary reset under way stops: the Reset channels go back to rest
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
  return {
    hookProposal(id, hooks) {
      const p = proposalOf(id);
      if (p.status !== "pending") throw new Error(say(`proposition déjà ${p.status}`, `proposal already ${p.status}`));
      p.hooks = hooks;
    },
  };
}
