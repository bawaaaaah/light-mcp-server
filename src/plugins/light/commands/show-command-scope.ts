/**
 * What the show commands share (show-commands.ts and the files of its domains): the registry, the engine, the show and
 * its venue, the options, and the helpers several domains use (what uses an object, deletes refused while it is used,
 * a frozen head's flips, raw channels checked).
 */
import { z } from "zod";
import { CommandError, type CommandRegistry } from "./registry.js";
import type { DmxEngine } from "../engine/dmx-engine.js";
import { IntentionSchema, newIntentionId, type AmbiguousRef, type Intention } from "../knowledge/intentions.js";
import type { Collection } from "../data/store.js";
import type { Venue } from "../venue/venue.js";
import { inUseMessage, usesOf, type ReferenceKind, type ShowParts } from "../show/references.js";
import type { ShowRuntime } from "../show/runtime.js";
import { DashboardSchema, type Dashboard } from "../dashboards/dashboards.js";
import { say } from "../../../core/lang.js";
import { MappingSchema } from "../midi/mapping.js";
import { SongSchema } from "../songs/songs.js";
import type { HeadFlips } from "../show/motion-lock.js";

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

/** An object's id, the argument of a read or a delete. */
const idSchema = z.object({ id: z.string() });
/** A delete refused while something still uses the object, unless forced. */
const deletable = z.object({ id: z.string(), force: z.boolean().default(false).describe("delete even if a group, fader, mapping, dashboard, snapshot or song still uses it") });
/** A canvas delete, refused while a look still uses it, unless forced. */
const canvasDeletable = z.object({ id: z.string(), force: z.boolean().default(false).describe("delete even if a look still uses it") });

/** What the show commands' domains share (`createShowCommandScope`). */
export interface ShowCommandScope {
  reg: CommandRegistry;
  engine: DmxEngine;
  show: ShowRuntime;
  /** The open venue (`show.venue`). */
  venue: Venue;
  sharedWith: () => string[];
  standby: () => boolean;
  intentionReferences: ShowCommandOptions["intentionReferences"];
  migrateTags: ShowCommandOptions["migrateTags"];
  ambiguousTags: ShowCommandOptions["ambiguousTags"];
  /** A new intention's id (`ShowCommandOptions.newIntentionId`, else one from the clock). */
  freshIntentionId: () => string;
  idSchema: typeof idSchema;
  deletable: typeof deletable;
  canvasDeletable: typeof canvasDeletable;
  keepFrozenFlips: (id: string, before: HeadFlips, after: HeadFlips) => void;
  parts: () => ShowParts;
  removable: (kind: ReferenceKind, i: string, name: string | undefined, force: boolean, otherShows?: string[]) => string[];
  sharedWithOrRefuse: (fixtureId: string, name: string, kind?: "fixture" | "zone") => string[];
  checkChannels: (channels: { fixture: string; offset: number }[]) => void;
  /** The show's dashboards and intentions, opened once with their schemas when the commands are registered. */
  dashboards: Collection<Dashboard>;
  intentions: Collection<Intention>;
}

/** Builds the scope the show commands' domains share. */
export function createShowCommandScope(reg: CommandRegistry, engine: DmxEngine, show: ShowRuntime, options: ShowCommandOptions = {}): ShowCommandScope {
  const dashboards = show.store.collection("dashboards", DashboardSchema);
  // the show's intentions (T15): a version put back goes through intention.put (history-commands.ts), a mask stays a mask
  const intentions = show.store.collection("intentions", IntentionSchema);
  const { sharedWith = () => [], standby = () => false, intentionReferences, migrateTags, ambiguousTags, newIntentionId: freshIntentionId = () => newIntentionId(Date.now()) } = options;
  const venue = show.venue;
  /**
   * « Figer les lyres », hard level (T26): a hard-frozen head keeps its pan/tilt where it is held, a logical position
   * turned into bytes through its inversions and swap. Changing them would send it elsewhere: refused until it is
   * unfrozen (the rest of the patch and the orientation stay editable).
   */
  const keepFrozenFlips = (id: string, before: HeadFlips, after: HeadFlips) => {
    if (!show.flipsMoveFrozen(id, before, after)) return;
    const name = venue.fixtures.get(id)?.name ?? id;
    throw new CommandError(
      "failed",
      say(
        `${name} : lyre figée (tout, pad compris) : inverser ou permuter son pan/tilt la déplacerait ; la défiger d'abord (« Figer les lyres », en haut de l'écran)`,
        `${name}: moving head frozen (everything, pad included): inverting or swapping its pan/tilt would move it; unfreeze it first (“Freeze the heads”, at the top of the screen)`,
      ),
      { refused: [id] },
    );
  };
  /**
   * What uses a look, a group, a fader or a canvas (show/references.ts). Songs and mappings are opened on
   * call, with the schemas the plugin opens them with (a store collection keeps the schema of its first
   * opening, and the plugin opens those two after these commands are registered).
   */
  const parts = (): ShowParts => ({
    groups: show.groups.list(),
    faders: show.faders.list(),
    mappings: show.store.collection("mappings", MappingSchema).list(),
    dashboards: dashboards.list(),
    snapshots: show.snapshots.list(),
    looks: show.looks.list(),
    targets: show.targets.list(),
    positions: show.positionPresets.list(),
    canvases: venue.canvases.list(),
    songs: show.store.collection("songs", SongSchema).list(),
    rules: show.rules.list(),
    venueRules: show.venueRules.list(),
    patch: venue.fixtures.list(),
    safeLook: show.settings.safeLook,
    safeSnapshot: show.settings.safeSnapshot,
    startupSnapshot: show.settings.startupSnapshot,
  });
  /** Deleting what is still used is refused (the error says where), unless `force`. */
  const removable = (kind: ReferenceKind, i: string, name: string | undefined, force: boolean, otherShows: string[] = []) => {
    const uses = usesOf(kind, i, parts());
    if ((uses.length || otherShows.length) && !force) throw new Error(inUseMessage(name ?? i, uses, otherShows, kind === "zone" ? "zone" : "fixture"));
    return uses;
  };
  /**
   * The other shows on the open venue, for a fixture's or a zone's unforced delete (both belong to the venue). When one
   * of their show.json cannot be read, the delete is refused (after what uses it, said first), saying how to delete
   * anyway: `detail.force` lets a screen offer that forced delete, `detail.reason` is what went wrong.
   */
  const sharedWithOrRefuse = (fixtureId: string, name: string, kind: "fixture" | "zone" = "fixture"): string[] => {
    try {
      return sharedWith();
    } catch (err) {
      removable(kind, fixtureId, name, false);
      const reason = (err as Error).message;
      const anyway = kind === "zone" ? say("La supprimer quand même, sans vérifier les autres shows de ce lieu : force: true", "Delete it anyway, without checking the venue's other shows: force: true") : say("Le supprimer quand même, sans vérifier les autres shows de ce lieu : force: true", "Delete it anyway, without checking the venue's other shows: force: true");
      throw new CommandError("invalid", `${reason}. ${anyway}`, { force: true, reason });
    }
  };

  /** Raw channels (fixture + offset) must exist: refused otherwise. */
  const checkChannels = (channels: { fixture: string; offset: number }[]) => {
    for (const c of channels) {
      const problem = venue.channelProblem(c);
      if (problem) throw new Error(problem);
    }
  };

  return { reg, engine, show, sharedWith, standby, intentionReferences, migrateTags, ambiguousTags, freshIntentionId, venue, idSchema, keepFrozenFlips, parts, removable, sharedWithOrRefuse, deletable, canvasDeletable, checkChannels, dashboards, intentions };
}
