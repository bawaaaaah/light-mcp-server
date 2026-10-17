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

/** Fixtures given directly or through a group, kept to the moving heads. */
const Target = z.object({ fixtures: z.array(z.string()).optional(), group: z.string().optional() });

export function registerMoveCommands(reg: CommandRegistry, show: ShowRuntime): void {
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
    description: "Moving heads of the venue with their pan/tilt travel (degrees) and current manual position, if any (normalised 0..1, 0.5 = centre).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design", "live"],
    schema: z.object({}),
    run: () =>
      show.movingHeads().map((id) => {
        const r = show.venue.resolve(id);
        const f = show.venue.fixtures.get(id)!;
        return { id, name: f.name, panMax: "error" in r ? undefined : r.panMax, tiltMax: "error" in r ? undefined : r.tiltMax, manual: show.manualPosition(id) ?? null };
      }),
  });
  reg.register({
    name: "position.set",
    title: "Position des lyres",
    description: "Sets a manual pan/tilt (normalised 0..1, 0.5 = centre) on moving heads (fixtures, a group, or all heads); it wins over the looks' moves until released. Pan or tilt alone keeps the other.",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: Target.extend({ pan: z.number().min(0).max(1).optional(), tilt: z.number().min(0).max(1).optional() }),
    run: ({ pan, tilt, ...t }) => {
      const ids = targets(t);
      show.setPosition(ids, { ...(pan !== undefined ? { pan } : {}), ...(tilt !== undefined ? { tilt } : {}) });
      return { fixtures: ids };
    },
  });
  reg.register({
    name: "position.release",
    title: "Relâcher les lyres",
    description: "Releases manual positions (fixtures, a group, or all): heads go back to the looks' moves (or the centre).",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: Target,
    run: (t) => ({ released: show.releasePositions(t.fixtures || t.group ? targets(t) : undefined) }),
  });
  reg.register({
    name: "position.aim",
    title: "Viser",
    description: "Points moving heads at a stage zone (its centre, at `height` metres above its floor; default 1.5 = a standing person's face) or at a point {x,y,z} in metres. Needs the fixtures' position, mount and orientation (yaw, calibration). Sets a manual position; out-of-reach fixtures are reported.",
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
      "Guided calibration, step 1 (repeat for 2–3 marks): once the head has been aimed by hand (XY pad, position.set) at a known spot — a zone's centre on its floor, or a point {x,y,z} in metres — records that spot with the head's current output position.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ fixture: z.string(), zone: z.string().optional(), point: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(), height: z.number().default(0) }),
    run: ({ fixture, zone, point, height }) => {
      const { f } = head(fixture);
      const manual = show.manualPosition(fixture);
      if (!manual) throw new Error(say(`${f.name} : la viser d'abord à la main (pad XY), puis enregistrer`, `${f.name}: aim it by hand first (XY pad), then record`));
      const o = f.orientation;
      // the output values, as the fixture really receives them (current inversion and swap)
      let pan = o?.invertPan ? 1 - manual.pan : manual.pan;
      let tilt = o?.invertTilt ? 1 - manual.tilt : manual.tilt;
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
        show.venue.fixtures.put({ ...f, orientation: { yaw: result.yaw, invertPan: result.invertPan, invertTilt: result.invertTilt, swapPanTilt: f.orientation?.swapPanTilt ?? false, panOffset: 0, tiltOffset: result.tiltOffset } });
        samples.delete(fixture);
        show.releasePositions([fixture]);
      }
      return { fixture, applied: apply, ...result };
    },
  });
}
