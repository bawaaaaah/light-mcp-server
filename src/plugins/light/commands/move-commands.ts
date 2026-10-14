/**
 * Moving heads (docs/specs/venue-fixtures-stage.md, « Lyres »): manual positions (XY pad), aiming at
 * a zone or a point of the stage, release. Move FX themselves are part of looks (`look.move`).
 */
import { z } from "zod";
import type { CommandRegistry } from "./registry.js";
import type { ShowRuntime } from "../show/runtime.js";

/** Fixtures given directly or through a group, kept to the moving heads. */
const Target = z.object({ fixtures: z.array(z.string()).optional(), group: z.string().optional() });

export function registerMoveCommands(reg: CommandRegistry, show: ShowRuntime): void {
  const targets = (t: z.infer<typeof Target>): string[] => {
    const heads = new Set(show.movingHeads());
    if (t.group && !show.groups.get(t.group)) throw new Error(`groupe inconnu : ${t.group}`);
    const ids = t.fixtures ?? (t.group ? [...show.fixturesOf(t.group)] : [...heads]);
    for (const f of ids) if (!show.venue.fixtures.get(f)) throw new Error(`fixture inconnue : ${f}`);
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
        if (!zn) throw new Error(`zone inconnue : ${zone}`);
        const n = zn.polygon.length;
        target = { x: zn.polygon.reduce((a, p) => a + p[0], 0) / n, y: zn.polygon.reduce((a, p) => a + p[1], 0) / n, z: zn.floorHeight + height };
      }
      if (!target) throw new Error("zone ou point requis");
      return { target, results: show.aim(targets(t), target) };
    },
  });
}
