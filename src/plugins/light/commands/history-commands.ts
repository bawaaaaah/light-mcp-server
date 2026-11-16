/**
 * Versions: the copy kept of an object at each change (FolderStore history), listed, put back, undone.
 * Part of the show commands (show-commands.ts registers them all, with the scope they share: show-command-scope.ts).
 */
import { UNDOABLE_COLLECTIONS } from "../activity.js";
import { z } from "zod";
import { fits, impactOf, putMoves, rowsOfTechnique, type LookRows } from "../venue/canvas-edit.js";
import type { Look } from "../show/model.js";
import { ColourPresetSchema } from "../show/colour-presets.js";
import { say } from "../../../core/lang.js";
import type { ShowCommandScope } from "./show-command-scope.js";
import type { CanvasCommands } from "./canvas-commands.js";

/** What the history commands lend the proposals: the live state a design put back never moves. */
export interface HistoryCommands {
  /** The version put back with the live state of now kept (a group's master, a fader's level, a target's point and engagement). */
  keepLive: (collection: string, old: unknown, now: unknown) => unknown;
  /** A target's live state: its point and engagement. */
  liveOfTarget: (t: unknown) => { point: unknown; engaged: unknown; engagedAt?: unknown };
}

export function registerHistoryCommands(common: ShowCommandScope, { looksOn, putCanvas, sharedFlag }: Pick<CanvasCommands, "looksOn" | "putCanvas" | "sharedFlag">): HistoryCommands {
  const { reg, show, venue, dashboards, intentions } = common;
  // ---- versions: the copy kept of an object at each change (FolderStore history), put back on demand
  const VERSIONED = {
    looks: { coll: show.looks, put: "look.put", key: "look" },
    groups: { coll: show.groups, put: "group.put", key: "group" },
    faders: { coll: show.faders, put: "fader.put", key: "fader" },
    dashboards: { coll: dashboards, put: "dashboard.put", key: "dashboard" },
    canvases: { coll: venue.canvases, put: "venue.canvas.put", key: "canvas" },
    intentions: { coll: intentions, put: "intention.put", key: "intention" },
    // a target's design (T24): put back through target.put, its point and engagement (live) kept as they are now
    targets: { coll: show.targets, put: "target.put", key: "target" },
    // a named position (T32): put back through position.preset.put, with the basis it had (its freshness then)
    positions: { coll: show.positionPresets, put: "position.preset.put", key: "position" },
    // a colour preset of the show (T41): put back through colour.preset.put, in the show
    colours: { coll: show.store.collection("colours", ColourPresetSchema), put: "colour.preset.put", key: "preset" },
  } as const;
  const versioned = z.enum(["looks", "groups", "faders", "dashboards", "canvases", "intentions", "targets", "positions", "colours"]);
  /** Putting a canvas back is checked as any canvas put (looks of exact steps, a shared venue): `force` passes it on. */
  const restoreForce = z.boolean().default(false).describe("canvases: put it back even if looks of exact steps no longer line up with its cells (as venue.canvas.put)");
  /** A DCA's level and a fader's level are live state: putting a design back never moves the light. */
  /** A target's live state (T24): its point and engagement, moved by target.set / target.engage, never by a design edit. */
  const liveOfTarget = (t: unknown) => {
    const { point, engaged, engagedAt } = t as { point?: unknown; engaged?: unknown; engagedAt?: unknown };
    return { point, engaged, ...(engagedAt === undefined ? {} : { engagedAt }) };
  };
  const keepLive = (collection: string, old: unknown, now: unknown) => {
    const [o, n] = [old as { master?: unknown; level?: unknown }, now as { master?: unknown; level?: unknown } | undefined];
    if (collection === "intentions") return { ...(old as object), aliases: (old as { aliases?: unknown }).aliases ?? [] }; // put back as it was: a rename it took back leaves no former label (T15b)
    if (collection === "targets" && n) return { ...(old as object), ...liveOfTarget(n) }; // where it is and whether it is engaged: live (T24)
    return collection === "groups" && o.master && n?.master ? { ...o, master: n.master } : collection === "faders" && n ? { ...o, level: n.level } : old;
  };
  /** How long after its activity line a change's history copy may be stamped. */
  const UNDO_SLACK_MS = 2000;
  reg.register({
    name: "history.list",
    title: "Versions",
    description: "Earlier versions of a look, group, channel fader, dashboard, canvas, intention, target, named position or colour preset of the show (a copy is kept at each change and at deletion, so a deleted one is listed too), newest first: stamp and when it was replaced.",
    right: "show:write",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({ collection: versioned, id: z.string() }),
    run: ({ collection, id: i }) => VERSIONED[collection].coll.versions(i).slice(0, 100),
  });
  reg.register({
    name: "history.deleted",
    title: "Récemment supprimés",
    description: "Looks, groups, channel faders, dashboards, canvases (of the venue), intentions, targets, named positions or colour presets of the show deleted whose last copy is still in the history, newest first: id, name, stamp (for history.restore) and when it was deleted.",
    right: "show:write",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({ collection: versioned }),
    run: ({ collection }) => VERSIONED[collection].coll.deleted().slice(0, 50),
  });
  reg.register({
    name: "history.restore",
    title: "Restaurer une version",
    description: "Puts back an earlier version (stamp from history.list) through the usual put command and its checks (a target: its point and engagement, live, stay as they are; a canvas: refused unless force when looks of exact steps would no longer line up, as venue.canvas.put; shared for a venue shared with other shows); the current version goes to the history in turn, so a restore is undone the same way.",
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
  return { keepLive, liveOfTarget };
}
