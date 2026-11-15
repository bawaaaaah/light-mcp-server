/**
 * Targets (T24; docs/specs/venue-fixtures-stage.md, « Cible »): 3D points of the stage that moving heads follow. The
 * commands only edit the target objects; the runtime turns an engaged target into a claim of the motion layer (target
 * layer, above the looks, below the manual layer), so priority, transitions, hold, lock and « Rendre la main » are the
 * motion layer's (docs/specs/engine-effects-timing.md, « Couche Mouvement »).
 */
import { z } from "zod";
import { CommandError, type CommandRegistry } from "./registry.js";
import type { ShowRuntime } from "../show/runtime.js";
import { StagePointSchema, TargetSchema, type Target } from "../show/model.js";
import { inUseMessage } from "../show/references.js";
import { claimKey } from "../engine/motion.js";
import { clampPoint, forbiddenZoneAt, fromNormal, type Point3, type StageAxis } from "../venue/target-aim.js";
import { zoneAimPoint } from "../venue/stage.js";
import { say } from "../../../core/lang.js";

/** What a head of a target is doing, said by target.list from the motion layer's last frame. */
type HeadState =
  /** The target holds the head and places it. */
  | { state: "follows" }
  /** The target holds the head but cannot place it: it stays where it is (out of reach, a no-aim zone, no stage position). */
  | { state: "held"; reason: string }
  /** Something stronger holds it: the manual layer, another target engaged later, a lock. */
  | { state: "masked"; by: string | null; layer: string }
  /** « Rendre la main » released the target on this head: it claims it again once engaged again. */
  | { state: "released" }
  /** The target is not engaged (or no frame yet). */
  | { state: "idle" };

const AXES: readonly StageAxis[] = ["x", "y", "z"];

