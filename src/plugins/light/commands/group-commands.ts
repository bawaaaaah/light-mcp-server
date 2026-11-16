/**
 * Unified groups (level, mute, flash), exclusive looks, references, the grand master and the AI's live touch-ups.
 * Part of the show commands (show-commands.ts registers them all, with the scope they share: show-command-scope.ts).
 */
import { z } from "zod";
import { CommandError } from "./registry.js";
import { GroupSchema } from "../show/model.js";
import { slugify } from "../data/store.js";
import { exclusiveMoves, nextExclusiveName } from "../show/exclusive.js";
import { usesOf } from "../show/references.js";
import { say } from "../../../core/lang.js";
import type { ShowCommandScope } from "./show-command-scope.js";

export function registerGroupCommands(common: ShowCommandScope): void {
  const { reg, show, intentionReferences, parts, removable, deletable } = common;
  // ---- groups
  reg.register({ name: "group.list", title: "Groupes", titleEn: "Groups", description: "Groups (members, sub-groups, selector, master, exclusive, limits) with their effective level and fixtureCount, the fixtures they gather now (a live selector and sub-groups included).", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => {
      const index = show.dcaIndex(); // one snapshot for every group's level
      return show.groups.list().map((g) => ({ ...g, effectiveLevel: show.effectiveLevel(g.id, index), fixtureCount: show.fixturesOf(g.id).size }));
    },
  });
  reg.register({ name: "group.put", title: "Groupe", titleEn: "Group", hints: "I", changes: ["groups"], description: "Creates or updates a unified group: members (fixtures, looks, sub-groups), selector, optional master, exclusive, limits, included/excluded presets.", right: "show:write", profiles: ["setup", "design"], schema: z.object({ group: GroupSchema }), run: ({ group }) => show.groups.put(group) });
  reg.register({
    name: "group.delete",
    title: "Supprimer un groupe",
    titleEn: "Delete a group",
    hints: "DI",
    changes: ["groups"],
    description: "Deletes a group. Refused while something uses it (sub-group, channel fader DCA, mapping, dashboard, snapshot, song), unless force.",
    right: "show:write",
    profiles: ["setup"],
    schema: deletable,
    run: ({ id: i, force }) => (removable("group", i, show.groups.get(i)?.name, force), { deleted: show.groups.delete(i) }),
  });
  reg.register({
    name: "look.exclusive",
    title: "Groupe exclusif d'un look",
    titleEn: "Exclusive group of a look",
    hints: "",
    changes: ["looks", "groups"],
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
    titleEn: "Where it is used",
    description: "Where a look, a group (DCA), a channel fader, a canvas, a patched fixture, an intention (mood key), a target, a named position, a stage zone or a colour preset (MIDI mappings and song cues naming it) is used: groups, channel faders, raw channels of looks, canvases, targets (a fixture, a group), named positions (a fixture they cover), MIDI mappings, dashboards, snapshots, songs (an intention: their overall mood), looks (canvas; an intention: their ambiance: tag; a target or a named position: a move following it), the patch and rules (a zone: fixtures aiming at it, rules scoped to it), safe state; for an intention of the personal library with nothing below, the other shows of this machine naming it. Empty when nothing uses it.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({ kind: z.enum(["look", "group", "fader", "canvas", "fixture", "intention", "target", "position", "zone", "colour"]), id: z.string() }),
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
  reg.register({ name: "group.level", title: "Niveau de groupe", titleEn: "Group level", hints: "I", changes: ["groups"], description: "Sets a group master level (0..1); adds a master to the group if it has none.", right: "commands:level", profiles: ["live", "design"], schema: z.object({ id: z.string(), level: z.number().min(0).max(1) }), run: ({ id: i, level }) => withMaster(i, { level }) });
  reg.register({
    name: "grandmaster.set",
    title: "Grand master",
    titleEn: "Grand master",
    hints: "I",
    changes: ["settings"],
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
    titleEn: "Live tweak",
    hints: "",
    changes: ["groups", "playback"],
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
  reg.register({ name: "group.mute", title: "Mute de groupe", titleEn: "Group mute", hints: "I", changes: ["groups"], description: "Mutes or unmutes a group master (the level is kept).", right: "commands:level", profiles: ["live"], schema: z.object({ id: z.string(), mute: z.boolean() }), run: ({ id: i, mute }) => withMaster(i, { mute }) });
  reg.register({ name: "group.flash", title: "Flash de groupe", titleEn: "Group flash", hints: "I", changes: ["groups"], description: "Holds a group at 100 % while on.", right: "commands:trigger", profiles: ["live"], schema: z.object({ id: z.string(), on: z.boolean() }), run: ({ id: i, on }) => (show.setFlash(i, on), { id: i, flash: on }) });
}
