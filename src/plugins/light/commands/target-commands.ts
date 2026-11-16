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
import { clampPoint, forbiddenZoneAt, fromNormal, holdMessage, type Point3, type StageAxis } from "../venue/target-aim.js";
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
    // an axis of the head the target holds but cannot place (pan or tilt alone: a tilt out of reach) holds the head
    const mine = [status.pan, status.tilt].filter((a) => a.owner === owner);
    const error = mine.find((a) => a.error !== undefined)?.error;
    if (error !== undefined) {
      const hold = show.holdOf(error);
      return { state: "held", reason: hold ? holdMessage(hold) : error };
    }
    if (mine.length) return { state: "follows" };
    if (status.released.includes(claimKey({ owner, order: t.engagedAt ?? 0 }))) return { state: "released" };
    return { state: "masked", by: status.pan.owner ?? status.tilt.owner, layer: status.pan.layer };
  };
  /** The other targets sharing a head with `t`, engaged or not, in the show's order (who wins one: `priority`). */
  const sharing = (t: Target, all: Target[]) => {
    const mine = new Set(show.targetHeads(t));
    return all.filter((o) => o.id !== t.id && show.targetHeads(o).some((h) => mine.has(h))).map((o) => o.id);
  };

  reg.register({
    name: "target.list",
    title: "Cibles",
    titleEn: "Targets",
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
    name: "target.volume",
    title: "Volume de la scène",
    titleEn: "Stage volume",
    description:
      "The stage volume (metres, {min,max}): the bounds of a target without bounds of its own — the zones' box 0.5 m around (else a 10 × 8 m stage widened to the placed fixtures), from the floor to 0.5 m above the highest fixture. What a new target's bounds start from in the venue's form.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design", "live"],
    schema: z.object({}),
    run: () => show.targetBounds({}),
  });

  reg.register({
    name: "target.put",
    title: "Cible",
    titleEn: "Target",
    hints: "DI",
    description:
      "Creates or updates a target: name, the moving heads that follow it (fixtures and/or a group: their union), point {x,y,z} in metres (bounded to the bounds; absent: kept, or the middle of the bounds at 1.5 m for a new one), optional bounds {min,max} (default: the stage volume), smoothing of the point (as a fader's: curve, msPerStep), fade (how the heads take over when it is engaged, as look.move.fade; default the show's moveFade), color, notes. Whether it is engaged is live state, kept as it is: target.engage changes it.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ target: TargetSchema.extend({ point: StagePointSchema.optional() }) }),
    run: ({ target }) => {
      for (const f of target.fixtures) {
        const r = show.venue.resolve(f);
        if (!show.venue.fixtures.get(f)) throw new CommandError("invalid", say(`fixture inconnue : ${f}`, `unknown fixture: ${f}`));
        // a fixture with neither pan nor tilt (or whose definition cannot be read) cannot follow a point
        if ("error" in r || (!r.pan && !r.tilt)) throw new CommandError("invalid", say(`« ${nameOf(f)} » n'est pas une lyre (ni pan ni tilt) : elle ne peut pas suivre une cible`, `“${nameOf(f)}” is not a moving head (no pan, no tilt): it cannot follow a target`));
      }
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
    titleEn: "Delete a target",
    hints: "DI",
    description: "Deletes a target. Refused while something uses it (a look's move following it, a dashboard widget, a MIDI mapping, a snapshot, a song), unless force. engaged: true when it was engaged (its heads go back to what claims them below, gliding).",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: z.string(), force: z.boolean().default(false).describe("delete even if a look, widget, mapping, snapshot or song still uses it") }),
    run: async ({ id, force }, ctx) => {
      const t = show.targets.get(id);
      const { uses } = (await reg.invoke("show.references", { kind: "target", id }, ctx)) as { uses: string[] };
      if (uses.length && !force) throw new Error(inUseMessage(t?.name ?? id, uses));
      // a look citing it still says it by name (T28)
      if (uses.length && t) show.rememberGoneName("target", id, t.name);
      // deleting an engaged target lets its heads go (to what claims them below, gliding): said
      return { deleted: show.targets.delete(id), ...(t?.engaged ? { engaged: true } : {}) };
    },
  });

  const coordinates = { x: z.number().optional(), y: z.number().optional(), z: z.number().optional(), nx: z.number().optional(), ny: z.number().optional(), nz: z.number().optional() };
  reg.register({
    name: "target.set",
    title: "Déplacer une cible",
    titleEn: "Move a target",
    hints: "I",
    description:
      "Moves a target's point: x, y, z in metres, or nx, ny, nz from 0 to 1 across its bounds (for a MIDI fader or OSC: levelArg nx; a value past 0 or 1, an OSC float, counts as 0 or 1). Partial: the axes not given stay. Bounded to the bounds, never refused (a fader at its end stays valid). Giving x and nx (or y and ny, z and nz) together is refused. The heads that follow it move with it (gliding when the target has a smoothing); heads frozen hard (motion.freeze) ignore it, listed in frozen.",
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
    titleEn: "Engage a target",
    hints: "",
    description:
      "on: its heads follow the target (above the looks, below the XY pad and a soft lock); between two engaged targets sharing a head, the last engaged wins it, restart included; engaging one already engaged puts it back on top (the last engaged wins) and lifts « Rendre la main » on its heads. off: they go back to what claims them below (a look's move, else rest), gliding; off on a target not engaged changes nothing. A Panic disengages every target. Heads frozen hard (motion.freeze) ignore it until unfrozen, listed in frozen.",
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
    titleEn: "Target on a zone",
    hints: "I",
    description:
      "Puts a target's point on a stage zone: its aiming point (the centre of its surface unless one was placed), `height` metres above its floor (default: the zone's own aiming height, else 1.5, a standing person's face), bounded. Refused when the point, once bounded, lies in a no-aim zone closed now (no look of its allowLooks plays): the heads would hold at once.",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: z.object({ id: z.string(), zone: z.string(), height: z.number().optional() }),
    run: ({ id, zone, height }) => {
      const t = get(id);
      const zn = show.zones.get(zone);
      if (!zn) throw new CommandError("invalid", say(`zone inconnue : ${zone}`, `unknown zone: ${zone}`));
      // where the point really lands (bounded): in a no-aim zone closed now, the heads would hold at once
      const point = clampPoint(zoneAimPoint(zn, height), show.targetBounds(t));
      const closed = forbiddenZoneAt(point, show.closedNoAim());
      if (closed)
        throw new CommandError("failed", say(`« ${closed.name} » est interdite aux lyres : la cible y tiendrait les lyres sur place`, `“${closed.name}” is a no-aim zone: the target would hold the heads where they are`));
      const moved = show.moveTarget(t.id, point);
      return { id: moved.id, point: moved.point, engaged: moved.engaged, ...frozenOf(moved) };
    },
  });
}