export function registerTargetCommands(reg: CommandRegistry, show: ShowRuntime): void {
  const nameOf = (id: string) => show.venue.fixtures.get(id)?.name ?? id;
  const get = (id: string): Target => {
    const t = show.targets.get(id);
    if (!t) throw new CommandError("invalid", say(`cible inconnue : ${id}`, `unknown target: ${id}`));
    return t;
  };
  /** The heads of a target frozen hard (T26): they ignore it until they are unfrozen, said in `frozen`. */
  const frozenOf = (t: Target) => {
    const frozen = show.targetHeads(t).filter((h) => show.motionLock(h) === "hard");
    return frozen.length ? { frozen } : {};
  };
  const headState = (t: Target, head: string): HeadState => {
    const status = show.motionStatus().get(head);
    const owner = `target:${t.id}`;
    if (!t.engaged || !status) return { state: "idle" };
    const mine = [status.pan, status.tilt].find((a) => a.owner === owner);
    if (mine) return mine.error ? { state: "held", reason: mine.error } : { state: "follows" };
    if (status.released.includes(claimKey({ owner, order: t.engagedAt ?? 0 }))) return { state: "released" };
    return { state: "masked", by: status.pan.owner ?? status.tilt.owner, layer: status.pan.layer };
  };
  /** Engaged targets sharing a head with `t`, the strongest (last engaged) first: who wins a shared head. */
  const sharing = (t: Target, all: Target[]) => {
    const mine = new Set(show.targetHeads(t));
    return all.filter((o) => o.id !== t.id && show.targetHeads(o).some((h) => mine.has(h))).map((o) => o.id);
  };

  reg.register({
    name: "target.list",
    title: "Cibles",
    description:
      "Targets: 3D points (metres) that moving heads follow. Each with its heads (fixtures and group, installed moving heads only) and what each does now (follows; held where it is, with the reason: out of reach, a no-aim zone, no stage position; masked by a stronger layer: the manual position, another target engaged later, a lock; released by « Rendre la main »; idle when not engaged), its effective bounds (its own, else the stage volume), and, among the engaged targets, its priority (1 = engaged last, wins a head it shares) and the targets it shares heads with.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design", "live"],
    schema: z.object({}),
    run: () => {
      const all = show.targets.list();
      const engaged = all.filter((t) => t.engaged).sort((a, b) => (b.engagedAt ?? 0) - (a.engagedAt ?? 0));
      return all.map((t) => ({
        ...t,
        effectiveBounds: show.targetBounds(t),
        heads: show.targetHeads(t).map((id) => ({ id, name: nameOf(id), ...headState(t, id) })),
        ...(t.engaged ? { priority: engaged.indexOf(t) + 1 } : {}),
        sharesWith: sharing(t, all),
      }));
    },
  });

  reg.register({
    name: "target.put",
    title: "Cible",
    description:
      "Creates or updates a target: name, the moving heads that follow it (fixtures and/or a group: their union), point {x,y,z} in metres (bounded to the bounds; absent: kept, or the middle of the bounds at 1.5 m for a new one), optional bounds {min,max} (default: the stage volume), smoothing of the point (as a fader's: curve, msPerStep), fade (how the heads take over when it is engaged, as look.move.fade; default the show's moveFade), color, notes. Whether it is engaged is live state, kept as it is: target.engage changes it.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ target: TargetSchema.extend({ point: StagePointSchema.optional() }) }),
    run: ({ target }) => {
      for (const f of target.fixtures) if (!show.venue.fixtures.get(f)) throw new CommandError("invalid", say(`fixture inconnue : ${f}`, `unknown fixture: ${f}`));
      if (target.group && !show.groups.get(target.group)) throw new CommandError("invalid", say(`groupe inconnu : ${target.group}`, `unknown group: ${target.group}`));
      const cur = show.targets.get(target.id);
      const bounds = show.targetBounds(target);
      const { engaged: _engaged, engagedAt: _at, ...design } = target;
      return show.targets.put({
        ...design,
        point: clampPoint(target.point ?? cur?.point ?? show.newTargetPoint(bounds), bounds),
        engaged: cur?.engaged ?? false,
        ...(cur?.engagedAt === undefined ? {} : { engagedAt: cur.engagedAt }),
      });
    },
  });

  reg.register({
    name: "target.delete",
    title: "Supprimer une cible",
    description: "Deletes a target. Refused while something uses it (a look's move following it, a dashboard widget, a MIDI mapping, a snapshot, a song), unless force.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: z.string(), force: z.boolean().default(false).describe("delete even if a look, widget, mapping, snapshot or song still uses it") }),
    run: async ({ id, force }, ctx) => {
      const t = show.targets.get(id);
      const { uses } = (await reg.invoke("show.references", { kind: "target", id }, ctx)) as { uses: string[] };
      if (uses.length && !force) throw new Error(inUseMessage(t?.name ?? id, uses));
      return { deleted: show.targets.delete(id) };
    },
  });

  const coordinates = { x: z.number().optional(), y: z.number().optional(), z: z.number().optional(), nx: z.number().min(0).max(1).optional(), ny: z.number().min(0).max(1).optional(), nz: z.number().min(0).max(1).optional() };
  reg.register({
    name: "target.set",
    title: "Déplacer une cible",
    description:
      "Moves a target's point: x, y, z in metres, or nx, ny, nz from 0 to 1 across its bounds (for a MIDI fader or OSC: levelArg nx). Partial: the axes not given stay. Bounded to the bounds, never refused (a fader at its end stays valid). Giving x and nx (or y and ny, z and nz) together is refused. The heads that follow it move with it (gliding when the target has a smoothing); heads frozen hard (motion.freeze) ignore it, listed in frozen.",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: z.object({ id: z.string(), ...coordinates }),
    run: (args) => {
      const t = get(args.id);
      const bounds = show.targetBounds(t);
      const p: Partial<Point3> = {};
      for (const a of AXES) {
        const metres = args[a];
        const normal = args[`n${a}`];
        if (metres !== undefined && normal !== undefined) throw new CommandError("invalid", say(`${a} et n${a} ensemble : donner l'un ou l'autre`, `${a} and n${a} together: give one or the other`));
        if (metres !== undefined) p[a] = metres;
        else if (normal !== undefined) p[a] = fromNormal(a, normal, bounds);
      }
      const moved = show.moveTarget(t.id, p);
      return { id: moved.id, point: moved.point, engaged: moved.engaged, ...frozenOf(moved) };
    },
  });

  reg.register({
    name: "target.engage",
    title: "Engager une cible",
    description:
      "on: its heads follow the target (above the looks, below the XY pad and a soft lock); between two engaged targets sharing a head, the last engaged wins it, restart included. off: they go back to what claims them below (a look's move, else rest), gliding. Idempotent. A Panic disengages every target. Heads frozen hard (motion.freeze) ignore it until unfrozen, listed in frozen.",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: z.object({ id: z.string(), on: z.boolean() }),
    run: ({ id, on }) => {
      const t = show.engageTarget(get(id).id, on);
      return { id: t.id, engaged: t.engaged, heads: show.targetHeads(t), ...frozenOf(t) };
    },
  });

  reg.register({
    name: "target.zone",
    title: "Cible sur une zone",
    description:
      "Puts a target's point on a stage zone: its centre, `height` metres above its floor (default 1.5, a standing person's face), bounded. Refused for a no-aim zone while it is closed (no look of its allowLooks plays): the heads would hold at once.",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: z.object({ id: z.string(), zone: z.string(), height: z.number().default(1.5) }),
    run: ({ id, zone, height }) => {
      const t = get(id);
      const zn = show.zones.get(zone);
      if (!zn) throw new CommandError("invalid", say(`zone inconnue : ${zone}`, `unknown zone: ${zone}`));
      const point = zoneAimPoint(zn, height);
      const playing = new Set(show.activeLooks());
      if (zn.noAim && !zn.allowLooks.some((l) => playing.has(l)) && forbiddenZoneAt(point, [zn]))
        throw new CommandError("failed", say(`« ${zn.name} » est interdite aux lyres : la cible y tiendrait les lyres sur place`, `“${zn.name}” is a no-aim zone: the target would hold the heads where they are`));
      const moved = show.moveTarget(t.id, point);
      return { id: moved.id, point: moved.point, engaged: moved.engaged, ...frozenOf(moved) };
    },
  });
}
