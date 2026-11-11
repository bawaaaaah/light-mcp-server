/**
 * Fadeable tracks (T5, docs/specs/engine-effects-timing.md, « Pistes fondables »; venue/tracks.ts): which channels of a
 * fixture follow the transitions and which ones jump. The list is set per model and overridden per fixture (the
 * `tracks` part of the overrides, venue/overrides.ts); it applies only where the fixture enables its tracks.
 */
import { z } from "zod";
import type { CommandRegistry } from "./registry.js";
import type { ShowRuntime } from "../show/runtime.js";
import type { ResolvedFixture } from "../venue/venue.js";
import { modelKeyOrUndefined, type TrackOverrides } from "../venue/overrides.js";
import { trackChannels, tracksOf } from "../venue/tracks.js";
import { say } from "../../../core/lang.js";

const Scope = z.enum(["model", "fixture"]).describe("model: every fixture of its manufacturer and model follows the list; fixture: this one only, over its model's");

export function registerTracksCommands(reg: CommandRegistry, show: ShowRuntime): void {
  const venue = show.venue;
  const keyOf = (f: { manufacturer: string; model: string }) => modelKeyOrUndefined(f.manufacturer, f.model);
  const resolved = (fixtureId: string): ResolvedFixture => {
    if (!venue.fixtures.get(fixtureId)) throw new Error(say(`fixture inconnue : ${fixtureId}`, `unknown fixture: ${fixtureId}`));
    const r = venue.resolve(fixtureId);
    if ("error" in r) throw new Error(r.error);
    return r;
  };
  /** What a fixture's tracks are: the switch, each channel ticked or not and where the list comes from, and what the motion layer will read. */
  const view = (fixtureId: string) => {
    const r = resolved(fixtureId);
    const f = r.patch;
    const key = keyOf(f);
    const own = f.overrides?.tracks;
    const model = key ? venue.models.get(key)?.overrides.tracks : undefined;
    const enabled = own?.enabled === true;
    const fade = own?.fade ?? model?.fade;
    const applies = own?.fade ? ("fixture" as const) : model?.fade ? ("model" as const) : ("none" as const);
    const ticked = new Set(fade ?? []);
    return {
      fixture: { id: f.id, name: f.name, manufacturer: f.manufacturer, model: f.model, mode: f.mode },
      enabled,
      applies,
      channels: trackChannels(r).map((c) => ({ name: c.name, attribute: c.attribute, kind: c.kind, fade: ticked.has(c.name), from: applies })),
      own: own?.fade ?? null,
      model: { fade: model?.fade ?? null, ids: key ? venue.fixtures.list().filter((x) => keyOf(x) === key).map((x) => x.id) : [f.id] },
      motion: enabled ? (tracksOf(r.def, r.mode, { enabled: true, ...(fade ? { fade } : {}) })?.motion ?? {}) : null,
    };
  };
  /** Refuses a name the definition does not have, or a fine channel (it follows its coarse one). */
  const checkNames = (r: ResolvedFixture, names: readonly string[]) => {
    const coarse = [...r.def.channels.values()].filter((c) => !c.fine).map((c) => c.name);
    const unknown = names.filter((n) => !coarse.includes(n));
    if (unknown.length)
      throw new Error(
        say(
          `pas un canal de ${r.patch.manufacturer} ${r.patch.model} (ou un canal fin, qui suit son canal) : ${unknown.join(", ")} ; canaux : ${coarse.join(", ")}`,
          `not a channel of ${r.patch.manufacturer} ${r.patch.model} (or a fine channel, which follows its coarse one): ${unknown.join(", ")}; channels: ${coarse.join(", ")}`,
        ),
      );
  };

  reg.register({
    name: "venue.tracks.get",
    title: "Pistes d'une fixture",
    description:
      "A fixture's fadeable tracks (docs/specs/engine-effects-timing.md, « Pistes fondables »): enabled (on the fixture only: off, the engine works as it always did), each channel of its mode a user ticks (fine channels follow their coarse one and are left out) with its kind (dimmer, colour, position, wheel, other), whether it follows the transitions (fade; the others jump: at once on entry, at mid-fade in a crossfade, at the end on exit) and where the list comes from (applies: fixture, model or none), the fixture's own list and its model's (with the patched fixtures sharing the model, ids), and motion: per axis, what the motion layer will read (glide or cut, null while disabled; no effect until that layer exists). The colour wheel of a lamp always changes slot as venue.wheel.put says (at mid-fade or through black).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({ fixture: z.string() }),
    run: ({ fixture }) => view(fixture),
  });
  reg.register({
    name: "venue.tracks.put",
    title: "Régler les pistes",
    description:
      "Sets fadeable tracks. scope fixture (default): on each fixture given, enabled switches its tracks on or off, and fade (channel names, as venue.tracks.get gives them) replaces its own list (null: back to its model's). scope model: fade sets the list of the model of the fixtures given (all of one model), which every fixture of that model without a list of its own follows; enabled is refused there (a fixture enables its own tracks). Nothing ticked means every channel jumps. Returns the first fixture's tracks.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ fixtures: z.array(z.string()).min(1), scope: Scope.default("fixture"), enabled: z.boolean().optional(), fade: z.array(z.string().min(1)).max(128).nullable().optional() }),
    run: ({ fixtures, scope, enabled, fade }) => {
      const all = fixtures.map(resolved);
      if (fade) for (const r of all) checkNames(r, fade);
      if (scope === "model") {
        if (enabled !== undefined) throw new Error(say("les pistes s'activent sur l'appareil, pas sur le modèle (portée fixture)", "tracks are enabled on a fixture, not on its model (scope fixture)"));
        if (fade === undefined) throw new Error(say("rien à régler : donner la liste `fade` du modèle (ou venue.tracks.clear)", "nothing to set: give the model's `fade` list (or venue.tracks.clear)"));
        const keys = new Set(all.map((r) => keyOf(r.patch) ?? r.patch.id));
        if (keys.size > 1) throw new Error(say("ces appareils ne sont pas tous du même modèle", "these fixtures are not all of one model"));
        const first = all[0]!.patch;
        const current = keyOf(first) ? venue.models.get(keyOf(first)!)?.overrides.tracks : undefined;
        const { fade: _old, ...rest } = current ?? {};
        const next: TrackOverrides = { ...rest, ...(fade ? { fade: [...new Set(fade)] } : {}) };
        venue.putOverridePart(first.id, "model", "tracks", Object.keys(next).length ? next : undefined);
      } else {
        if (enabled === undefined && fade === undefined) throw new Error(say("rien à régler : donner `enabled` ou `fade`", "nothing to set: give `enabled` or `fade`"));
        for (const r of all) {
          const { enabled: wasOn, fade: hadFade } = r.patch.overrides?.tracks ?? {};
          const on = enabled ?? wasOn;
          const list = fade === null ? undefined : fade ? [...new Set(fade)] : hadFade;
          const next: TrackOverrides = { ...(on ? { enabled: true } : {}), ...(list ? { fade: list } : {}) };
          venue.putOverridePart(r.patch.id, "fixture", "tracks", Object.keys(next).length ? next : undefined);
        }
      }
      return { updated: fixtures, ...view(fixtures[0]!) };
    },
  });
  reg.register({
    name: "venue.tracks.clear",
    title: "Revenir à la liste du modèle",
    description:
      "Removes a list of fadeable tracks. scope fixture (default): the fixture's own list goes (it follows its model's again; its tracks stay enabled or not). scope model: the model's list goes (its fixtures without a list of their own have nothing ticked: every channel jumps).",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ fixture: z.string(), scope: Scope.default("fixture") }),
    run: ({ fixture, scope }) => {
      const r = resolved(fixture);
      if (scope === "model") venue.putOverridePart(fixture, "model", "tracks", undefined);
      else venue.putOverridePart(fixture, "fixture", "tracks", r.patch.overrides?.tracks?.enabled ? { enabled: true } : undefined);
      return view(fixture);
    },
  });
}
