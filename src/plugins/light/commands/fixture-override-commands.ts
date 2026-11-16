/**
 * A fixture's corrections, per model or per fixture (venue/overrides.ts): heads and accent heads, real pan/tilt travel, colour wheel.
 * Part of the show commands (show-commands.ts registers them all, with the scope they share: show-command-scope.ts).
 */
import { z } from "zod";
import { displayHex } from "../engine/display.js";
import { accentProblems, headsOf } from "../venue/heads.js";
import { TravelOverridesSchema, WheelOverridesSchema, type HeadOverrides } from "../venue/overrides.js";
import { finerModes, modesKeepingTravel, stepDeg, travelOf } from "../venue/travel.js";
import { slotValue, wheelCapabilities } from "../venue/color-wheel.js";
import { say } from "../../../core/lang.js";
import type { ShowCommandScope } from "./show-command-scope.js";

export function registerFixtureOverrideCommands(common: ShowCommandScope): void {
  const { reg, venue, idSchema } = common;
  // ---- heads and accent heads (venue/heads.ts): corrected per model, overridden per fixture (venue/overrides.ts)
  const headsScope = z.enum(["model", "fixture"]).default("model").describe("model: every fixture of its manufacturer and model follows; fixture: this one only, over its model's");
  // through the venue's aliases: a merged model's corrections are its target's (T20b)
  const keyOrUndefined = (f: { manufacturer: string; model: string }) => venue.modelKeyOf(f);
  /** A fixture's heads as it resolves, and as its model's correction alone gives them (what « this model » edits). */
  const headsOfFixture = (fixtureId: string) => {
    const f = venue.fixtures.get(fixtureId);
    if (!f) throw new Error(say(`fixture inconnue : ${fixtureId}`, `unknown fixture: ${fixtureId}`));
    const r = venue.resolve(fixtureId);
    if ("error" in r) throw new Error(r.error);
    const key = keyOrUndefined(f);
    const model = key ? venue.models.get(key)?.overrides.heads : undefined;
    const channel = (offset: number) => ({ offset, name: r.mode.channels[offset]!, color: r.def.channels.get(r.mode.channels[offset]!)?.color });
    const list = (found: { heads: ReadonlyMap<number, Partial<Record<string, number>>>; accent: ReadonlySet<number> }) =>
      [...found.heads].map(([head, comps]) => ({ head, accent: found.accent.has(head), channels: Object.values(comps).flatMap((o) => (o === undefined ? [] : [o])).sort((a, b) => a - b).map(channel) }));
    const ofModel = headsOf(r.def, r.mode, model);
    return {
      r,
      view: {
        fixture: f.id,
        deduced: r.deducedHeads,
        heads: list(r),
        follow: r.follow,
        escaped: r.escapedColours.map(channel),
        overrides: { ...(model ? { model } : {}), ...(f.overrides?.heads ? { fixture: f.overrides.heads } : {}) },
        /** The model's heads with its correction only, and how many patched fixtures of that model it reaches. */
        model: { heads: list(ofModel), follow: model?.follow ?? true, fixtures: key ? venue.fixtures.list().filter((x) => keyOrUndefined(x) === key).length : 1 },
      },
    };
  };
  /** Writes (or, with undefined, removes) the heads part of a fixture's or its model's overrides; the other parts stay. */
  const putHeads = (fixtureId: string, scope: "model" | "fixture", heads: HeadOverrides | undefined) => venue.putOverridePart(fixtureId, scope, "heads", heads);
  reg.register({
    name: "venue.fixture.heads",
    title: "Têtes d'une fixture",
    description:
      "A fixture's colour heads: those its definition declares, or, when it declares none but repeats its colour components (« Red 1 / Green 1 … Red 2 … », « Halo Red »), those deduced from its channel names (deduced: true). Each head lists its channels; accent marks a halo (or an unnumbered ring, a backlight): it follows the look (follow) but is no full colour of the fixture (left out of the preview, of what a look lights and of venue.canvas.auto). Head numbers never move when the accent changes. escaped: colour channels no head reaches although their component is in one. overrides: the corrections of its model and its own (merged field by field: the fixture's accent or follow over the model's). model: the heads with the model's correction alone, and how many patched fixtures of that model it reaches.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({ fixture: z.string() }),
    run: ({ fixture }) => headsOfFixture(fixture).view,
  });
  reg.register({
    name: "venue.fixture.heads.set",
    title: "Régler le halo d'une fixture",
    description:
      "Corrects a fixture's accent heads (a halo, a ring, a backlight), for its model (default) or this fixture only. accent: the colour channels (names, as venue.fixture.heads gives them) of the accent heads, whole heads only and never every head (an accent needs a full head beside it), checked against every mode of the model (a mode that has none of them keeps the detection by name); [] = no accent (every head is a full one); null = back to the detection by name. follow false: an accent head stays dark unless a look paints it (no colour from the other heads nor from a whole-fixture colour); null = back to the default (true). What is not given stays as set.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ fixture: z.string(), scope: headsScope, accent: z.array(z.string()).nullable().optional(), follow: z.boolean().nullable().optional() }),
    run: ({ fixture, scope, accent, follow }) => {
      const { r, view } = headsOfFixture(fixture);
      if (accent?.length) {
        const { unknown, partial, every } = accentProblems(r.def, accent);
        if (unknown.length) throw new Error(say(`pas un canal de couleur de ce modèle : ${unknown.join(", ")}`, `not a colour channel of this model: ${unknown.join(", ")}`));
        if (partial.length)
          throw new Error(
            say(
              `un halo est fait de têtes entières : ${partial.map((p) => `${p.head.join(", ")} (mode ${p.mode})`).join(" ; ")} n'y sont qu'en partie`,
              `an accent is made of whole heads: ${partial.map((p) => `${p.head.join(", ")} (mode ${p.mode})`).join("; ")} are only partly in it`,
            ),
          );
        // marked so, every head would be a full one again (headsOf): refused rather than saved and silently undone
        if (every.length)
          throw new Error(
            say(
              `un halo a besoin d'au moins une zone pleine à côté : toutes les têtes y seraient (mode ${every.join(", ")})`,
              `an accent needs at least one full zone beside it: every head would be in it (mode ${every.join(", ")})`,
            ),
          );
      }
      const current = (scope === "model" ? view.overrides.model : view.overrides.fixture) ?? {};
      const { accent: oldAccent, follow: oldFollow, ...rest } = current;
      const nextAccent = accent === null ? undefined : (accent ?? oldAccent);
      const nextFollow = follow === null ? undefined : (follow ?? oldFollow);
      const next: HeadOverrides = { ...rest, ...(nextAccent ? { accent: nextAccent } : {}), ...(nextFollow !== undefined ? { follow: nextFollow } : {}) };
      putHeads(fixture, scope, Object.keys(next).length ? next : undefined);
      return headsOfFixture(fixture).view;
    },
  });
  reg.register({
    name: "venue.fixture.heads.clear",
    title: "Annuler la correction des têtes",
    description: "Removes the whole heads correction (accent and follow) of a fixture's model (default) or of this fixture only: the halo is found by its channel names again and follows the look (or the model's correction applies again).",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ fixture: z.string(), scope: headsScope }),
    run: ({ fixture, scope }) => {
      headsOfFixture(fixture); // an unknown fixture is an error
      putHeads(fixture, scope, undefined);
      return headsOfFixture(fixture).view;
    },
  });
  // ---- real travel (T8): a moving head's pan/tilt travel when its definition is wrong, per model, overridable per fixture
  /** A moving head's travel: from the definition, its model's and its own corrections, what applies, and the output's precision. */
  const travelOfFixture = (fixtureId: string) => {
    const f = venue.fixtures.get(fixtureId);
    if (!f) throw new Error(say(`fixture inconnue : ${fixtureId}`, `unknown fixture: ${fixtureId}`));
    const r = venue.resolve(fixtureId);
    if ("error" in r) throw new Error(r.error);
    if (!r.pan && !r.tilt) throw new Error(say(`${f.name} : pas de pan/tilt`, `${f.name}: no pan/tilt`));
    const model = venue.modelTravelOf(f) ?? null;
    const own = f.overrides?.travel ?? null;
    // the channels that really carry each logical axis (a head wired with pan and tilt swapped: the other one)
    const swap = f.orientation?.swapPanTilt ?? false;
    const fine = { pan: (swap ? r.tilt : r.pan)?.fine !== undefined, tilt: (swap ? r.pan : r.tilt)?.fine !== undefined };
    const { applies } = travelOf(r.def, r.mode, model ?? undefined, own ?? undefined);
    return {
      fixture: { id: f.id, name: f.name, manufacturer: f.manufacturer, model: f.model, mode: f.mode },
      definition: { panMax: r.mode.panMax ?? r.def.panMax ?? 540, tiltMax: r.mode.tiltMax ?? r.def.tiltMax ?? 270 },
      model,
      own,
      panMax: r.panMax,
      tiltMax: r.tiltMax,
      applies,
      // decision E3: the modes of its model that keep their own travel, whatever the model's correction
      modesKeepingTravel: modesKeepingTravel(r.def, model ?? undefined),
      // one step of the output, degrees: the correction pad cannot be finer than this
      fine,
      step: { pan: stepDeg(r.panMax, fine.pan), tilt: stepDeg(r.tiltMax, fine.tilt) },
      finerModes: finerModes(r.def, r.mode),
    };
  };
  // the bounds of a travel are the stored correction's (overrides.ts); null takes it back
  const travelAxis = { panMax: TravelOverridesSchema.shape.panMax.nullable(), tiltMax: TravelOverridesSchema.shape.tiltMax.nullable() };
  reg.register({
    name: "venue.fixture.travel",
    title: "Course d'une lyre",
    description:
      "A moving head's real pan/tilt travel in degrees: the definition's (its mode's, else its own, else 540/270), the correction of its model and its own, the travel that applies and where it comes from per axis (the fixture's own correction, else the mode's own travel when the definition gives the mode one, else the model's correction, else the definition's); modesKeepingTravel: the modes of the definition that keep their own travel whatever the model's correction. fine: whether its mode drives each axis with a fine channel; step: one step of the output in degrees (travel / 65535 with a fine channel, travel / 255 without); finerModes: other DMX modes of its definition that drive with a fine channel an axis this mode drives without (venue.fixture.mode changes it).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({ fixture: z.string() }),
    run: ({ fixture }) => travelOfFixture(fixture),
  });
  reg.register({
    name: "venue.fixture.travel.set",
    title: "Corriger la course d'une lyre",
    description:
      "Corrects a moving head's pan/tilt travel (degrees, 1 to 1080) when its definition is wrong, for its model (default: every fixture of its manufacturer and model, in the DMX modes that declare no travel of their own: a mode that declares one keeps it, listed in modesKeepingTravel) or for this fixture only (over its model's and its mode's, axis by axis). panMax / tiltMax: the real travel; null = back to the model's or the definition's. What is not given stays as set. Aiming, the stops' conversion and the pad follow the travel; the bytes sent for a position do not change.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ fixture: z.string(), scope: headsScope, ...travelAxis }),
    run: ({ fixture, scope, panMax, tiltMax }) => {
      const view = travelOfFixture(fixture);
      const current = (scope === "model" ? view.model : view.own) ?? {};
      const next = { ...current };
      if (panMax === null) delete next.panMax;
      else if (panMax !== undefined) next.panMax = panMax;
      if (tiltMax === null) delete next.tiltMax;
      else if (tiltMax !== undefined) next.tiltMax = tiltMax;
      // a model named without a letter or digit is refused (modelKey): its fixtures are set one by one
      venue.putOverridePart(fixture, scope, "travel", Object.keys(next).length ? next : undefined);
      return travelOfFixture(fixture);
    },
  });
  // ---- colour wheel (T18): the colour → slot correspondence, per model, overridable per fixture (venue/color-wheel.ts)
  /**
   * A fixture's colour wheel as its definition gives it — every range of the wheel channel, with or without a
   * colour: one the definition gives none can be given one — and where its overrides live; undefined when it has
   * none that answers painted colours (no wheel, no definition, or colour mixing: an RGB fixture's wheel is
   * left to raw channels).
   */
  const wheelOrNone = (fixtureId: string) => {
    const f = venue.fixtures.get(fixtureId);
    if (!f) throw new Error(say(`fixture inconnue : ${fixtureId}`, `unknown fixture: ${fixtureId}`));
    const r = venue.resolve(fixtureId);
    if ("error" in r || !r.wheel || !r.lampOnly) return undefined;
    const caps = r.def.channels.get(r.mode.channels[r.wheel.offset] ?? "")?.capabilities ?? [];
    // key undefined: a model named without a letter or digit, whose wheel is set per fixture only
    return { f, wheel: r.wheel, slots: wheelCapabilities(caps), key: keyOrUndefined(f) };
  };
  const wheelOfFixture = (fixtureId: string) => {
    const found = wheelOrNone(fixtureId);
    if (!found) throw new Error(say(`${venue.fixtures.get(fixtureId)?.name ?? fixtureId} n'a pas de roue de couleurs choisie par la couleur peinte (lampe et roue)`, `${venue.fixtures.get(fixtureId)?.name ?? fixtureId} has no colour wheel chosen by the painted colour (a lamp and a wheel)`));
    return found;
  };
  const wheelScope = z.enum(["model", "fixture"]).describe("model: every fixture of this manufacturer and model; fixture: this one only, replacing the model's settings as a whole");
  reg.register({
    name: "venue.wheel.get",
    title: "Roue de couleurs",
    description:
      "A lamp fixture's colour wheel (docs/specs/venue-fixtures-stage.md, « Roue de couleurs »): every range of its wheel channel as the definition gives it (DMX range, value sent = the middle, name, colour; a split slot has two; « open » = no filter, white; « colorless » = the definition gives it no colour: it is never chosen until venue.wheel.put gives it its real colour), the overrides of its model and of this fixture (a slot's real colour, the colours it answers to, slots left out, split slots allowed, slot change at mid-fade or through black and how long the wheel takes to turn), and which applies. changeMs: the time in force. null when the fixture has no such wheel (none, no definition, or colour mixing).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: idSchema,
    run: ({ id: fixtureId }) => {
      const found = wheelOrNone(fixtureId);
      if (!found) return null;
      const { f, wheel, slots, key } = found;
      return {
        fixture: { id: f.id, name: f.name, manufacturer: f.manufacturer, model: f.model },
        offset: wheel.offset + 1,
        slots: slots.map((s) => ({ min: s.min, max: s.max, value: slotValue(s), name: s.name, ...(s.color ? { color: displayHex(s.color) } : { colorless: true }), ...(s.color2 ? { color2: displayHex(s.color2) } : {}), ...(s.open ? { open: true } : {}) })),
        model: (key && venue.models.get(key)?.overrides.wheel) ?? null,
        own: f.overrides?.wheel ?? null,
        applies: f.overrides?.wheel ? "fixture" : key && venue.models.get(key)?.overrides.wheel ? "model" : "definition",
        doubles: wheel.doubles,
        change: wheel.change,
        changeMs: wheel.changeMs,
      };
    },
  });
  reg.register({
    name: "venue.wheel.put",
    title: "Régler la roue de couleurs",
    description:
      "Sets the colour → slot correspondence of a lamp fixture's colour wheel, for its whole model (scope model) or for this fixture only (scope fixture, which then replaces the model's settings as a whole). slots, keyed by a slot's first DMX value (\"16\"): color (#rrggbb) its real colour when the definition is wrong or gives none (a range without colour becomes a slot), answers the colours it answers to beside its own (an asked colour nearest one of them lands on it), off never chosen from a painted colour. doubles: split slots may be chosen when a look asks their two colours of the fixture (default true). change: \"mid\" the slot changes at mid-fade in a crossfade (default), \"black\" the dimmer goes through black there, held at 0 for changeMs after the change (the time the wheel takes to turn, default 300 ms: to measure on the fixture). Replaces the wheel settings of that scope.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: z.string(), scope: wheelScope, wheel: WheelOverridesSchema }),
    run: ({ id: fixtureId, scope, wheel: settings }) => {
      const { f, slots } = wheelOfFixture(fixtureId);
      const unknown = Object.keys(settings.slots ?? {}).filter((k) => !slots.some((s) => String(s.min) === k));
      if (unknown.length) throw new Error(say(`case inconnue sur cette roue : ${unknown.join(", ")} (une case se nomme par la première valeur de sa plage)`, `no such slot on this wheel: ${unknown.join(", ")} (a slot is named by the first value of its range)`));
      const lower = (hex: string) => hex.toLowerCase();
      const clean = {
        ...settings,
        ...(settings.slots ? { slots: Object.fromEntries(Object.entries(settings.slots).map(([k, s]) => [k, { ...s, ...(s.color ? { color: lower(s.color) } : {}), ...(s.answers ? { answers: s.answers.map(lower) } : {}) }])) } : {}),
      };
      // a model named without a letter or digit is refused (modelKey): its fixtures are set one by one
      venue.putOverridePart(f.id, scope, "wheel", clean);
      return { scope, wheel: clean };
    },
  });
  reg.register({
    name: "venue.wheel.clear",
    title: "Effacer les réglages de la roue",
    description: "Removes the colour wheel settings of a fixture's model (scope model) or of this fixture (scope fixture): the model's settings, or the definition, apply again.",
    right: "show:write",
    profiles: ["setup"],
    schema: z.object({ id: z.string(), scope: wheelScope }),
    run: ({ id: fixtureId, scope }) => {
      const { f, key } = wheelOfFixture(fixtureId);
      const set = scope === "fixture" ? f.overrides?.wheel : key ? venue.models.get(key)?.overrides.wheel : undefined;
      if (!set) return { cleared: false };
      venue.putOverridePart(f.id, scope, "wheel", undefined);
      return { cleared: true };
    },
  });
}
