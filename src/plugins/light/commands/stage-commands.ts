/**
 * The virtual stage: zones (list, projection on a head's pad, put, delete), stage queries and description, the automatic canvas.
 * Part of the show commands (show-commands.ts registers them all, with the scope they share: show-command-scope.ts).
 */
import { z } from "zod";
import { CommandError } from "./registry.js";
import { aimSetupOf } from "../venue/venue.js";
import { projectZone } from "../venue/zone-project.js";
import { describeStage, queryStage, ZoneSchema, zoneOutline, zoneShapeError } from "../venue/stage.js";
import { say } from "../../../core/lang.js";
import type { ShowCommandScope } from "./show-command-scope.js";
import type { CanvasCommands } from "./canvas-commands.js";

/** What the stage commands lend the proposals. */
export interface StageCommands {
  /** Why a zone cannot be written, said with its name; undefined when it can. */
  zonePutError: (zone: { id: string; name: string; polygon: [number, number][] }) => string | undefined;
}

export function registerStageCommands(common: ShowCommandScope, { putCanvas, sharedFlag }: Pick<CanvasCommands, "putCanvas" | "sharedFlag">): StageCommands {
  const { reg, show, venue, removable, sharedWithOrRefuse } = common;
  // ---- stage
  /**
   * Why a zone cannot be written (T27), said with its name: its outline is checked only when it changes, so an old zone
   * stored before the check (a crossed outline) stays editable — renamed, closed to the heads, protected.
   */
  const zonePutError = (zone: { id: string; name: string; polygon: [number, number][] }): string | undefined => {
    const stored = show.zones.get(zone.id);
    if (stored && JSON.stringify(stored.polygon) === JSON.stringify(zone.polygon)) return undefined;
    const wrong = zoneShapeError(zone.polygon);
    return wrong && `${zone.name || zone.id}${say(" : ", ": ")}${wrong}`;
  };
  // an outline that no longer describes its polygon is left out when read (T27): it would redraw another shape
  reg.register({
    name: "stage.zone.list",
    title: "Zones",
    description: "Stage zones (type, floor height, tags, protected, no-aim, aiming part `aim`, the outline they were drawn with).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({}),
    run: () =>
      show.zones.list().map((zone) => {
        const outline = zoneOutline(zone);
        const { outline: _stored, ...rest } = zone;
        return outline ? { ...rest, outline } : rest;
      }),
  });
  // T27, lot 5: the aiming zones as one head sees them (a fraction of a millisecond a zone: computed on every read)
  reg.register({
    name: "stage.zone.project",
    title: "Zones vues par une lyre",
    description:
      "The aiming zones (those with `aim`) as one moving head sees them, for its XY pad: each outline, taken at the zone's aiming height, in the head's logical pan/tilt (0..1, as position.set), on the branch of solutions of where position.aim {zone} sends it. `paths`: the runs within reach (`closed`: the whole outline, one loop); parts out of reach, beyond the head's useful stops (orientation.limits) or only reached by the other equivalent solution are left out, never bent; `axisInside`: the head's axis pierces the zone, the loop is the band round it; `aim`: where position.aim {zone} sends the head (absent: out of reach); `reach`: full (one loop), partial or none; `polygon` and `plane` (the aiming height): the zone on the stage. `head`: the head's aiming data (place, mount, yaw, travel, offsets), for the pad to find the zone under a point. Empty `zones` with `reason` when the head has no stage position. Read-only.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["live", "design", "setup"],
    schema: z.object({ fixture: z.string() }),
    run: ({ fixture }) => {
      const f = show.venue.fixtures.get(fixture);
      const r = show.venue.resolve(fixture);
      if (!f) throw new CommandError("invalid", say(`fixture inconnue : ${fixture}`, `unknown fixture: ${fixture}`));
      if ("error" in r) throw new CommandError("failed", r.error);
      if (!r.pan && !r.tilt) throw new CommandError("invalid", say(`${f.name} : pas de pan/tilt`, `${f.name}: no pan/tilt`));
      const setup = aimSetupOf(r);
      if (!setup) return { fixture, zones: [], reason: "no-position" as const };
      const { limits: _limits, ...head } = setup;
      return { fixture, head, zones: show.zones.list().flatMap((zone) => (zone.aim ? [projectZone(setup, zone)] : [])) };
    },
  });
  reg.register({
    name: "stage.zone.put",
    title: "Zone",
    description:
      "Creates or updates a zone: polygon in metres (X stage left→right, Y front→upstage), floor height, type (stage, riser, floor, audience, wall, pillar, truss…), tags, protected, no-aim. `aim` makes it a destination for the moving heads (T27): `height` above its floor (default 1.5), `point` [x, y] aimed at (absent: the centre of its surface), `color`. `outline` says how it was drawn (rect, ellipse {cx, cy, rx, ry, rotation}, polygon), to edit it again; the polygon stays the truth. Refused when its edges cross or its surface is under 0.01 m² (checked only when the polygon changes: an older zone keeps its other edits).",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ zone: ZoneSchema }),
    run: ({ zone }) => {
      const wrong = zonePutError(zone);
      if (wrong) throw new CommandError("invalid", wrong);
      return show.zones.put(zone);
    },
  });
  reg.register({
    name: "stage.zone.delete",
    title: "Supprimer une zone",
    description:
      "Deletes a zone. Refused while something uses it (fixtures of the patch aiming at it, show or venue rules scoped to it, MIDI mappings and song track actions naming it by `zone`: the error names them; see show.references), unless force; also refused, unless force, when the venue is shared with other shows (they lose the zone too, the error names them). A forced delete returns usedBy and a `warning` saying those places now name a missing zone.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: z.string(), force: z.boolean().default(false).describe("delete even if the show uses it or the venue is shared with other shows") }),
    run: ({ id: i, force }) => {
      const zone = show.zones.get(i);
      if (!zone) return { deleted: false, usedBy: [] };
      const others = force ? [] : sharedWithOrRefuse(i, zone.name, "zone");
      const usedBy = removable("zone", i, zone.name, force, others);
      if (usedBy.length) show.rememberGoneName("zone", i, zone.name);
      const deleted = show.zones.delete(i);
      // forced: what named it now names a zone that no longer exists (a rule stops applying, a mapping fails): said
      const warning = deleted && usedBy.length ? say(`« ${zone.name} » supprimée : ces endroits nomment maintenant une zone qui n'existe plus, à corriger : ${usedBy.join(", ")}`, `“${zone.name}” deleted: these places now name a zone that no longer exists, to be fixed: ${usedBy.join(", ")}`) : undefined;
      return { deleted, usedBy, ...(warning ? { warning } : {}) };
    },
  });
  reg.register({
    name: "stage.query",
    title: "Interroger la scène",
    description: "Finds fixtures by role, zone they are in, zone they aim at, tags; optionally sorted along x/y/z (for sweeps). Each result says why it matched.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({ role: z.string().optional(), inZone: z.string().optional(), aimingAt: z.string().optional(), tags: z.array(z.string()).optional(), sortBy: z.enum(["x", "y", "z"]).optional() }),
    run: (q) => queryStage(venue.fixtures.list(), show.zones.list(), q).map((r) => ({ id: r.fixture.id, name: r.fixture.name, role: r.fixture.role, zone: r.zone, position: r.fixture.position, why: r.why })),
  });
  reg.register({ name: "stage.describe", title: "Décrire la scène", description: "Plain-French description of the stage: zones, what is in them, what lights them, and where the oriented fixtures point.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design"], schema: z.object({}), run: () => describeStage(venue.fixtures.list(), show.zones.list()) });

  reg.register({
    name: "venue.canvas.auto",
    title: "Canevas automatique",
    description: "Builds a canvas from fixtures in the given order: one cell per full head, declared or deduced from the channel names (or per fixture without heads); an accent head (a halo) gets none, a whole-fixture colour reaches it. Topology line, line-mirror or ring. Over an existing canvas, checked as venue.canvas.put (force).",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ id: z.string(), name: z.string(), fixtures: z.array(z.string()).min(1), topology: z.enum(["line", "line-mirror", "ring"]).default("line"), force: z.boolean().default(false).describe("over an existing canvas: as venue.canvas.put"), shared: sharedFlag }),
    run: ({ id: cid, name, fixtures, topology, force, shared }) => {
      const render: { from: number; to: number; targets: { fixture: string; head: number }[] }[] = [];
      let cell = 0;
      for (const fid of fixtures) {
        const r = venue.resolve(fid);
        if ("error" in r) throw new Error(r.error);
        // its full heads, declared or deduced (an accent head, a halo, gets no cell: a colour for the whole fixture reaches it)
        const heads = [...r.heads.keys()].filter((h) => !r.accent.has(h));
        for (const h of heads) render.push({ from: cell, to: cell++, targets: [{ fixture: fid, head: h }] });
      }
      return putCanvas({ id: cid, name, topology, cells: cell, render }, { force, shared });
    },
  });
  return { zonePutError };
}
