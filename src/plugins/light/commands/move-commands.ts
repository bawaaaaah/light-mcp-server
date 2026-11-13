/**
 * Moving heads (docs/specs/venue-fixtures-stage.md, « Lyres »): manual positions (XY pad), aiming at
 * a zone or a point of the stage, release, guided calibration. Move FX are part of looks (`look.move`).
 */
import { z } from "zod";
import type { CommandRegistry } from "./registry.js";
import type { ShowRuntime } from "../show/runtime.js";
import { calibrate, type CalibrationSample } from "../venue/aim.js";
import { isHung } from "../venue/orientation.js";
import { say } from "../../../core/lang.js";
import { motionEntries } from "../show/motion-report.js";

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

  reg.register({
    name: "position.list",
    title: "Lyres",
    description:
      "Moving heads selected by fixtures, a group (selectors and sub-groups included), or all, with their pan/tilt travel, manual position and why each is where it is: sent = the position really sent after the rules and guard; rest = where it goes when unclaimed; motion = per axis the winning layer, all layers still present (layers, strongest first, rest last), owner, glide and error, then masked and released claims. The same report is pushed on light:motion when it changes.",
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
    description: "Sets a manual pan/tilt (normalised 0..1, 0.5 = centre) on moving heads (fixtures, a group, or all heads); it wins over the looks' moves until released. Direct, as a gesture: no glide. Pan or tilt alone claims that axis only, the other stays with the layer below.",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: Target.extend({ pan: z.number().min(0).max(1).optional(), tilt: z.number().min(0).max(1).optional() }),
    run: ({ pan, tilt, ...t }) => {
      const ids = targets(t);
      show.setPosition(ids, { ...(pan !== undefined ? { pan } : {}), ...(tilt !== undefined ? { tilt } : {}) });
      return { fixtures: ids };
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
    description: "Releases manual positions (fixtures, a group, or all) and the hold a Panic left on those heads: they glide back to the looks' moves, else to their rest position. Returns the heads released.",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: Target,
    run: (t) => {
      const ids = t.fixtures || t.group ? targets(t) : undefined;
      // after a Panic the heads hold where they are: handing them back lets them go too
      return { released: [...new Set([...show.releasePositions(ids), ...show.releaseHold(ids)])] };
    },
  });
  reg.register({
    name: "position.releaseTop",
    title: "Rendre la main",
    description:
      "« Rendre la main » on fixtures, a group, or all: finds the strongest top layer present among the targeted heads (hard lock, manual, soft lock, target, look, hold, rest) and releases only the heads at that layer, axis by axis. Other heads keep theirs; pressing again descends one more layer, gliding to rest. A released look claims again once restarted. Locks are never released: hard releases nothing, soft permits manual only. Returns, per head, the owners released (manual, look:<id>, hold).",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: Target,
    run: (t) => ({ fixtures: show.releaseTop(t.fixtures || t.group ? targets(t) : undefined) }),
  });
  reg.register({
    name: "position.home",
    title: "Lyres au repos",
    description: "Sends moving heads (fixtures, a group, or all) to their rest position, gliding: every claim on them is released — the manual position, the looks' moves (a look started again claims them again), a Panic hold. Returns, per head, what was released.",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: Target,
    run: (t) => ({ fixtures: show.homePositions(t.fixtures || t.group ? targets(t) : undefined) }),
  });
  reg.register({
    name: "position.aim",
    title: "Viser",
    description: "Points moving heads at a stage zone (its centre, at `height` metres above its floor; default 1.5 = a standing person's face) or at a point {x,y,z} in metres. Needs the fixtures' position, mount and orientation (yaw, calibration). Sets a manual position, direct like the XY pad (no glide: the heads go there at once, bounded by the speed rules only); out-of-reach fixtures are reported.",
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
      return { target, results: show.aim(targets(t), target) };
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
      "Guided calibration, step 1 (repeat for 2–3 marks): once the head has been aimed by hand (XY pad, position.set) at a known spot — a zone's centre on its floor, or a point {x,y,z} in metres — records that spot with the position really sent to the head, read on the next frame. Refused while a look or a target holds the head, while it glides, while it has not reached the position asked by hand (a speed rule, the DMX console or a fader on pan/tilt), and when no frame is rendered (output stopped).",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ fixture: z.string(), zone: z.string().optional(), point: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(), height: z.number().default(0) }),
    run: async ({ fixture, zone, point, height }) => {
      const { f } = head(fixture);
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
      "Guided calibration, step 2: from the recorded marks, finds the head's yaw, tilt offset and pan/tilt inversions (with the angular error per mark). With apply, writes them into the patch and forgets the marks.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ fixture: z.string(), apply: z.boolean().default(false) }),
    run: ({ fixture, apply }) => {
      const { f, r } = head(fixture);
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
