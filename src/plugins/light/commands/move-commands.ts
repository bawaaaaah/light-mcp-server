/**
 * Moving heads (docs/specs/venue-fixtures-stage.md, « Lyres »): manual positions (XY pad), aiming at
 * a zone or a point of the stage, release, guided calibration. Move FX are part of looks (`look.move`).
 */
import { z } from "zod";
import { CommandError, type CommandRegistry, type Origin } from "./registry.js";
import type { ShowRuntime } from "../show/runtime.js";
import { calibrate, type CalibrationSample } from "../venue/aim.js";
import { isHung } from "../venue/orientation.js";
import { say } from "../../../core/lang.js";
import { motionEntries } from "../show/motion-report.js";
import { stricter, type HeadLock, type MotionLockState } from "../show/motion-lock.js";
import type { LockLevel } from "../engine/motion.js";

/**
 * Who may loosen the motion lock (T26, decision U3 of 2026-11-14): the interface, a MIDI control a person mapped, an AI
 * client, the command line, the server's own callers. An OSC message, the DJ software (OS2L), AbleSet or a song's
 * timeline (its steps) may freeze but never unfreeze: an automatic cue must not set the heads moving again.
 */
export const UNFREEZE_ORIGINS: readonly Origin[] = ["ui", "midi", "mcp", "cli", "system"];

/** Fixtures given directly or through a group, kept to the moving heads. */
const Target = z.object({ fixtures: z.array(z.string()).optional(), group: z.string().optional() });

/**
 * Beyond this gap between the position asked by hand and the one sent, a head is not there yet (a speed rule holds it
 * back): a little more than one step of an 8-bit axis, the rounding of a position sent.
 */
const ARRIVED = 1.5 / 255;

/**
 * `nextFrame`: resolves true once the engine has rendered a frame after the call, false when none came (the engine does
 * not run), so a command that reads what was really sent sees the commands just before it: a mark recorded right after
 * a pad gesture.
 */
