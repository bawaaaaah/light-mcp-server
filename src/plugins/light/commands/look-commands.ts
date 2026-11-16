/**
 * Looks: list, read, write (checked against their canvas), techniques, preview, delete, go and stop.
 * Part of the show commands (show-commands.ts registers them all, with the scope they share: show-command-scope.ts).
 */
import { z } from "zod";
import { TechniqueSchema } from "../engine/techniques.js";
import { displayHex } from "../engine/display.js";
import { ANSWERING_ORIGINS, CommandError } from "./registry.js";
import { flashProfile, MAX_FLASHES_PER_SECOND } from "../show/flashes.js";
import type { Canvas } from "../venue/venue.js";
import { LookSchema, PaletteSchema, type Look } from "../show/model.js";
import { swatchOf } from "../show/swatch.js";
import { folderOf, isReservedFolder, withFolder } from "../show/folders.js";
import { INTENTION_REFS_HELP } from "../knowledge/intentions.js";
import { say } from "../../../core/lang.js";
import type { ShowCommandScope } from "./show-command-scope.js";

/** What the look commands lend the canvas and folder commands. */
export interface LookCommands {
  /** A look checked against its canvas, raw channels and rules before it is written (look.put, a canvas put that adapts it). */
  checkLook: (look: Look, canvas?: Canvas) => Look;
  /** Whether two tag lists are the same, in order. */
  sameTags: (a: string[], b: string[]) => boolean;
}

