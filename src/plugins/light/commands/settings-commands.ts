/**
 * Show settings: read and change.
 * Part of the show commands (show-commands.ts registers them all, with the scope they share: show-command-scope.ts).
 */
import { z } from "zod";
import { FaderSmoothingSchema, ShowSettingsSchema } from "../show/model.js";
import { isReservedFolder, normalizeFolder } from "../show/folders.js";
import { say } from "../../../core/lang.js";
import { patchSchema } from "../../../core/zod-patch.js";
import type { ShowCommandScope } from "./show-command-scope.js";

export function registerSettingsCommands(common: ShowCommandScope): void {
  const { reg, show, venue } = common;
  // ---- show settings & safety
  reg.register({ name: "show.settings", title: "Réglages du show", titleEn: "Show settings", description: "Show settings: safe snapshot or safe look recalled by « Panic neutre », startup snapshot, grand master, default button mode, moveFade (default glide of the heads, {beats} or {seconds}), restPositions (per moving head, where it returns when nobody moves it).", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => show.settings });
  reg.register({
    name: "show.settings.set",
    title: "Modifier les réglages du show",
    titleEn: "Change the show settings",
    hints: "I",
    changes: ["settings", "patch", "shows", "looks"],
    description: "Updates show settings (safeSnapshot, startupSnapshot: the snapshot recalled when the application starts or the show is opened, safeLook, grandMaster, grandMasterSmoothing: the grand master glides to its level, msPerStep per 1/255 of the travel, null = at once, defaultButtonMode, liveAi: whether AI clients may touch up the service live with live.adjust, looksMerge: several looks on the same fixtures, « last » the last one started covers the others, « highest » each colour keeps its highest value, moveFade: default glide of the heads to a new position, {beats: n} at the current tempo or {seconds: n} (max 30), default {seconds: 1}, 0 = cut, restPositions: per fixture id the {pan, tilt} (0..1) a head nobody moves goes back to, absent = centre; prefer position.rest.set / position.rest.clear, which touch one head at a time).",
    right: "show:write",
    profiles: ["setup", "design"],
    // a patch: only the settings given change (partial() would reset the others to their defaults)
    // null clears a setting: JSON has no « undefined », so a cleared Panic fallback would otherwise never reach here
    schema: patchSchema(ShowSettingsSchema)
      // the lock (T26) has its own commands and rights: show:write must not lift it
      .omit({ schemaVersion: true, kind: true, motionLock: true })
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
}
