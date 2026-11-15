/**
 * Named positions (T32; docs/specs/venue-fixtures-stage.md, « Positions nommées »): save where moving heads are under a
 * name, recall it (a manual gesture of the motion layer, decision Q2: the heads glide there and follow the position if
 * it is readjusted, until « Rendre la main »), readjust, refresh a stale one, delete. The commands only edit the
 * position objects and pick the heads; the motion layer does the rest (priority, glide, lock, release).
 */
import { z } from "zod";
import { CommandError, type CommandRegistry } from "./registry.js";
import type { ShowRuntime } from "../show/runtime.js";
import { PositionPresetSchema, StagePointSchema, type PositionPreset } from "../show/model.js";
import { coveredHeads, fillBasis, positionStale } from "../show/position-presets.js";
import { inUseMessage } from "../show/references.js";
import { slugify } from "../data/store.js";
import { say } from "../../../core/lang.js";

/** Fixtures given directly or through a group (move-commands.ts `Target`). */
export const HeadsSchema = z.object({ fixtures: z.array(z.string()).optional(), group: z.string().optional() });
type Heads = z.infer<typeof HeadsSchema>;

/** What move-commands.ts shares: the installed moving heads a selection names, and the hard-lock filter (T26). */
export interface HeadPicking {
  targets(t: Heads): string[];
  unlocked(ids: string[]): { ids: string[]; refused: string[] };
}

