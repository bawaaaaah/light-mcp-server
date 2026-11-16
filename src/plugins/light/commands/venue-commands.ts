/**
 * The venue's fixtures: library, patch, presence, channels, orientation, marks, arrangement, DMX explanation, patch check, reset, grouping and delete.
 * Part of the show commands (show-commands.ts registers them all, with the scope they share: show-command-scope.ts).
 */
import { z } from "zod";
import { CommandError } from "./registry.js";
import { DegreeRangeSchema, PatchedFixtureSchema } from "../venue/venue.js";
import { GENERIC_DIMMER, sameName } from "../venue/qxf-import.js";
import { trackNamesProblem } from "../venue/tracks.js";
import { stopsOutsideTravel } from "../venue/stops-check.js";
import { channelModes } from "../venue/channel-modes.js";
import { sameNameMessage, sameSignatureMessage } from "../venue/definition-duplicates.js";
import { GroupSchema } from "../show/model.js";
import { RESET_ORIGINS, RESET_WINDOW_MS, resetChannels } from "../rules/reset-protection.js";
import { TYPE_TAGS } from "../venue/grouping.js";
import { FACING_NAMES, facingOf, orientTo, wrapYaw } from "../venue/orientation.js";
import { arrangeAlong, EDGES, mountHeight } from "../venue/arrange.js";
import { say } from "../../../core/lang.js";
import type { ShowCommandScope } from "./show-command-scope.js";