export function registerLookCommands(common: ShowCommandScope): LookCommands {
  const { reg, show, migrateTags, ambiguousTags, venue, idSchema, removable, deletable, checkChannels } = common;
  // ---- palettes & looks
  reg.register({ name: "palette.list", title: "Palettes", titleEn: "Palettes", description: "Colour palettes of the show.", right: "dashboards:view", readOnly: true, profiles: ["design"], schema: z.object({}), run: () => show.palettes.list() });
  reg.register({ name: "palette.put", title: "Palette", titleEn: "Palette", hints: "DI", description: "Creates or updates a palette (used by reference: every look using it follows).", right: "show:write", profiles: ["design"], schema: z.object({ palette: PaletteSchema }), run: ({ palette }) => show.palettes.put(palette) });
  const swatch = (l: Parameters<typeof show.resolvedTechnique>[0]) => {
    try {
      return swatchOf(show.resolvedTechnique(l));
    } catch {
      return undefined; // a palette gone: no colour to show
    }
  };
  reg.register({
    name: "look.list",
    title: "Looks",
    titleEn: "Looks",
    description: "Looks of the show (technique, canvas, palette, timing, flags), whether they play, and the colour that sums each up (swatch, for its button). Brief by default: what only editing needs (technique parameters and steps, raw channels, move details, notes) is left out, since an imported show's exact steps weigh about a megabyte; look.get gives one look whole, brief: false every look whole.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design", "live"],
    schema: z.object({ brief: z.boolean().default(true) }),
    run: ({ brief }) =>
      show.looks.list().map((l) => {
        const extra = { active: show.isActive(l.id), swatch: swatch(l) };
        if (!brief) return { ...l, ...extra };
        const { technique, channels: _c, move, notes: _n, ...rest } = l;
        // partial: look.put refuses it, so a list → edit → put round trip cannot drop the steps or raw channels
        return { ...rest, technique: { kind: technique.kind }, ...(move ? { move: { shape: move.shape, ...(move.enabled === false ? { enabled: false } : {}) } } : {}), ...extra, partial: true };
      }),
  });
  reg.register({
    name: "look.get",
    title: "Look",
    titleEn: "Look",
    description: "One look whole (technique with its parameters and steps, raw channels, move, notes), whether it plays, and its swatch.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design"],
    schema: idSchema,
    run: ({ id: i }) => {
      const l = show.looks.get(i);
      if (!l) throw new Error(say(`look inconnu : ${i}`, `unknown look: ${i}`));
      return { ...l, active: show.isActive(l.id), swatch: swatch(l) };
    },
  });
  const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);
  /**
   * The checks a look passes before it is stored: look.put, and every look a folder command rewrites
   * (all checked before the first write). Its folder tag comes back normalised (segments trimmed, no
   * empty one), so a folder typed « Foo » with a trailing space is the folder « Foo ».
   */
  const checkLook = (look: Look, canvas: Canvas | undefined = venue.canvases.get(look.canvas)): Look => {
    if (!canvas) throw new Error(say(`canevas inconnu : ${look.canvas}`, `unknown canvas: ${look.canvas}`));
    // « jamais coupé » (noCut): only techniques that never switch a cell off
    if (look.noCut && show.stepsOf(look, canvas).some((step) => step.some((c) => c !== null && Object.values(c).every((v) => !v)))) {
      throw new Error(say(`« ${look.name} » est marqué « jamais coupé » mais sa technique éteint des cellules (pas noirs, masques sans plancher, flash…)`, `“${look.name}” is marked “never cut” but its technique turns cells off (black steps, masks without a floor, flash…)`));
    }
    if (look.channels) {
      checkChannels(look.channels.targets);
      const bad = look.channels.steps.findIndex((row) => row.length !== look.channels!.targets.length);
      if (bad >= 0) throw new Error(say(`canaux bruts : le pas ${bad + 1} a ${look.channels.steps[bad]!.length} valeur(s) pour ${look.channels.targets.length} canal(aux)`, `raw channels: step ${bad + 1} has ${look.channels.steps[bad]!.length} value(s) for ${look.channels.targets.length} channel(s)`));
    }
    const stored = show.looks.get(look.id);
    // a move following a target (T24) names one that exists; a look already following a target deleted since (with
    // force) stays editable, « Vérifier le show » says it
    const at = look.move?.at?.target;
    if (at !== undefined && !show.targets.get(at) && at !== stored?.move?.at?.target) throw new Error(say(`cible inconnue : ${at}`, `unknown target: ${at}`));
    // a named position (T32): known, and not with a target (one centre)
    const named = look.move?.at?.position;
    if (named !== undefined && at !== undefined) throw new Error(say("mouvement : une cible ou une position nommée, pas les deux", "move: a target or a named position, not both"));
    if (named !== undefined && !show.positionPresets.get(named) && named !== stored?.move?.at?.position) throw new Error(say(`position nommée inconnue : ${named}`, `unknown named position: ${named}`));
    // a zone or a path (T28): one base at most, and what they name exists (one already named by the stored look, deleted
    // since with force, stays editable: « Vérifier le show » says it)
    const base = look.move?.at;
    if (base && [base.target, base.position, base.zone, base.path].filter((v) => v !== undefined).length > 1)
      throw new Error(say("mouvement : une seule base parmi cible, position nommée, zone et parcours", "move: one base only among target, named position, zone and path"));
    if (base?.height !== undefined && base.zone === undefined) throw new Error(say("mouvement : la hauteur ne vaut que pour une zone", "move: the height applies to a zone only"));
    const storedAt = stored?.move?.at;
    const zoneKnown = (id: string, before: readonly (string | undefined)[]) => show.zones.get(id) !== undefined || before.includes(id);
    if (base?.zone !== undefined && !zoneKnown(base.zone, [storedAt?.zone])) throw new Error(say(`zone inconnue : ${base.zone}`, `unknown zone: ${base.zone}`));
    if (base?.path) {
      const before = storedAt?.path?.stops ?? [];
      base.path.stops.forEach((s, i) => {
        const stopAt = say(`parcours, arrêt ${i + 1}`, `path, stop ${i + 1}`);
        if (s.zone !== undefined && !zoneKnown(s.zone, before.map((b) => b.zone))) throw new Error(`${stopAt} : ${say(`zone inconnue : ${s.zone}`, `unknown zone: ${s.zone}`)}`);
        if (s.position !== undefined && !show.positionPresets.get(s.position) && !before.some((b) => b.position === s.position)) throw new Error(`${stopAt} : ${say(`position nommée inconnue : ${s.position}`, `unknown named position: ${s.position}`)}`);
        if (s.target !== undefined && !show.targets.get(s.target) && !before.some((b) => b.target === s.target)) throw new Error(`${stopAt} : ${say(`cible inconnue : ${s.target}`, `unknown target: ${s.target}`)}`);
      });
    }
    const folder = folderOf(look.tags);
    // only a move *into* a reserved name is refused: a look an older show already filed there stays editable
    if (folder !== undefined && isReservedFolder(folder) && folder !== (stored ? folderOf(stored.tags) : undefined)) throw new Error(say("« Sans dossier » désigne déjà les looks rangés nulle part : choisir un autre nom de dossier", "“No folder” already names the looks filed nowhere: choose another folder name"));
    const tags = folder === undefined ? look.tags : withFolder(look.tags, folder);
    return sameTags(tags, look.tags) ? look : { ...look, tags };
  };
  reg.register({
    name: "look.put",
    title: "Look",
    titleEn: "Look",
    hints: "I",
    description: "Creates or updates a look: technique (plat, damier, palette (random: each block draws its colour at random), creux, masques, masques-colores, respiration, orage, flamme, flash, onde = waveform with phase spread/blocks/wings/shuffle, pas, aucune = no colour), canvas, palette, optional raw channels (machines, lamps: targets fixture+offset and DMX values per step, stepped with the look), timing (every beats|seconds, attack 0 claque..1 respire, order), optional move for moving heads (shape fixe|cercle|huit|pan|tilt|tapis|aleatoire = a new point drawn in the box every cycle, center, size, every, spread, wings, reverse, shuffle = phases in a shuffled order, fan, group, fade = {beats: n} or {seconds: n} glide to this move, 0 = cut, absent = the show's moveFade; at = {target: id} centres the move on a target's point, aimed head by head, engaged or not (target.list; an unknown target is refused), or at = {position: id} on a named position read at render (position.preset.list; a position readjusted moves the look): its pan/tilt on the heads it covers, the look's other heads left to the layer below, or its point aimed head by head (an unknown position, or both target and position, is refused), or at = {zone: id, height?} on an aiming zone (stage.zone.list), aimed head by head (« one button per zone »), or at = {path: {stops: [{zone|point {x,y,z}|position|target, height? (zone only), weight?}] 1..32, order loop|pingpong|random|weighted, travel 0..1 = part of each step spent moving (default 0.5), heads ensemble|decales (each head one stop behind)|chacune (random: each head its own draw)}} = the heads go from stop to stop, one stop per `every`, gliding in pan/tilt (shape stays fixe; one base only among target, position, zone, path; unknown stops refused; the reply's warnings say stops out of reach, trips too fast for a speed rule and trips crossing a no-aim zone, where the head goes dark); enabled: false = « Ne pas bouger les lyres », holds the heads where they are while it is the top look). Its ambiance:<intention> tags: a name one intention only answers to is stored as its id; one several answer to stays a name and is returned in ambiguous. " + INTENTION_REFS_HELP,
    right: "show:write",
    profiles: ["design"],
    // a look from the brief list (partial) is refused before anything else: saved, it would lose its steps or raw channels
    schema: z.object({
      look: z.preprocess(
        (v, ctx) => {
          if (v && typeof v === "object" && (v as { partial?: unknown }).partial === true) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: say("look partiel (liste résumée, sans ses pas ni ses canaux) : le lire entier avec look.get avant de le modifier", "partial look (brief list, without its steps or channels): read it whole with look.get before changing it") });
            return z.NEVER;
          }
          return v;
        },
        LookSchema,
      ),
    }),
    run: ({ look }) => {
      const saved = show.looks.put(checkLook(migrateTags ? { ...look, tags: migrateTags(look.tags) } : look));
      // an ambiance: tag several intentions answer to stays a name (T15b): said, with which one it goes to
      const ambiguous = ambiguousTags?.(saved.tags) ?? [];
      // a path or a zone (T28) said ahead: stops out of reach, trips too fast for a speed rule, a no-aim zone aimed at or
      // crossed — not for a look that does not move its heads (« Ne pas bouger les lyres »), as « Vérifier le show »
      const warnings = saved.move?.enabled === false ? [] : (show.pathReport(saved)?.warnings.map((w) => w.message) ?? []);
      return ambiguous.length || warnings.length ? { ...saved, ...(ambiguous.length ? { ambiguous } : {}), ...(warnings.length ? { warnings } : {}) } : saved;
    },
  });
  reg.register({
    name: "look.techniques",
    title: "Techniques",
    titleEn: "Techniques",
    description: "Every technique kind with the JSON schema of its parameters (for editors).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design"],
    schema: z.object({}),
    run: () => TechniqueSchema.options.map((o) => ({ kind: o.shape.kind.value, schema: z.toJSONSchema(o, { io: "input", reused: "inline", unrepresentable: "any" }) })),
  });

  reg.register({
    name: "look.preview",
    title: "Aperçu d'un look",
    titleEn: "Look preview",
    description: "Steps a look (saved or not) generates on its canvas (and, for a look with a move, `heads`: the moving heads its move places — none for an empty or unknown group —; following a named position that is a point, `unreachable`: those of them that cannot aim at it now, with why): one display colour per cell (\"#rrggbb\", null = untouched), with the canvas shape. `flashes`: `perLoop` is the worst cell's dark-to-lit changes over one cycle of the steps in the order they are played (0 when the look fades or holds still; a cell a step leaves untouched counts as dark, as a preview draws it), `period` the number of steps of that cycle (more than the steps for ping-pong; 2 for a random or weighted order, which can put a flash every two steps), `windows[w]` the most flashes in `w` steps in a row of it (w = 0..period), `max` the photosensitive limit in flashes per second (WCAG 2.3.1): a client counts the flashes of the worst second as `perLoop × whole cycles + windows[rest]` over the steps that start in one second (`ceil(1 / seconds per step)`). A fading attack still counts a change out of an untouched cell, which a preview cuts. A look whose move has `at.path` (stops) or `at.zone` (T28) also gets `path`: `stops` (each stop named, and resolved head by head: pan/tilt or why the head cannot go there; `gone`: the last name of a zone, position or target deleted since) and `warnings` (stops out of reach, trips too fast for a speed rule, a no-aim zone aimed at or crossed; none with move.enabled false). A path without stops is refused. Nothing is played.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design"],
    schema: z.object({ look: LookSchema }),
    run: ({ look }) => {
      const canvas = venue.canvases.get(look.canvas);
      if (!canvas) throw new Error(say(`canevas inconnu : ${look.canvas}`, `unknown canvas: ${look.canvas}`));
      const steps = show.stepsOf(look);
      // the moving heads its move places (T32, the look editor's coverage of a named position): none for an unknown group
      let heads: string[] | undefined;
      if (look.move) {
        try {
          heads = show.movedBy(look);
        } catch {
          heads = [];
        }
      }
      // following a point (T32): the heads that cannot aim at it, said by the editor rather than found on stage
      const named = look.move?.at?.position;
      const unreachable =
        heads && named && show.positionPresets.get(named)?.point
          ? heads.flatMap((h) => {
              const at = show.presetPosition(named, h);
              return "error" in at ? [{ fixture: h, error: at.error }] : [];
            })
          : [];
      // a path (T28): its stops resolved head by head, and its warnings (shown in the editor before saving)
      const path = show.pathReport(look);
      return { ...(heads ? { heads } : {}), ...(unreachable.length ? { unreachable } : {}), ...(path ? { path: { stops: path.stops, warnings: look.move?.enabled === false ? [] : path.warnings } } : {}), cells: canvas.cells, topology: canvas.topology, columns: canvas.columns, steps: steps.map((step) => step.map((c) => (c ? displayHex(c) : null))), flashes: { ...flashProfile(steps, look.timing.attack, look.timing.order, true), max: MAX_FLASHES_PER_SECOND } };
    },
  });
  reg.register({
    name: "look.delete",
    title: "Supprimer un look",
    titleEn: "Delete a look",
    hints: "DI",
    description: "Deletes a look. Refused while something uses it (see show.references), unless force.",
    right: "show:write",
    profiles: ["design"],
    schema: deletable,
    run: ({ id: i, force }) => (removable("look", i, show.looks.get(i)?.name, force), show.drop(i), { deleted: show.looks.delete(i) }),
  });
  reg.register({
    name: "look.go",
    title: "Lancer un look",
    titleEn: "Launch a look",
    hints: "I",
    description:
      "Starts a look (idempotent: starting a playing look does nothing); releases the other looks of its exclusive groups. A rule set to reject refuses it when it would bound it; one set to confirm asks first: tell the user which rule and why, and send confirm: true only on their yes.",
    right: "commands:trigger",
    profiles: ["design", "live"],
    schema: z.object({ id: z.string(), confirm: z.boolean().default(false).describe("the user agreed to launch it although a confirm rule bounds it") }),
    run: ({ id: i, confirm }, ctx) => {
      // rules that refuse or ask rather than clamp (rules-limits.md, onViolation)
      const bounds = show.strictBounds(i, { origin: ctx.origin, ...(ctx.role ? { role: ctx.role } : {}) });
      const named = (list: typeof bounds) => list.map((b) => `${b.rule.name || b.rule.id} (${[...new Set(b.clamps.map((c) => c.fixture))].join(", ")})`).join(" ; ");
      const rejected = bounds.filter((b) => b.rule.onViolation === "reject");
      if (rejected.length) throw new CommandError("failed", say(`look refusé : la règle ${named(rejected)} le bornerait`, `look refused: rule ${named(rejected)} would bound it`), { rules: rejected.map((b) => b.rule.id) });
      const asking = bounds.filter((b) => b.rule.onViolation === "confirm");
      if (asking.length && !confirm) {
        const canAnswer = ANSWERING_ORIGINS.includes(ctx.origin);
        throw new CommandError(
          "failed",
          canAnswer ? say(`la règle ${named(asking)} bornerait ce look : le lancer quand même ?`, `rule ${named(asking)} would bound this look: launch it anyway?`) : say(`look non lancé : la règle ${named(asking)} demande une confirmation`, `look not launched: rule ${named(asking)} asks for a confirmation`),
          { confirm: canAnswer, rules: asking.map((b) => b.rule.id) },
        );
      }
      return show.go(i, ctx.origin === "timeline" || ctx.origin === "mcp" || ctx.origin === "ableset");
    },
  });
  reg.register({ name: "look.stop", title: "Arrêter un look", titleEn: "Stop a look", hints: "I", description: "Stops a look.", right: "commands:trigger", profiles: ["design", "live"], schema: idSchema, run: ({ id: i }) => ({ stopped: show.stop(i) }) });
  reg.register({ name: "look.stopall", title: "Tout arrêter", titleEn: "Stop everything", hints: "I", description: "Stops every playing look.", right: "commands:trigger", profiles: ["live"], schema: z.object({}), run: () => ({ stopped: show.stopAll() }) });
  return { checkLook, sameTags };
}