export function registerMoveCommands(reg: CommandRegistry, show: ShowRuntime, nextFrame: () => Promise<boolean> = () => Promise.resolve(true)): void {
  const targets = (t: z.infer<typeof Target>): string[] => {
    const heads = new Set(show.movingHeads());
    if (t.group && !show.groups.get(t.group)) throw new Error(say(`groupe inconnu : ${t.group}`, `unknown group: ${t.group}`));
    const ids = t.fixtures ?? (t.group ? [...show.fixturesOf(t.group)] : [...heads]);
    for (const f of ids) if (!show.venue.fixtures.get(f)) throw new Error(say(`fixture inconnue : ${f}`, `unknown fixture: ${f}`));
    return ids.filter((f) => heads.has(f));
  };
  const nameOf = (id: string) => show.venue.fixtures.get(id)?.name ?? id;
  /**
   * « Figer les lyres », hard level (T26): nothing moves a hard-locked head, the pad included. A command that would
   * move or hand back heads (position.set, .aim, .release, .home) leaves the hard-locked ones out and lists them in
   * `refused`; when every head it targets is hard-locked, it is refused. Never remembered for later: a position set
   * blind would make the head jump when it is unfrozen.
   */
  const unlocked = (ids: string[]): { ids: string[]; refused: string[] } => {
    const refused = ids.filter((f) => show.motionLock(f) === "hard");
    if (refused.length && refused.length === ids.length) {
      const names = refused.map(nameOf).join(", ");
      throw new CommandError(
        "failed",
        say(`lyres figées (tout, pad compris) : ${names} ; les défiger d'abord (motion.unfreeze)`, `moving heads frozen (everything, pad included): ${names}; unfreeze them first (motion.unfreeze)`),
        { refused },
      );
    }
    return { ids: ids.filter((f) => !refused.includes(f)), refused };
  };
  /** `refused` in a reply only when some heads were left out. */
  const refusedOf = (refused: string[]) => (refused.length ? { refused } : {});

  reg.register({
    name: "position.list",
    title: "Lyres",
    description:
      "Moving heads selected by fixtures, a group (selectors and sub-groups included), or all, with their pan/tilt travel, manual position and why each is where it is: sent = the position really sent after the rules and guard; rest = where it goes when unclaimed; motion = per axis the winning layer, every claim still present (layers, one entry per claim, strongest first, rest last), owner, glide and error, then masked and released claims. The same report is pushed on light:motion when it changes.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design", "live"],
    schema: Target,
    run: (t) => {
      const selected = new Set(targets(t));
      return motionEntries(show)
        .filter(({ id }) => selected.has(id))
        .map(({ id, ...why }) => {
          const r = show.venue.resolve(id);
          const f = show.venue.fixtures.get(id)!;
          return { id, name: f.name, panMax: "error" in r ? undefined : r.panMax, tiltMax: "error" in r ? undefined : r.tiltMax, manual: show.manualPosition(id) ?? null, ...why };
        });
    },
  });
  reg.register({
    name: "position.set",
    title: "Position des lyres",
    description:
      "Sets a manual pan/tilt (normalised 0..1, 0.5 = centre) on moving heads (fixtures, a group, or all heads); it wins over the looks' moves until released. Direct, as a gesture: no glide. Pan or tilt alone claims that axis only, the other stays with the layer below. Heads frozen hard (motion.freeze) are left out and listed in refused; refused when all are.",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: Target.extend({ pan: z.number().min(0).max(1).optional(), tilt: z.number().min(0).max(1).optional() }),
    run: ({ pan, tilt, ...t }) => {
      const { ids, refused } = unlocked(targets(t));
      show.setPosition(ids, { ...(pan !== undefined ? { pan } : {}), ...(tilt !== undefined ? { tilt } : {}) });
      return { fixtures: ids, ...refusedOf(refused) };
    },
  });
  /** Moving heads only: a rest position of anything else would never be read. */
  const restTargets = (fixtures: string[]): string[] => {
    const heads = new Set(show.movingHeads());
    for (const f of fixtures) if (!heads.has(f)) throw new Error(say(`pas une lyre installée : ${f}`, `not an installed moving head: ${f}`));
    return fixtures;
  };
  reg.register({
    name: "position.rest.set",
    title: "Position de repos",
    description: "Sets the rest position (normalised 0..1, 0.5 = centre) of moving heads, stored in the show: where a head nobody moves goes back to. Touches only the heads given, others keep theirs. Refused for an id that is not an installed moving head.",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: z.object({ fixtures: z.array(z.string()).min(1), pan: z.number().min(0).max(1), tilt: z.number().min(0).max(1) }),
    run: ({ fixtures, pan, tilt }) => {
      const ids = restTargets(fixtures);
      show.saveSettings({ restPositions: { ...show.settings.restPositions, ...Object.fromEntries(ids.map((id) => [id, { pan, tilt }])) } });
      return { fixtures: ids };
    },
  });
  reg.register({
    name: "position.rest.clear",
    title: "Effacer la position de repos",
    description: "Clears the rest position of moving heads: they go back to the centre. Other heads keep theirs.",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: z.object({ fixtures: z.array(z.string()).min(1) }),
    run: ({ fixtures }) => {
      const drop = new Set(fixtures);
      const restPositions = Object.fromEntries(Object.entries(show.settings.restPositions).filter(([id]) => !drop.has(id)));
      show.saveSettings({ restPositions });
      return { fixtures };
    },
  });
  reg.register({
    name: "position.release",
    title: "Relâcher les lyres",
    description:
      "Releases manual positions (fixtures, a group, or all) and the hold a Panic left on those heads: they glide back to the looks' moves, else to their rest position. Returns the heads released. Heads frozen hard (motion.freeze) are left out and listed in refused; refused when all are.",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: Target,
    run: (t) => {
      const scoped = Boolean(t.fixtures || t.group);
      const { ids, refused } = unlocked(scoped ? targets(t) : show.movingHeads());
      // without a target and nothing frozen hard: every manual position, those of heads out of the patch too
      const which = scoped || refused.length ? ids : undefined;
      // after a Panic the heads hold where they are: handing them back lets them go too
      return { released: [...new Set([...show.releasePositions(which), ...show.releaseHold(which)])], ...refusedOf(refused) };
    },
  });
  reg.register({
    name: "position.releaseTop",
    title: "Rendre la main",
    description:
      "« Rendre la main » on fixtures, a group, or all: finds the strongest top layer present across both axes of the targeted heads (manual, target, look, hold, rest) and releases only the axes at that layer: on one head held manual on pan and by a look on tilt, the first press releases pan only. Axes whose top is a lock (hard, or soft without a manual claim above it) are set aside. Other heads keep theirs; pressing again descends one more claim, gliding to rest. A released look claims again once restarted. Locks are never released: hard releases nothing (those heads are listed in refused), soft permits manual only. Returns, per head, the owners released (manual, look:<id>, hold).",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: Target,
    run: (t) => {
      const scoped = Boolean(t.fixtures || t.group);
      // hard-locked heads release nothing: said in `refused`, as position.release and .home do
      const refused = (scoped ? targets(t) : show.movingHeads()).filter((f) => show.motionLock(f) === "hard");
      return { fixtures: show.releaseTop(scoped ? targets(t) : undefined), ...refusedOf(refused) };
    },
  });
  reg.register({
    name: "position.home",
    title: "Lyres au repos",
    description:
      "Sends moving heads (fixtures, a group, or all) to their rest position, gliding: every claim on them is released — the manual position, the looks' moves (a look started again claims them again), a Panic hold. Returns, per head, what was released. Heads frozen hard (motion.freeze) are left out and listed in refused; refused when all are; under a soft lock only the manual position is released.",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: Target,
    run: (t) => {
      const scoped = Boolean(t.fixtures || t.group);
      const { ids, refused } = unlocked(scoped ? targets(t) : show.movingHeads());
      return { fixtures: show.homePositions(scoped || refused.length ? ids : undefined), ...refusedOf(refused) };
    },
  });
  reg.register({
    name: "position.aim",
    title: "Viser",
    description: "Points moving heads at a stage zone (its centre, at `height` metres above its floor; default 1.5 = a standing person's face) or at a point {x,y,z} in metres. Needs the fixtures' position, mount and orientation (yaw, calibration). Sets a manual position, direct like the XY pad (no glide: the heads go there at once, bounded by the speed rules only); out-of-reach fixtures are reported. Heads frozen hard (motion.freeze) are left out and listed in refused; refused when all are.",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: Target.extend({ zone: z.string().optional(), point: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(), height: z.number().default(1.5) }),
    run: ({ zone, point, height, ...t }) => {
      let target = point;
      if (zone) {
        const zn = show.zones.get(zone);
        if (!zn) throw new Error(say(`zone inconnue : ${zone}`, `unknown zone: ${zone}`));
        const n = zn.polygon.length;
        target = { x: zn.polygon.reduce((a, p) => a + p[0], 0) / n, y: zn.polygon.reduce((a, p) => a + p[1], 0) / n, z: zn.floorHeight + height };
      }
      if (!target) throw new Error(say("zone ou point requis", "zone or point required"));
      const { ids, refused } = unlocked(targets(t));
      return { target, results: show.aim(ids, target), ...refusedOf(refused) };
    },
  });

  // ---- « Figer les lyres » (T26; docs/specs/engine-effects-timing.md, « Couche Mouvement », Verrou;
  // docs/specs/rules-limits.md, « Verrou des lyres »): the commands decide what may harden or loosen, the runtime
  // freezes the heads where they were really sent (setMotionLock)
  /** The looser of two levels. */
  const looser = (a: LockLevel, b: LockLevel): LockLevel => (stricter(a, b) === a ? b : a);
  /** The heads to freeze: given or through a group, kept to the installed moving heads; none is an error. */
  const freezeTargets = (t: z.infer<typeof Target>): string[] => {
    const ids = targets(t);
    if (!ids.length) throw new CommandError("invalid", say("aucune lyre installée à figer dans cette cible", "no installed moving head to freeze in this target"));
    return ids;
  };
  /**
   * The heads to unfreeze: given or through a group, kept to the installed moving heads and to the heads locked on
   * their own (a head marked absent after it was frozen, or an id no longer in the patch, can still be unfrozen).
   */
  const unfreezeTargets = (t: z.infer<typeof Target>, locked: Record<string, HeadLock>): string[] => {
    if (t.group && !show.groups.get(t.group)) throw new Error(say(`groupe inconnu : ${t.group}`, `unknown group: ${t.group}`));
    const ids = t.fixtures ?? (t.group ? [...show.fixturesOf(t.group)] : []);
    for (const f of ids) if (!show.venue.fixtures.get(f) && !Object.hasOwn(locked, f)) throw new Error(say(`fixture inconnue : ${f}`, `unknown fixture: ${f}`));
    const heads = new Set(show.movingHeads());
    return ids.filter((f) => heads.has(f) || Object.hasOwn(locked, f));
  };
  /** Each head's own lock, with these heads set to `level` (`off`: dropped from `heads`). */
  const withHeads = (heads: Record<string, HeadLock>, ids: string[], level: (own: HeadLock | undefined) => LockLevel): Record<string, HeadLock> => {
    const out = new Map(Object.entries(heads));
    for (const id of ids) {
      const next = level(out.get(id));
      if (next === "off") out.delete(id);
      else out.set(id, next);
    }
    return Object.fromEntries(out);
  };
  /** What a freeze or unfreeze leaves: the lock levels, and each head's effective level (the stricter of global and own). */
  const lockReport = (ids: readonly string[]) => ({ ...show.motionLockState(), fixtures: ids.map((id) => ({ id, lock: show.motionLock(id) })) });
  const needPosition = (why: { fr: string; en: string }) => {
    throw new CommandError("forbidden", say(`droit requis : commands:position (${why.fr})`, `right required: commands:position (${why.en})`));
  };
  /** Decision U3: an automatic origin may freeze, never loosen. */
  const mayLoosen = (origin: Origin) => {
    if (!UNFREEZE_ORIGINS.includes(origin))
      throw new CommandError(
        "failed",
        say(
          `défiger refusé depuis ${origin} : un signal automatique (OSC, OS2L, AbleSet, un chant) peut figer les lyres, pas les défiger ; le faire depuis l'interface, un bouton MIDI ou un client IA`,
          `unfreezing refused from ${origin}: an automatic signal (OSC, OS2L, AbleSet, a song) may freeze the moving heads, not unfreeze them; do it from the interface, a MIDI control or an AI client`,
        ),
      );
  };
  /** Anything frozen at all: the global level, or any head's own lock (absent and orphan ids included). */
  const anyFrozen = (lock: MotionLockState) => lock.level !== "off" || Object.keys(lock.heads).length > 0;
  /** Decision U2: the whole lock loosened to `to` — the global level and every head's own. */
  const loosenAll = (lock: MotionLockState, to: LockLevel): MotionLockState => ({
    level: looser(lock.level, to),
    heads: withHeads(lock.heads, Object.keys(lock.heads), (own) => (own ? looser(own, to) : "off")),
  });
  reg.register({
    name: "motion.freeze",
    title: "Figer les lyres",
    description:
      "« Figer les lyres »: the moving heads stay where they really are (the position sent, under a speed rule where the head has got to). soft (default): the looks and targets no longer move them, the XY pad and position.* still do; hard: nothing moves them, pad, aiming and calibration included (the DMX console still does); colours, dimmer, gobos play on. Without fixtures or group: the global lock, over every head; with them: those heads (a group is expanded into its heads now). Only hardens or keeps: asking soft on a hard lock does not loosen it (motion.unfreeze does). toggle: the target switches between free and the level given (global: anything frozen, globally or per head → everything freed, else the global lock at that level; heads: all locked on their own → freed, else locked). Survives a restart. Right commands:freeze for soft; hard and toggle need commands:position too. A toggle that would unfreeze is refused from OSC, OS2L, AbleSet and a song's timeline (they may freeze, never unfreeze). Returns the lock levels and each head's effective level.",
    right: "commands:freeze",
    profiles: ["live", "design", "setup"],
    schema: Target.extend({ level: z.enum(["soft", "hard"]).default("soft"), toggle: z.boolean().default(false) }),
    run: ({ level, toggle, ...t }, ctx) => {
      // decisions Q2 + Q6 of 2026-11-11: whoever has the Panic freezes soft; hard and unfreezing (a toggle may) are the desk's
      if (level === "hard" && !ctx.can("commands:position")) needPosition({ fr: "figer tout, pad compris", en: "freeze everything, pad included" });
      if (toggle && !ctx.can("commands:position")) needPosition({ fr: "la bascule peut défiger", en: "the toggle may unfreeze" });
      const cur = show.motionLockState();
      let next: MotionLockState;
      let ids: string[];
      if (t.fixtures || t.group) {
        ids = freezeTargets(t);
        const free = toggle && ids.every((id) => Object.hasOwn(cur.heads, id));
        if (free) mayLoosen(ctx.origin);
        next = { level: cur.level, heads: withHeads(cur.heads, ids, (own) => (free ? "off" : own ? stricter(own, level) : level)) };
      } else {
        ids = show.movingHeads();
        // decision U2: the global toggle frees everything when anything is frozen, else freezes at the level given
        const free = toggle && anyFrozen(cur);
        if (free) mayLoosen(ctx.origin);
        next = free ? loosenAll(cur, "off") : { level: stricter(cur.level, level), heads: cur.heads };
      }
      show.setMotionLock(next);
      return lockReport(ids);
    },
  });
  reg.register({
    name: "motion.unfreeze",
    title: "Défiger les lyres",
    description:
      "Unfreezes moving heads frozen by motion.freeze: they glide (at least a second) from where they were held to what claims them now (a manual position, the look's move at its current phase, else rest). to: off (default) frees them, soft loosens a hard lock to soft (the pad moves them again); it never freezes. Without fixtures or group: everything — the global lock and every head's own lock (heads absent or no longer patched included); with them: those heads' own locks (a head still under the global lock stays frozen: see each head's effective level in the reply). Right commands:position; refused from OSC, OS2L, AbleSet and a song's timeline (they may freeze, never unfreeze). Returns the lock levels and each head's effective level.",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: Target.extend({ to: z.enum(["off", "soft"]).default("off") }),
    run: ({ to, ...t }, ctx) => {
      mayLoosen(ctx.origin);
      const cur = show.motionLockState();
      let next: MotionLockState;
      let ids: string[];
      if (t.fixtures || t.group) {
        ids = unfreezeTargets(t, cur.heads);
        next = { level: cur.level, heads: withHeads(cur.heads, ids, (own) => (own ? looser(own, to) : "off")) };
      } else {
        // decision U2: without a target, « Défiger » lifts everything — the global level and every head's own lock
        ids = show.movingHeads();
        next = loosenAll(cur, to);
      }
      show.setMotionLock(next);
      return lockReport(ids);
    },
  });

  // ---- guided calibration: aim by hand at known floor marks, then solve the orientation
  const samples = new Map<string, CalibrationSample[]>();
  const head = (id: string) => {
    const f = show.venue.fixtures.get(id);
    const r = show.venue.resolve(id);
    if (!f || "error" in r) throw new Error(f ? (r as { error: string }).error : say(`fixture inconnue : ${id}`, `unknown fixture: ${id}`));
    if (!r.pan && !r.tilt) throw new Error(say(`${f.name} : pas de pan/tilt`, `${f.name}: no pan/tilt`));
    if (!f.position) throw new Error(say(`${f.name} : position sur la scène inconnue (la placer d'abord)`, `${f.name}: stage position unknown (place it first)`));
    return { f, r };
  };
  const pointOf = (zone: string | undefined, point: { x: number; y: number; z: number } | undefined, height: number) => {
    if (point) return point;
    if (!zone) throw new Error(say("zone ou point requis", "zone or point required"));
    const zn = show.zones.get(zone);
    if (!zn) throw new Error(say(`zone inconnue : ${zone}`, `unknown zone: ${zone}`));
    const n = zn.polygon.length;
    return { x: zn.polygon.reduce((a, p) => a + p[0], 0) / n, y: zn.polygon.reduce((a, p) => a + p[1], 0) / n, z: zn.floorHeight + height };
  };
  reg.register({
    name: "calibration.record",
    title: "Enregistrer un repère",
    description:
      "Guided calibration, step 1 (repeat for 2–3 marks): once the head has been aimed by hand (XY pad, position.set) at a known spot — a zone's centre on its floor, or a point {x,y,z} in metres — records that spot with the position really sent to the head, read on the next frame. Refused while the head is frozen hard (motion.freeze), while a look or a target holds the head, while it glides, while it has not reached the position asked by hand (a speed rule, the DMX console or a fader on pan/tilt), and when no frame is rendered (output stopped).",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ fixture: z.string(), zone: z.string().optional(), point: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(), height: z.number().default(0) }),
    run: async ({ fixture, zone, point, height }) => {
      const { f } = head(fixture);
      // its right is show:write, not commands:position: the hard lock is checked here (T26). The pad cannot aim a head
      // frozen hard, so what it points at is not a mark aimed by hand
      if (show.motionLock(fixture) === "hard")
        throw new CommandError(
          "failed",
          say(`${f.name} : lyre figée (tout, pad compris) : la défiger, la viser au pad, puis enregistrer`, `${f.name}: moving head frozen (everything, pad included): unfreeze it, aim it with the pad, then record`),
          { refused: [fixture] },
        );
      // the gesture just before reaches the output first: without a frame, what was sent is stale
      if (!(await nextFrame())) throw new Error(say(`${f.name} : sortie arrêtée, aucune trame rendue : impossible de lire où pointe la lyre`, `${f.name}: output stopped, no frame rendered: where the head points cannot be read`));
      // where the head really points: the position sent (after the speed rules, the DMX console, a fader on pan/tilt)
      const sent = show.sentPosition(fixture);
      const status = show.motionStatus().get(fixture);
      if (!sent || !status) throw new Error(say(`${f.name} : aucune position envoyée pour l'instant`, `${f.name}: no position sent yet`));
      const axes = (["pan", "tilt"] as const).map((axis) => ({ axis, ...status[axis] }));
      if (axes.some((a) => a.layer === "look"))
        throw new Error(say(`${f.name} : un look la déplace ; la viser d'abord à la main (pad XY), puis enregistrer`, `${f.name}: a look moves it; aim it by hand first (XY pad), then record`));
      if (axes.some((a) => a.layer === "target"))
        throw new Error(say(`${f.name} : une cible la tient ; la viser d'abord à la main (pad XY), puis enregistrer`, `${f.name}: a target holds it; aim it by hand first (XY pad), then record`));
      if (axes.some((a) => a.moving)) throw new Error(say(`${f.name} : elle glisse encore ; attendre qu'elle soit arrêtée`, `${f.name}: it is still gliding; wait until it stops`));
      // a speed rule holds a head back on its way to the pad's position: the mark would be a point of its course
      if (axes.some((a) => a.layer === "manual" && a.target !== undefined && Math.abs(sent[a.axis] - a.target) > ARRIVED))
        throw new Error(
          say(
            `${f.name} : la lyre n'est pas encore arrivée (une règle de vitesse la ralentit, ou la console DMX ou un fader tient son pan/tilt) ; attendre, puis enregistrer`,
            `${f.name}: the head has not arrived yet (a speed rule slows it, or the DMX console or a fader holds its pan/tilt); wait, then record`,
          ),
        );
      const o = f.orientation;
      // the output values, as the fixture really receives them (current inversion and swap)
      let pan = o?.invertPan ? 1 - sent.pan : sent.pan;
      let tilt = o?.invertTilt ? 1 - sent.tilt : sent.tilt;
      if (o?.swapPanTilt) [pan, tilt] = [tilt, pan];
      const list = samples.get(fixture) ?? [];
      list.push({ target: pointOf(zone, point, height), pan, tilt });
      samples.set(fixture, list);
      return { fixture, samples: list.length, ready: list.length >= 2 };
    },
  });
  reg.register({ name: "calibration.list", title: "Repères enregistrés", description: "Calibration marks recorded for a head.", right: "dashboards:view", readOnly: true, profiles: ["setup"], schema: z.object({ fixture: z.string() }), run: ({ fixture }) => samples.get(fixture) ?? [] });
  reg.register({ name: "calibration.clear", title: "Effacer les repères", description: "Forgets the calibration marks of a head.", right: "show:write", profiles: ["setup"], schema: z.object({ fixture: z.string() }), run: ({ fixture }) => ({ cleared: samples.delete(fixture) }) });
  reg.register({
    name: "calibration.solve",
    title: "Calculer la calibration",
    description:
      "Guided calibration, step 2: from the recorded marks, finds the head's yaw, tilt offset and pan/tilt inversions (with the angular error per mark). With apply, writes them into the patch and forgets the marks; apply is refused while the head is frozen hard (motion.freeze: new inversions would move it), solving alone is not.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ fixture: z.string(), apply: z.boolean().default(false) }),
    run: ({ fixture, apply }) => {
      const { f, r } = head(fixture);
      if (apply && show.motionLock(fixture) === "hard")
        // new inversions would send the frozen head elsewhere, and releasing its manual position would lose it (T26)
        throw new CommandError(
          "failed",
          say(`${f.name} : lyre figée (tout, pad compris) : la défiger, puis appliquer la calibration`, `${f.name}: moving head frozen (everything, pad included): unfreeze it, then apply the calibration`),
          { refused: [fixture] },
        );
      const result = calibrate({ position: f.position!, hung: isHung(f), panMax: r.panMax, tiltMax: r.tiltMax }, samples.get(fixture) ?? []);
      if ("error" in result) throw new Error(result.error);
      if (apply) {
        // the solve replaces the inversions (a solved calibration re-measures them) and folds the pan
        // offset into the yaw, but keeps the body's pitch and roll as saved
        show.venue.fixtures.put({ ...f, orientation: { ...f.orientation, yaw: result.yaw, invertPan: result.invertPan, invertTilt: result.invertTilt, swapPanTilt: f.orientation?.swapPanTilt ?? false, panOffset: 0, tiltOffset: result.tiltOffset } });
        samples.delete(fixture);
        show.releasePositions([fixture]);
      }
      return { fixture, applied: apply, ...result };
    },
  });
}