export function registerVenueCommands(common: ShowCommandScope): void {
  const { reg, engine, show, standby, venue, keepFrozenFlips, removable, sharedWithOrRefuse } = common;
  // ---- venue
  reg.register({
    name: "venue.library",
    title: "Bibliothèque de fixtures",
    titleEn: "Fixture library",
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
    titleEn: "Patch",
    description: "Patched fixtures of the venue (address, mode, role, position, orientation; facing names the orientation when it is one of venue.fixture.orient's; movable says the fixture carries pan or tilt channels: the invert switches live on these only; resolvesAs the manufacturer, model and mode it really plays when its model is an alias of another (library.merge); channels its DMX footprint, the channel count of its mode, missing when its definition or mode is not found).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({}),
    run: () =>
      venue.fixtures.list().map((f) => {
        const r = venue.resolve(f.id);
        const facing = facingOf(f.orientation);
        const base = venue.absent.has(f.id) ? { ...f, absent: true } : f;
        // patched under a model that is an alias (T20b): the definition and mode it really plays
        const aliased = !("error" in r) && (!sameName(r.def.manufacturer, f.manufacturer) || !sameName(r.def.model, f.model));
        return { ...base, ...("error" in r ? {} : { channels: r.mode.channels.length, ...(r.pan || r.tilt ? { movable: true } : {}) }), ...(aliased ? { resolvesAs: { manufacturer: r.def.manufacturer, model: r.def.model, mode: r.mode.name } } : {}), ...(facing ? { facing } : {}) };
      }),
  });
  reg.register({
    name: "venue.fixture.presence",
    title: "Matériel installé ou absent",
    titleEn: "Hardware installed or absent",
    hints: "I",
    changes: ["patch", "settings", "motion"],
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
    titleEn: "Fixture channels",
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
    titleEn: "Patch a fixture",
    hints: "DI",
    changes: ["patch", "motion"],
    description: "Creates or updates a patched fixture (manufacturer/model/mode from the library, universe, 1-based address, role, tags, position). A universe beyond the output's is refused (unless the fixture is already there); `warning` says what is patched anyway: channels shared with another fixture, a fixture ending past channel 512 (its last channels are dropped), a missing definition, absent for this show.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ fixture: PatchedFixtureSchema }),
    run: ({ fixture }) => {
      // a universe the output does not have: its light would go nowhere. A fixture already there (an
      // older patch, a smaller config) can still be edited where it is.
      const before = venue.fixtures.get(fixture.id);
      if (before) keepFrozenFlips(fixture.id, before.orientation, fixture.orientation);
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
    titleEn: "Orient a fixture",
    hints: "",
    changes: ["patch"],
    description:
      "Where a fixture points at rest, for the stage plan and moving-head aiming: facing audience, upstage (the wall behind the stage), houseLeft (jardin, the audience's left), houseRight (cour, the audience's right), ceiling or floor (these two keep the heading); or yaw (degrees: 0 audience, 90 cour, 180 upstage, -90 jardin) and pitch (-90 floor .. 90 ceiling); or turn, degrees added to the heading. A moving head pointed at the floor hangs, at the ceiling stands. roll turns the body around its beam: 0 a bar lies across, 90 it stands (its first head at the bottom). For a moving head whose pan or tilt runs the other way round (a maker's wiring choice), invertPan / invertTilt flips the 0..1 position on its channel(s); swapPanTilt exchanges its pan and tilt channels. Manual calibration (T8): panOffset / tiltOffset, degrees where the beam really falls for a given position (aiming takes them off; the pad's positions do not change); limits, the useful stops per axis as [from, to] in logical degrees (0 = centre of the travel, before the offsets): aiming beyond them is refused as out of reach and the output is bounded to them (a stop given beyond ± half the travel is refused); an axis given null removes its stop, limits null both. Each of these stays as stored when not given. Inverting or swapping is refused while the head is frozen hard.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({
      id: z.string(),
      facing: z.enum(FACING_NAMES).optional(),
      yaw: z.number().optional(),
      pitch: z.number().min(-90).max(90).optional(),
      turn: z.number().optional(),
      roll: z.number().min(-180).max(180).optional(),
      invertPan: z.boolean().optional(),
      invertTilt: z.boolean().optional(),
      swapPanTilt: z.boolean().optional(),
      panOffset: z.number().finite().min(-360).max(360).optional(),
      tiltOffset: z.number().finite().min(-360).max(360).optional(),
      limits: z.object({ pan: DegreeRangeSchema.nullable().optional(), tilt: DegreeRangeSchema.nullable().optional() }).nullable().optional(),
    }),
    run: ({ id: fixtureId, facing, yaw, pitch, turn, roll, invertPan, invertTilt, swapPanTilt, panOffset, tiltOffset, limits }) => {
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
        ...(swapPanTilt !== undefined ? { swapPanTilt } : {}),
        ...(panOffset !== undefined ? { panOffset } : {}),
        ...(tiltOffset !== undefined ? { tiltOffset } : {}),
      };
      // the stops (T8): an axis given replaces its own, null removes it; limits null removes both; not given, kept
      if (limits !== undefined) {
        const next = { ...orientation.limits };
        for (const axis of ["pan", "tilt"] as const) {
          const range = limits?.[axis];
          if (limits === null || range === null) delete next[axis];
          else if (range !== undefined) next[axis] = range;
        }
        if (next.pan || next.tilt) orientation.limits = next;
        else delete orientation.limits;
        // a stop given beyond the travel is a typing slip (or a travel to correct first): it would bound nothing there
        const r = venue.resolve(fixtureId);
        if (limits && !("error" in r)) {
          const outside = stopsOutsideTravel({ pan: limits.pan ?? undefined, tilt: limits.tilt ?? undefined }, r);
          if (outside.length)
            throw new Error(
              say(
                `${f.name} : butée hors de la course (${outside.map((s) => `${s.axis} ± ${s.half}°`).join(", ")}) ; corriger la course d'abord (venue.fixture.travel.set) si elle est fausse`,
                `${f.name}: stop outside the travel (${outside.map((s) => `${s.axis} ± ${s.half}°`).join(", ")}); correct the travel first (venue.fixture.travel.set) if it is wrong`,
              ),
            );
        }
      }
      keepFrozenFlips(fixtureId, f.orientation, orientation);
      const saved = venue.fixtures.put({ ...f, orientation });
      return { fixture: saved, facing: facingOf(saved.orientation) };
    },
  });
  reg.register({
    name: "venue.fixture.mark",
    title: "Nommer ou colorer une fixture",
    titleEn: "Name or colour a fixture",
    hints: "I",
    changes: ["patch"],
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
    titleEn: "Arrange fixtures",
    hints: "I",
    changes: ["patch"],
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
    titleEn: "Why this channel",
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
    titleEn: "Check the patch",
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
    titleEn: "Reset the fixture",
    hints: "",
    changes: ["output", "motion"],
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
    titleEn: "Propose type groups",
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
    titleEn: "Create type groups",
    hints: "",
    changes: ["patch", "groups"],
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
    titleEn: "Unpatch",
    hints: "DI",
    changes: ["patch", "settings", "positions", "motion"],
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
        // and out of the motion lock (T26): a fixture patched later under this id is not frozen by a stale entry
        show.forgetLockedHead(i);
        const { [i]: _gone, ...restPositions } = show.settings.restPositions;
        const absentFixtures = show.settings.absentFixtures.filter((x) => x !== i);
        if (Object.hasOwn(show.settings.restPositions, i) || absentFixtures.length !== show.settings.absentFixtures.length) show.saveSettings({ absentFixtures, restPositions });
      }
      return { deleted, usedBy };
    },
  });
  reg.register({ name: "venue.canvas.list", title: "Canevas", titleEn: "Canvases", description: "Canvases of the venue and their rendering onto fixtures.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design"], schema: z.object({}), run: () => venue.canvases.list() });
}