export function registerPositionPresetCommands(reg: CommandRegistry, show: ShowRuntime, pick: HeadPicking): void {
  const presets = show.positionPresets;
  const nameOf = (id: string) => show.venue.fixtures.get(id)?.name ?? id;
  const get = (id: string): PositionPreset => {
    const p = presets.get(id);
    if (!p) throw new CommandError("invalid", say(`position nommée inconnue : ${id}`, `unknown named position: ${id}`));
    return p;
  };
  const basisNow = (f: string) => show.positionBasis(f);
  /** A free id from a name: « Avant-scène » → avant-scene, then avant-scene-2… */
  const freeId = (name: string): string => {
    const base = slugify(name) || "position";
    let id = base;
    for (let i = 2; presets.get(id); i++) id = `${base.slice(0, 60)}-${i}`;
    return id;
  };
  /** Covered heads that are not installed moving heads now (deleted with force, absent, unpatched): ignored by a recall. */
  const missingOf = (p: PositionPreset): string[] => {
    const heads = new Set(show.movingHeads());
    return coveredHeads(p).filter((h) => !heads.has(h));
  };
  const describe = (p: PositionPreset) => ({
    ...p,
    kind: p.point ? ("point" as const) : ("pantilt" as const),
    covers: coveredHeads(p).map((id) => ({ id, name: nameOf(id) })),
    stale: positionStale(p, basisNow),
    missing: missingOf(p),
  });
  /** Each head must be a patched fixture with pan or tilt: a position on anything else would never place it. */
  const checkHeads = (ids: readonly string[]) => {
    for (const f of ids) {
      if (!show.venue.fixtures.get(f)) throw new CommandError("invalid", say(`fixture inconnue : ${f}`, `unknown fixture: ${f}`));
      const r = show.venue.resolve(f);
      if ("error" in r || (!r.pan && !r.tilt)) throw new CommandError("invalid", say(`« ${nameOf(f)} » n'est pas une lyre (ni pan ni tilt)`, `“${nameOf(f)}” is not a moving head (no pan, no tilt)`));
    }
  };
  const list = (ids: readonly string[]) => ids.map(nameOf).join(", ");

  reg.register({
    name: "position.preset.list",
    title: "Positions nommées",
    description:
      "Named positions of the show: pan/tilt per covered head (kind pantilt; covers = its heads with their names) or a 3D point every placed head aims at (kind point). stale = covered heads moved, rehung, turned, recalibrated or given another mode since the position was saved (its pan/tilt may no longer point there: recompute it from its aim point when it has one, readjust it by hand, or keep it as it is, position.preset.refresh / position.preset.save; never corrected silently); missing = covered heads no longer installed (ignored by a recall). A point is never stale.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design", "live"],
    schema: z.object({}),
    run: () => presets.list().map(describe),
  });

  reg.register({
    name: "position.preset.save",
    title: "Enregistrer une position",
    description:
      "Saves where moving heads are under a name: their pan/tilt as seen now (the XY pad's position where it holds a head, else what the looks or a target show at that instant, before the rules). Heads: fixtures, a group, or all moving heads (a new position) / the heads it covers (an existing one). With the id of an existing pan/tilt position: readjusts it, replacing the heads given and keeping the others (their freshness is renewed). With point {x,y,z} (metres): a 3D point position, which every placed head aims at when recalled and which is never stale (with the id of a point position: moves its point). With point and pantilt: true, the heads are aimed at the point now and their pan/tilt kept, with the point as aim (a stale head can then be recomputed from it). A pan/tilt position and a point position never change kind: delete and save again.",
    right: "show:write",
    profiles: ["live", "design", "setup"],
    schema: HeadsSchema.extend({
      id: z.string().optional().describe("an existing position to readjust; absent: a new one, its id made from its name"),
      name: z.string().min(1).optional().describe("required for a new position; renames an existing one"),
      point: StagePointSchema.optional(),
      pantilt: z.boolean().default(false).describe("with point: aim the heads at it now and keep their pan/tilt"),
      color: z.string().optional(),
      tags: z.array(z.string()).optional(),
      notes: z.string().optional(),
    }),
    run: ({ id, name, point, pantilt, fixtures, group, color, tags, notes }) => {
      const cur = id === undefined ? undefined : presets.get(id);
      if (!cur && !name?.trim()) throw new CommandError("invalid", say("donner un nom à la nouvelle position", "give the new position a name"));
      const design = {
        id: cur?.id ?? (id && id.trim() ? id : freeId(name!)),
        name: name?.trim() || cur!.name,
        ...((color ?? cur?.color) === undefined ? {} : { color: color ?? cur?.color }),
        tags: tags ?? cur?.tags ?? [],
        ...((notes ?? cur?.notes) === undefined ? {} : { notes: notes ?? cur?.notes }),
      };
      const scoped = Boolean(fixtures || group);
      if (point && !pantilt) {
        if (cur && !cur.point) throw new CommandError("invalid", say(`« ${cur.name} » est une position pan/tilt : la réajuster depuis les lyres (sans point), ou la supprimer pour enregistrer un point`, `“${cur.name}” is a pan/tilt position: readjust it from the heads (no point), or delete it to save a point`));
        if (scoped) throw new CommandError("invalid", say("un point n'a pas de lyres : chaque lyre placée le vise au rappel (ne pas donner fixtures ni group)", "a point has no heads: every placed head aims at it when recalled (give neither fixtures nor group)"));
        return { position: describe(presets.put({ ...design, point, values: {}, basis: {} })) };
      }
      if (cur?.point)
        throw new CommandError(
          "invalid",
          pantilt
            ? say(`« ${cur.name} » est un point : il ne devient pas une position pan/tilt (le supprimer et enregistrer de nouveau)`, `“${cur.name}” is a point: it does not become a pan/tilt position (delete it and save again)`)
            : say(`« ${cur.name} » est un point : donner point pour le déplacer`, `“${cur.name}” is a point: give point to move it`),
        );
      if (pantilt && !point) throw new CommandError("invalid", say("pantilt va avec point : le point à viser", "pantilt goes with point: the point to aim at"));
      const installed = new Set(show.movingHeads());
      const heads = scoped ? pick.targets({ fixtures, group }) : cur ? coveredHeads(cur).filter((h) => installed.has(h)) : [...installed];
      if (!heads.length) throw new CommandError("invalid", say("aucune lyre installée à enregistrer", "no installed moving head to save"));
      const captured: Record<string, { pan: number; tilt: number }> = {};
      const unreachable: { fixture: string; error: string }[] = [];
      for (const h of heads) {
        const at = point ? show.aimNow(h, point) : show.positionNow(h);
        if ("error" in at) unreachable.push({ fixture: h, error: at.error });
        else captured[h] = { pan: at.pan, tilt: at.tilt };
      }
      if (!Object.keys(captured).length) throw new CommandError("failed", say(`aucune lyre ne peut viser ce point : ${unreachable.map((u) => `${nameOf(u.fixture)} (${u.error})`).join(", ")}`, `no head can aim at this point: ${unreachable.map((u) => `${nameOf(u.fixture)} (${u.error})`).join(", ")}`));
      const values = { ...cur?.values, ...captured };
      // the heads captured now get their basis now; the others keep theirs
      const basis = { ...cur?.basis };
      for (const h of Object.keys(captured)) {
        const b = basisNow(h);
        if (b === undefined) delete basis[h];
        else basis[h] = b;
      }
      // the aim point stays only while the pan/tilt come from it: heads captured from the pad drop it
      const saved = presets.put({ ...design, values, basis, ...(point ? { aim: point } : {}) });
      return { position: describe(saved), captured: Object.keys(captured), ...(unreachable.length ? { unreachable } : {}) };
    },
  });

  reg.register({
    name: "position.preset.put",
    title: "Position nommée",
    description:
      "Creates or replaces a named position as a whole (the AI, an import, a version put back): id, name, values {fixtureId: {pan, tilt}} (0..1, 0.5 = centre) or point {x,y,z} (metres), never both; optional aim (the point a pan/tilt position was aimed at), color, tags, notes. basis: leave it out — each head keeps the one stored while its pan/tilt is unchanged, a pan/tilt written anew is taken as meant for the fixture as it is now. Covered heads must be patched moving heads.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ position: PositionPresetSchema }),
    run: ({ position }) => {
      checkHeads(coveredHeads(position));
      const cur = presets.get(position.id);
      return describe(presets.put({ ...position, basis: fillBasis(position, cur, basisNow) }));
    },
  });

  reg.register({
    name: "position.preset.go",
    title: "Rappeler une position",
    description:
      "Recalls a named position: the heads glide there (the show's moveFade) and hold it as a manual gesture, above the looks and targets, until « Rendre la main » (position.releaseTop), position.release or a Panic; they follow the position if it is readjusted meanwhile. Heads: fixtures, a group, or by default every head it covers (a pan/tilt position) / every installed moving head (a point). A pan/tilt position moves only the heads it covers (others given are listed in notCovered); a point is aimed head by head from where each is (never the long way round): heads without a stage position or out of reach stay as they are, listed in unreachable. Heads frozen hard (motion.freeze) are left out and listed in refused; refused when all are.",
    right: "commands:position",
    profiles: ["live", "design", "setup"],
    schema: HeadsSchema.extend({ id: z.string() }),
    run: ({ id, fixtures, group }) => {
      const p = get(id);
      const scoped = Boolean(fixtures || group);
      const installed = new Set(show.movingHeads());
      const asked = scoped ? pick.targets({ fixtures, group }) : p.point ? [...installed] : coveredHeads(p).filter((h) => installed.has(h));
      const covered = new Set(coveredHeads(p));
      const notCovered = p.point ? [] : asked.filter((h) => !covered.has(h));
      const unreachable: { fixture: string; error: string }[] = [];
      const candidates = asked.filter((h) => {
        if (!p.point) return covered.has(h);
        const at = show.presetPosition(p.id, h);
        if ("error" in at) unreachable.push({ fixture: h, error: at.error });
        return !("error" in at);
      });
      if (!candidates.length) {
        const why = notCovered.length ? say(`« ${p.name} » ne couvre pas ${list(notCovered)}`, `“${p.name}” does not cover ${list(notCovered)}`) : unreachable.length ? unreachable.map((u) => `${nameOf(u.fixture)} : ${u.error}`).join(", ") : say("aucune lyre installée", "no installed moving head");
        throw new CommandError("failed", say(`rien à rappeler : ${why}`, `nothing to recall: ${why}`), { ...(notCovered.length ? { notCovered } : {}), ...(unreachable.length ? { unreachable } : {}) });
      }
      const { ids, refused } = pick.unlocked(candidates);
      show.recallPreset(p.id, ids);
      return { id: p.id, fixtures: ids, ...(notCovered.length ? { notCovered } : {}), ...(unreachable.length ? { unreachable } : {}), ...(refused.length ? { refused } : {}) };
    },
  });

  reg.register({
    name: "position.preset.refresh",
    title: "Remettre à jour une position",
    description:
      "For a stale pan/tilt position (position.preset.list stale), two of the three choices (decision Q4; the third, readjusting by hand, is position.preset.save with its id): how recompute aims the heads again at the point it was aimed at (its aim, kept by position.preset.save with point and pantilt), from their stored pan/tilt, never the long way round — heads out of reach are listed in unreachable and left as they are; refused for a position without aim. how keep keeps the pan/tilt as they are and takes them as meant for the fixtures as they are now: no longer stale. Heads: fixtures, else every stale head. Nothing moves on stage.",
    right: "show:write",
    profiles: ["design", "setup"],
    schema: z.object({ id: z.string(), how: z.enum(["recompute", "keep"]), fixtures: z.array(z.string()).optional() }),
    run: ({ id, how, fixtures }) => {
      const p = get(id);
      if (p.point) throw new CommandError("invalid", say(`« ${p.name} » est un point : jamais périmé`, `“${p.name}” is a point: never stale`));
      const covered = new Set(coveredHeads(p));
      const heads = fixtures ?? positionStale(p, basisNow);
      const outside = heads.filter((h) => !covered.has(h));
      if (outside.length) throw new CommandError("invalid", say(`« ${p.name} » ne couvre pas ${list(outside)}`, `“${p.name}” does not cover ${list(outside)}`));
      if (how === "recompute" && !p.aim)
        throw new CommandError(
          "invalid",
          say(`« ${p.name} » n'a pas été visée sur un point : la réajuster à la main (position.preset.save avec son id) ou la garder telle quelle (how: keep)`, `“${p.name}” was not aimed at a point: readjust it by hand (position.preset.save with its id) or keep it as it is (how: keep)`),
        );
      const values = { ...p.values };
      const basis = { ...p.basis };
      const refreshed: string[] = [];
      const unreachable: { fixture: string; error: string }[] = [];
      for (const h of heads) {
        const now = basisNow(h);
        if (now === undefined) {
          unreachable.push({ fixture: h, error: say("plus dans le patch", "no longer patched") });
          continue;
        }
        if (how === "recompute") {
          const at = show.aimNow(h, p.aim!, values[h]);
          if ("error" in at) {
            unreachable.push({ fixture: h, error: at.error });
            continue;
          }
          values[h] = { pan: at.pan, tilt: at.tilt };
        }
        basis[h] = now;
        refreshed.push(h);
      }
      const saved = refreshed.length ? presets.put({ ...p, values, basis }) : p;
      return { position: describe(saved), refreshed, ...(unreachable.length ? { unreachable } : {}) };
    },
  });

  reg.register({
    name: "position.preset.delete",
    title: "Supprimer une position",
    description:
      "Deletes a named position. Refused while something uses it (a look's move following it, a dashboard widget, a MIDI mapping, a song's cue), unless force. Heads that recalled it and still hold it by hand stay where they are (an error says the position is gone) until « Rendre la main ».",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ id: z.string(), force: z.boolean().default(false).describe("delete even if a look, widget, mapping or song still uses it") }),
    run: async ({ id, force }, ctx) => {
      const p = presets.get(id);
      const { uses } = (await reg.invoke("show.references", { kind: "position", id }, ctx)) as { uses: string[] };
      if (uses.length && !force) throw new Error(inUseMessage(p?.name ?? id, uses));
      return { deleted: presets.delete(id) };
    },
  });
}
