/**
 * show.lint (« Vérifier le show »): the offline checks of the open show and its venue — references, patch, rules,
 * moving heads, photosensitive safety, intentions —, out of the design commands that register it (design-commands.ts).
 */
import { z } from "zod";
import type { CommandRegistry } from "./registry.js";
import type { IntentionStores } from "./design-commands.js";
import type { ShowRuntime } from "../show/runtime.js";
import type { Collection } from "../data/store.js";
import { mappingInputKey, type Mapping } from "../midi/mapping.js";
import type { Song } from "../songs/songs.js";
import type { Look } from "../show/model.js";
import { deltaE, LOW_CONTRAST } from "../knowledge/knowledge.js";
import { AMBIANCE, duplicateLabels, embeddedIntentions, originWord, refKey, resolveIntention, strictHint, type IntentionEntry, type ResolvedIntention } from "../knowledge/intentions.js";
import { intentionUsesByKey } from "../show/references.js";
import { flashesPerSecond, MAX_FLASHES_PER_SECOND } from "../show/flashes.js";
import { applyRules, ruleApplies } from "../rules/rules.js";
import { zoneOf } from "../venue/stage.js";
import { groupingMessage } from "../venue/grouping.js";
import { holdAtRest, isBuiltinRule, powerOnResets, unprotectable } from "../rules/reset-protection.js";
import { crossManufacturer, duplicatesUsedBy, sameNameMessage, sameSignatureMessage } from "../venue/definition-duplicates.js";
import { aliasTarget } from "../venue/aliases.js";
import { canvasIssues } from "../venue/canvas-edit.js";
import { rawMotionAxes } from "../venue/tracks.js";
import { positionStale } from "../show/position-presets.js";
import { beyondStops, moveBeyondStops, NARROW_STOP_DEG, narrowStops, stopsOutsideTravel } from "../venue/stops-check.js";
import { say } from "../../../core/lang.js";

export interface ShowLintDeps {
  runtime: ShowRuntime;
  songs: Collection<Song>;
  mappings: () => Mapping[];
  intentions: IntentionStores;
  /** The intentions the open show sees, every layer stacked (design-commands.ts, showStack). */
  stack: () => Map<string, IntentionEntry>;
  /** The open show's songs and looks, as the intentions name them (design-commands.ts). */
  showParts: () => { songs: Song[]; looks: Look[] };
  /** `colourKnown` (T41): whether a colour preset id is one the open show sees. */
  colourKnown?: ((id: string) => boolean) | undefined;
}

export function registerShowLint(reg: CommandRegistry, { runtime, songs, mappings, intentions, stack, showParts, colourKnown }: ShowLintDeps): void {
  reg.register({
    name: "show.lint",
    title: "Vérifier le show",
    titleEn: "Check the show",
    description: "Offline checks: unknown references (canvas, palette, look, group, channel fader, rule program, colour preset — a mapping or a song cue —, fixture, target — a look's move following a target gone, a target's fixtures or group, a mapping —, named position — a look's move following one gone, a mapping), targets moving no installed head, named positions covering fixtures no longer patched or no installed head, stale named positions (a covered head moved, rehung, inverted or given another definition since; turned, recalibrated or given a corrected travel, for the heads aimed at a point only; new useful stops its pan/tilt reaches beyond: with the choices to recompute it from its aim point, readjust it by hand, or keep it), named positions reaching beyond a head's useful stops (clipped at the output), looks following a named position that covers none of their heads, channel fader channels outside the fixture's mode, sections without look, MIDI inputs used twice, low contrast in two-colour techniques, identical looks on neighbouring sections, songs without mood, songs naming an unknown (or masked) intention (a keyword renamed in the private intentions file breaks what named it), intentions sharing a label, songs or looks naming by name an intention several answer to, keywords of the private intentions file that make one key, intention files left out unreadable, looks, groups or channel faders sharing a name, MIDI mappings with one label for different targets, fixtures whose DMX channels overlap or run past channel 512, fixtures without a definition, looks flashing faster than 3 times a second (photosensitive safety, at the show's fastest tempo), raw channels of looks that the rules bound, channel faders at 0 that darken the fixtures whose dimmer they dose, Reset channels made of maintenance ranges only (the built-in Reset protection cannot hold them at rest), canvases with reversed or out-of-bounds ranges, fixtures or heads not in the patch, looks of exact steps whose rows do not have one column per cell, looks writing only the fine pan/tilt channel of a moving head (it places nothing since the motion layer), looks whose move (around the named position it follows, head by head) or raw pan/tilt steps reach beyond a moving head's useful stops (orientation.limits: clipped at the output, the move stops there), useful stops narrower than 10° or reaching beyond the travel. Level info (nothing wrong, worth knowing): songs naming an intention of this machine (personal library, private file: the show's archives carry a copy), unused gaps in the patch, fixtures of one model sharing a name, moving heads or placed fixtures without a stage position, fixtures whose tracks are enabled with no channel ticked (nothing fades there), definitions without <Head> repeating a colour component out of any head (only one zone gets the colour), canvas cells that render nothing or one head on several cells, the type tags and groups venue.grouping.propose proposes, targets sharing moving heads (engaged together, the last engaged takes them), looks following a named position that leaves some of their heads uncovered (those stay with the layer below), and looks writing raw pan/tilt channels on moving heads (named with the heads and channels: since the motion layer they glide, go under the XY pad, and the last look launched wins instead of the highest byte).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design", "setup"],
    schema: z.object({}),
    run: () => {
      const issues: { level: "erreur" | "attention" | "info"; where: string; message: string }[] = [];
      const err = (where: string, message: string) => issues.push({ level: "erreur", where, message });
      const warn = (where: string, message: string) => issues.push({ level: "attention", where, message });
      // worth knowing, nothing wrong: a gap kept on purpose, a proposal
      const note = (where: string, message: string) => issues.push({ level: "info", where, message });
      for (const l of runtime.looks.list()) {
        if (!runtime.venue.canvases.get(l.canvas)) err(`look ${l.id}`, say(`canevas inconnu ${l.canvas}`, `unknown canvas ${l.canvas}`));
        if (l.palette && !runtime.palettes.get(l.palette)) err(`look ${l.id}`, say(`palette inconnue ${l.palette}`, `unknown palette ${l.palette}`));
        const t = l.technique;
        if ((t.kind === "damier" || t.kind === "creux" || t.kind === "masques") && !l.palette) {
          const d = deltaE(t.colors[0], t.colors[1]);
          if (d < LOW_CONTRAST && t.colors[0] !== t.colors[1]) warn(`look ${l.id}`, say(`contraste faible entre ${t.colors[0]} et ${t.colors[1]} (ΔE ${d.toFixed(0)})`, `low contrast between ${t.colors[0]} and ${t.colors[1]} (ΔE ${d.toFixed(0)})`));
        }
      }
      issues.push(...canvasIssues(runtime.venue.canvases.list(), runtime.looks.list(), { headsOf: (f) => runtime.venue.canvasHeads(f) }));
      const seen = new Map<string, string>();
      for (const m of mappings()) {
        const key = mappingInputKey(m);
        // The mapper fires every mapping of an input, as QLC+ fires every widget bound to it: one CC
        // driving a DCA and a channel fader is by design, so this is worth a look, not an error.
        if (seen.has(key)) warn(`mapping ${m.id}`, say(`même entrée que ${seen.get(key)} : les deux se déclenchent ensemble`, `same input as ${seen.get(key)}: both fire together`));
        seen.set(key, m.id);
        const target = m.on.args.id;
        if (typeof target === "string" && target) {
          if (m.on.command.startsWith("look.") && !runtime.looks.get(target)) err(`mapping ${m.id}`, say(`look inconnu ${target}`, `unknown look ${target}`));
          if (m.on.command.startsWith("group.") && !runtime.groups.get(target)) err(`mapping ${m.id}`, say(`groupe inconnu ${target}`, `unknown group ${target}`));
          if (m.on.command.startsWith("fader.") && !runtime.faders.get(target)) err(`mapping ${m.id}`, say(`fader de canaux inconnu ${target}`, `unknown channel fader ${target}`));
          if (m.on.command === "program.select" && !runtime.programs.get(target)) err(`mapping ${m.id}`, say(`programme inconnu ${target}`, `unknown program ${target}`));
          if (m.on.command.startsWith("target.") && !runtime.targets.get(target)) err(`mapping ${m.id}`, say(`cible inconnue ${target}`, `unknown target ${target}`));
        }
      }
      // targets (T24): what they name, and the heads two of them share (the last engaged wins them)
      const targets = runtime.targets.list();
      for (const l of runtime.looks.list()) {
        const at = l.move?.at?.target;
        if (at !== undefined && !runtime.targets.get(at)) err(`look ${l.id}`, say(`cible inconnue ${at} (mouvement) : ses lyres restent où elles sont`, `unknown target ${at} (move): its heads stay where they are`));
      }
      for (const t of targets) {
        for (const f of t.fixtures) if (!runtime.venue.fixtures.get(f)) err(say(`cible ${t.id}`, `target ${t.id}`), say(`projecteur inconnu ${f}`, `unknown fixture ${f}`));
        if (t.group && !runtime.groups.get(t.group)) err(say(`cible ${t.id}`, `target ${t.id}`), say(`groupe inconnu ${t.group}`, `unknown group ${t.group}`));
        else if (!runtime.targetHeads(t).length) warn(say(`cible ${t.id}`, `target ${t.id}`), say(`« ${t.name} » ne déplace aucune lyre installée`, `“${t.name}” moves no installed moving head`));
      }
      for (let i = 0; i < targets.length; i++)
        for (const other of targets.slice(i + 1)) {
          const mine = new Set(runtime.targetHeads(targets[i]!));
          const shared = runtime.targetHeads(other).filter((h) => mine.has(h));
          if (shared.length)
            note(
              say(`cible ${targets[i]!.id}`, `target ${targets[i]!.id}`),
              say(
                `« ${targets[i]!.name} » et « ${other.name} » partagent ${shared.map((h) => runtime.venue.fixtures.get(h)?.name ?? h).join(", ")} : engagées ensemble, la dernière engagée les prend`,
                `“${targets[i]!.name}” and “${other.name}” share ${shared.map((h) => runtime.venue.fixtures.get(h)?.name ?? h).join(", ")}: engaged together, the last engaged takes them`,
              ),
            );
        }
      // named positions (T32): what names them, what they cover, and the stale ones with the three choices (decision Q4)
      for (const m of mappings()) {
        const id = m.on.args.id;
        if (m.on.command.startsWith("position.preset.") && typeof id === "string" && id && !runtime.positionPresets.get(id)) err(`mapping ${m.id}`, say(`position nommée inconnue ${id}`, `unknown named position ${id}`));
      }
      // colour presets (T41): a mapping or a song cue applying one deleted since applies nothing
      if (colourKnown) {
        const unknown = (c: { command: string; args: Record<string, unknown> }) => c.command.startsWith("colour.") && typeof c.args.id === "string" && c.args.id !== "" && !colourKnown(c.args.id);
        for (const m of mappings()) if (unknown(m.on)) err(`mapping ${m.id}`, say(`preset de couleur inconnu ${String(m.on.args.id)} (supprimé ?)`, `unknown colour preset ${String(m.on.args.id)} (deleted?)`));
        for (const song of songs.list()) for (const c of song.cues ?? []) if (unknown(c)) err(say(`chant ${song.id}`, `song ${song.id}`), say(`action de piste : preset de couleur inconnu ${String(c.args.id)} (supprimé ?)`, `track cue: unknown colour preset ${String(c.args.id)} (deleted?)`));
      }
      const installedHeads = new Set(runtime.movingHeads());
      const headName = (h: string) => runtime.venue.fixtures.get(h)?.name ?? h;
      for (const l of runtime.looks.list()) {
        const named = l.move?.at?.position;
        if (named === undefined) continue;
        const p = runtime.positionPresets.get(named);
        if (!p) {
          err(`look ${l.id}`, say(`position nommée inconnue ${named} (mouvement) : ses lyres restent où elles sont`, `unknown named position ${named} (move): its heads stay where they are`));
          continue;
        }
        if (p.point) continue;
        let moved: string[] = [];
        try {
          moved = runtime.movedBy(l);
        } catch {
          continue; // its group is unknown: said with the groups
        }
        const left = moved.filter((h) => !Object.hasOwn(p.values, h));
        if (moved.length && left.length === moved.length) warn(`look ${l.id}`, say(`la position « ${p.name} » ne couvre aucune de ses lyres : le mouvement ne les place pas`, `the position “${p.name}” covers none of its heads: the move places none of them`));
        else if (left.length) note(`look ${l.id}`, say(`la position « ${p.name} » ne couvre pas ${left.map(headName).join(", ")} : ces lyres restent à la couche du dessous`, `the position “${p.name}” does not cover ${left.map(headName).join(", ")}: those heads stay with the layer below`));
      }
      // a move aimed at a zone or along a path (T28): what they name, and what the path will do (stops out of reach, trips
      // too fast for a speed rule that applies, trips crossing a no-aim zone: the head goes dark while it crosses)
      for (const l of runtime.looks.list()) {
        const at = l.move?.at;
        const unknown = new Set<number>();
        if (at?.zone !== undefined && !runtime.zones.get(at.zone)) {
          // its one stop (pathReport checks a zone as a path of one stop): said once, as the zone gone
          unknown.add(0);
          err(`look ${l.id}`, say(`zone inconnue ${runtime.goneName("zone", at.zone)} (mouvement) : ses lyres restent où elles sont`, `unknown zone ${runtime.goneName("zone", at.zone)} (move): its heads stay where they are`));
        }
        if (!at?.path && at?.zone === undefined) continue;
        (at.path?.stops ?? []).forEach((s, i) => {
          const gone =
            s.zone !== undefined && !runtime.zones.get(s.zone)
              ? say(`zone inconnue ${runtime.goneName("zone", s.zone)}`, `unknown zone ${runtime.goneName("zone", s.zone)}`)
              : s.position !== undefined && !runtime.positionPresets.get(s.position)
                ? say(`position nommée inconnue ${runtime.goneName("position", s.position)}`, `unknown named position ${runtime.goneName("position", s.position)}`)
                : s.target !== undefined && !runtime.targets.get(s.target)
                  ? say(`cible inconnue ${runtime.goneName("target", s.target)}`, `unknown target ${runtime.goneName("target", s.target)}`)
                  : undefined;
          if (!gone) return;
          unknown.add(i);
          err(`look ${l.id}`, say(`parcours, arrêt ${i + 1} : ${gone} : les lyres y restent en place`, `path, stop ${i + 1}: ${gone}: the heads hold there`));
        });
        if (l.move?.enabled === false) continue;
        for (const w of runtime.pathReport(l)?.warnings ?? []) if (!(w.kind === "nowhere" || w.kind === "unreachable") || !w.stops.every((i) => unknown.has(i))) warn(`look ${l.id}`, w.message);
      }
      for (const p of runtime.positionPresets.list()) {
        const where = `position ${p.id}`;
        if (p.point) continue;
        const gone = Object.keys(p.values).filter((h) => !runtime.venue.fixtures.get(h));
        if (gone.length) warn(where, say(`« ${p.name} » couvre des projecteurs qui ne sont plus dans le patch (${gone.join(", ")}) : ignorés au rappel`, `“${p.name}” covers fixtures no longer patched (${gone.join(", ")}): ignored when recalled`));
        if (!Object.keys(p.values).some((h) => installedHeads.has(h))) warn(where, say(`« ${p.name} » ne couvre aucune lyre installée`, `“${p.name}” covers no installed moving head`));
        const stale = positionStale(p, (f) => runtime.positionHeadNow(f));
        if (stale.length)
          warn(
            where,
            say(
              `« ${p.name} » est à revoir pour ${stale.map(headName).join(", ")} (déplacée, réaccrochée, inversée, autre définition, ou visée sur son point puis tournée, recalibrée ou de course corrigée, ou de nouvelles butées qu'elle dépasse, depuis l'enregistrement) : ${p.aim ? "la recalculer depuis son point visé (position.preset.refresh how: recompute), " : ""}la modifier à la main (au pad, puis position.preset.save avec son id), ou la laisser telle quelle (position.preset.refresh how: keep)`,
              `“${p.name}” needs a look for ${stale.map(headName).join(", ")} (moved, rehung, inverted, given another definition, or aimed at its point then turned, recalibrated or given a corrected travel, or new stops it reaches beyond, since it was saved): ${p.aim ? "recompute it from its aim point (position.preset.refresh how: recompute), " : ""}readjust it by hand (at the pad, then position.preset.save with its id), or keep it as it is (position.preset.refresh how: keep)`,
            ),
          );
        // beyond a head's useful stops (T8): recalled or followed, it is clipped at the output, the head stops at the stop
        const clipped = Object.keys(p.values).filter((h) => installedHeads.has(h) && runtime.positionHeadNow(h)?.beyondStops(p.values[h]!));
        if (clipped.length)
          warn(
            where,
            say(
              `« ${p.name} » dépasse les butées utiles de ${clipped.map(headName).join(", ")} : écrêtée à la sortie, la lyre s'arrête à la butée ; la réajuster au pad (puis position.preset.save avec son id), ou élargir les butées`,
              `“${p.name}” reaches beyond the useful stops of ${clipped.map(headName).join(", ")}: clipped at the output, the head stops at the stop; readjust it at the pad (then position.preset.save with its id), or widen the stops`,
            ),
          );
      }
      for (const g of runtime.groups.list()) {
        for (const f of g.members.fixtures) if (!runtime.venue.fixtures.get(f)) err(say(`groupe ${g.id}`, `group ${g.id}`), say(`projecteur inconnu ${f}`, `unknown fixture ${f}`));
        for (const l of [...g.members.looks, ...g.presets.included, ...g.presets.excluded]) if (!runtime.looks.get(l)) err(say(`groupe ${g.id}`, `group ${g.id}`), say(`look inconnu ${l}`, `unknown look ${l}`));
        for (const sub of g.members.groups) if (!runtime.groups.get(sub)) err(say(`groupe ${g.id}`, `group ${g.id}`), say(`sous-groupe inconnu ${sub}`, `unknown sub-group ${sub}`));
      }
      // Same name, different objects (a QLC+ workspace often has several « Master » sliders): on the
      // Live, in the MIDI page and to the AI they look alike, and one can be taken for a duplicate.
      const sameName = (kind: string, list: { id: string; name: string }[]) => {
        const first = new Map<string, string>();
        for (const x of list) {
          const key = x.name.trim().toLocaleLowerCase("fr");
          const other = first.get(key);
          if (other) warn(`${kind} ${x.id}`, say(`même nom que ${other} (« ${x.name} ») : renommer l'un des deux pour les distinguer`, `same name as ${other} (“${x.name}”): rename one of them to tell them apart`));
          else first.set(key, x.id);
        }
      };
      for (const o of runtime.venue.patchProblems()) warn(say(`projecteur ${o.b}`, `fixture ${o.b}`), say(`${o.message} : deux projecteurs écrivent les mêmes canaux`, `${o.message}: two fixtures write the same channels`));
      for (const b of runtime.venue.patchBeyond()) warn(say(`projecteur ${b.id}`, `fixture ${b.id}`), b.message);
      const notes = runtime.venue.patchNotes();
      for (const g of notes.gaps) note(say(`univers ${g.universe}`, `universe ${g.universe}`), g.message);
      for (const s of notes.sameNames) note(say(`projecteur ${s.ids.join(", ")}`, `fixture ${s.ids.join(", ")}`), s.message);
      for (const p of notes.noPosition) note(say(`projecteur ${p.id}`, `fixture ${p.id}`), p.message);
      // a channel with nothing but Reset and Lamp off ranges: the built-in protection has nowhere to hold it
      for (const f of runtime.venue.installed()) {
        const r = runtime.venue.resolve(f.id);
        if ("error" in r) continue;
        // tracks enabled with nothing ticked (T5): every channel jumps, the light included
        if (r.tracks && !r.tracks.fade.size)
          note(
            say(`projecteur ${f.id}`, `fixture ${f.id}`),
            say(`« ${f.name} » : pistes activées, aucun canal coché : rien ne fond sur cet appareil`, `“${f.name}”: tracks enabled, no channel ticked: nothing fades on this fixture`),
          );
        for (const ch of unprotectable(r))
          warn(
            say(`projecteur ${f.id}`, `fixture ${f.id}`),
            say(
              `« ${f.name} » · ${ch} n'a que des plages Reset et « Lamp off » : la protection Reset ne peut pas le tenir au repos ; ne pas le piloter par un look ni un fader`,
              `“${f.name}” · ${ch} has Reset and « Lamp off » ranges only: the Reset protection cannot hold it at rest; do not drive it from a look or a fader`,
            ),
          );
        // a Reset range holding 0 and more: the protection keeps the channel at 0, its power-on value
        for (const p of powerOnResets(r))
          warn(
            say(`projecteur ${f.id}`, `fixture ${f.id}`),
            say(
              `« ${f.name} » · ${p.channel} : la plage ${p.range} commence à 0, où le canal est à l'allumage ; la protection Reset ramène à 0 toute valeur de cette plage : un look ou un fader ne peut pas l'envoyer (vérifier dans le manuel ce que fait cette plage)`,
              `“${f.name}” · ${p.channel}: range ${p.range} starts at 0, where the channel sits from power-on; the Reset protection brings any value of this range back to 0: a look or a fader cannot send it (check in the manual what this range does)`,
            ),
          );
      }
      // Raw pan/tilt of a look (an imported scene) on an installed moving head: since the motion layer (T25, question 6)
      // they glide, go under the XY pad, and the last look launched wins instead of the highest byte. A fine channel
      // written alone places nothing any more.
      const heads = new Set(runtime.movingHeads());
      const rawPlaced: { id: string; fr: string; en: string }[] = [];
      for (const l of runtime.looks.list()) {
        // « Ne pas bouger les lyres » (T26, move.enabled false): its raw pan/tilt place nothing, nothing to say
        if (!l.channels || l.move?.enabled === false) continue;
        const offsets = new Map<string, Set<number>>();
        for (const t of l.channels.targets) if (heads.has(t.fixture)) offsets.set(t.fixture, (offsets.get(t.fixture) ?? new Set<number>()).add(t.offset));
        const placed: [string, string][] = [];
        const fineOnly: [string, string][] = [];
        for (const [id, offs] of offsets) {
          const r = runtime.venue.resolve(id);
          if ("error" in r) continue;
          const axes = rawMotionAxes(r, offs);
          const channel = (axis: "pan" | "tilt", fine: boolean) => r.mode.channels[fine ? r[axis]!.fine! : r[axis]!.coarse] ?? axis;
          if (axes.placed.length) placed.push([r.patch.name, axes.placed.map((a) => channel(a, false)).join(", ")]);
          if (axes.fineOnly.length) fineOnly.push([r.patch.name, axes.fineOnly.map((a) => channel(a, true)).join(", ")]);
        }
        const fr = (list: [string, string][]) => list.map(([head, chs]) => `« ${head} » (${chs})`).join(", ");
        const en = (list: [string, string][]) => list.map(([head, chs]) => `“${head}” (${chs})`).join(", ");
        if (placed.length) rawPlaced.push({ id: l.id, fr: `« ${l.name} » : ${fr(placed)}`, en: `“${l.name}”: ${en(placed)}` });
        if (fineOnly.length)
          warn(
            `look ${l.id}`,
            say(
              `« ${l.name} » n'écrit que le canal fin du pan/tilt sur ${fr(fineOnly)} : depuis la couche Mouvement, un canal fin seul ne place plus la lyre (le look n'en fait rien) ; écrire aussi le canal gros, ou un mouvement du look`,
              `“${l.name}” writes only the fine pan/tilt channel on ${en(fineOnly)}: since the motion layer, a fine channel alone no longer places the head (the look does nothing with it); write the coarse channel too, or a move of the look`,
            ),
          );
      }
      // one note for them all: the change is the same, said once
      if (rawPlaced.length)
        note(
          `looks ${rawPlaced.map((x) => x.id).join(", ")}`,
          say(
            `pan/tilt en canaux bruts — ${rawPlaced.map((x) => x.fr).join(" ; ")}. Depuis la couche Mouvement, ils glissent (sauf un axe réglé en coupe dans « Transitions… »), le pad XY passe devant, et entre deux looks le dernier lancé gagne (avant : l'octet le plus haut). Pour les régler dans l'éditeur : un mouvement « fixe » du look`,
            `raw pan/tilt channels — ${rawPlaced.map((x) => x.en).join("; ")}. Since the motion layer they glide (unless the axis is set to cut in “Transitions…”), the XY pad wins over them, and between two looks the last one launched wins (before: the highest byte). To set them in the editor: a “still” move of the look`,
          ),
        );
      // The useful stops of the moving heads (T8, decision Q4): a look or a Move FX reaching beyond a head's stops plays,
      // clipped at the output without a word: said here. A stop narrower than 10° leaves the head almost still.
      const stopsOf = (id: string) => {
        const r = runtime.venue.resolve(id);
        return "error" in r || !r.patch.orientation?.limits ? undefined : { panMax: r.panMax, tiltMax: r.tiltMax, limits: r.patch.orientation.limits, name: r.patch.name, r };
      };
      for (const id of heads) {
        const s = stopsOf(id);
        // a stop beyond the travel (the travel corrected since): it bounds nothing on that side
        const outside = stopsOutsideTravel(s?.limits, s ?? { panMax: 0, tiltMax: 0 });
        if (s && outside.length)
          warn(
            say(`lyre ${id}`, `moving head ${id}`),
            say(
              `« ${s.name} » : butée hors de la course (${outside.map((o) => `${o.axis} ± ${o.half}°`).join(", ")}) : elle ne borne rien de ce côté ; la resserrer, ou corriger la course`,
              `“${s.name}”: stop outside the travel (${outside.map((o) => `${o.axis} ± ${o.half}°`).join(", ")}): it bounds nothing on that side; narrow it, or correct the travel`,
            ),
          );
        const narrow = narrowStops(s?.limits);
        if (s && narrow.length)
          warn(
            say(`lyre ${id}`, `moving head ${id}`),
            say(
              `« ${s.name} » : butée de ${narrow.join(" et ")} plus étroite que ${NARROW_STOP_DEG}° : la lyre ne bouge presque plus sur cet axe (une faute de frappe ?)`,
              `“${s.name}”: ${narrow.join(" and ")} stop narrower than ${NARROW_STOP_DEG}°: the head hardly moves on that axis (a typo?)`,
            ),
          );
      }
      for (const l of runtime.looks.list()) {
        if (l.move?.enabled === false) continue;
        const touched = new Set<string>();
        // its move (a shape around a target or a named point is aimed head by head, live: not checked here); around a
        // pan/tilt named position, each covered head's shape is centred on its pan/tilt (the others are not placed)
        const named = l.move?.at?.position === undefined ? undefined : runtime.positionPresets.get(l.move.at.position);
        // a zone or a path (T28) is aimed head by head: its own checks below
        if (l.move && l.move.at?.target === undefined && l.move.at?.zone === undefined && l.move.at?.path === undefined && (l.move.at?.position === undefined || (named && !named.point))) {
          // a canvas or group gone is said above (unknown references): nothing to check here
          let moved: string[];
          try {
            moved = runtime.movedBy(l);
          } catch {
            moved = [];
          }
          // the fan is spread among the covered heads only, as the render spreads it
          const covered = named ? moved.filter((h) => Object.hasOwn(named.values, h)) : moved;
          const centers = named ? covered.map((h) => named.values[h]) : undefined;
          for (const i of moveBeyondStops(l.move, covered.map(stopsOf), centers)) touched.add(covered[i]!);
        }
        // its raw pan/tilt steps, read as the motion layer reads them
        if (l.channels)
          for (const id of new Set(l.channels.targets.map((t) => t.fixture))) {
            const s = heads.has(id) ? stopsOf(id) : undefined;
            if (!s || touched.has(id)) continue;
            for (const row of l.channels.steps) {
              const bytes = new Map<number, number>();
              l.channels.targets.forEach((t, k) => {
                if (t.fixture === id) bytes.set(t.offset, row[k] ?? 0);
              });
              if (beyondStops(s, runtime.venue.readPosition(s.r, (offset) => bytes.get(offset)))) {
                touched.add(id);
                break;
              }
            }
          }
        if (touched.size) {
          const names = [...touched].map((id) => runtime.venue.fixtures.get(id)?.name ?? id);
          warn(
            `look ${l.id}`,
            say(
              `« ${l.name} » dépasse les butées de ${names.map((n) => `« ${n} »`).join(", ")} : la position y est écrêtée à la sortie (le mouvement s'arrête à la butée) ; réduire la taille ou déplacer le centre du mouvement, ou élargir les butées`,
              `“${l.name}” reaches beyond the stops of ${names.map((n) => `“${n}”`).join(", ")}: the position is clipped there at the output (the move stops at the stop); shrink or move the move, or widen the stops`,
            ),
          );
        }
      }
      const grouping = runtime.typeGrouping();
      if (grouping.tags.length || grouping.groups.length) note(say("groupes par type", "type groups"), groupingMessage(grouping));
      // Raw channels the rules bound (UV, strobe, machines): the look does not do what it says, and
      // nobody would know why. Rules that always apply (no program); each written value is tried.
      const zones = runtime.zones.list();
      const zoneById = (id: string) => {
        const f = runtime.venue.fixtures.get(id);
        return f ? zoneOf(f, zones)?.id : undefined;
      };
      const always = runtime.rulesInForce().filter((r) => !r.program);
      const ruleName = new Map(always.map((r) => [r.id, r.name || r.id]));
      // the built-in Reset protection holds at rest, not at the nearest value (rules/reset-protection.ts)
      const ordinary = always.filter((r) => !isBuiltinRule(r.id));
      if (always.length) {
        for (const l of runtime.looks.list()) {
          if (!l.channels) continue;
          const said = new Set<string>();
          l.channels.targets.forEach((t, k) => {
            const r = runtime.venue.resolve(t.fixture);
            if ("error" in r || runtime.venue.absent.has(t.fixture)) return; // absent: nothing is sent, nothing is bounded
            const name = r.mode.channels[t.offset];
            for (const value of new Set(l.channels!.steps.map((row) => row[k] ?? 0))) {
              const buf = new Uint8Array(512);
              const index = r.patch.address - 1 + t.offset;
              if (index < 0 || index >= 512) continue;
              buf[index] = value;
              const moved = [...applyRules(ordinary, r, buf, zoneById), ...(ordinary.length < always.length ? holdAtRest(r, buf, new Map()) : [])].filter((x) => x.channel === name);
              const c = moved.at(-1);
              if (!c || buf[index] === value || said.has(`${t.fixture}/${name}`)) continue;
              said.add(`${t.fixture}/${name}`);
              const rule = c.rule ? `« ${ruleName.get(c.rule) ?? c.rule} »` : say("du lieu", "of the venue");
              const ruleEn = c.rule ? `“${ruleName.get(c.rule) ?? c.rule}”` : "of the venue";
              warn(`look ${l.id}`, say(`écrit ${r.patch.name} · ${name} à ${value}, mais la règle ${rule} le ramène à ${buf[index]} : le look ne rend pas ce qu'il dit`, `writes ${r.patch.name} · ${name} at ${value}, but rule ${ruleEn} brings it to ${buf[index]}: the look does not show what it says`));
            }
          });
        }
      }
      // a « Hz max » only bounds strobes whose definition gives their frequencies: say where it does nothing
      for (const rule of [...runtime.venueRules.list(), ...runtime.rules.list()].filter((r) => r.maxHz !== undefined)) {
        const blind = new Set<string>();
        for (const f of runtime.venue.installed()) {
          const r = runtime.venue.resolve(f.id);
          if ("error" in r) continue;
          for (const name of r.mode.channels) {
            const ch = r.def.channels.get(name);
            if (ch && ruleApplies(rule, r, ch, zoneById) && !ch.capabilities.some((c) => c.hz)) blind.add(f.name);
          }
        }
        if (blind.size) warn(say(`règle ${rule.id}`, `rule ${rule.id}`), say(`Hz max sans effet sur ${[...blind].join(", ")} : leur définition ne donne pas les fréquences du strobe ; les borner par une valeur max`, `Hz max has no effect on ${[...blind].join(", ")}: their definition gives no strobe frequencies; bound them with a max value`));
      }
      // photosensitive safety (WCAG 2.3.1): a look timed in beats flashes fastest on the show's fastest song
      const bpm = Math.max(120, ...songs.list().map((x) => x.bpm ?? 0));
      for (const l of runtime.looks.list()) {
        let steps;
        try {
          steps = runtime.stepsOf(l);
        } catch {
          continue; // an unknown canvas is reported above
        }
        const every = l.timing.every;
        const stepSeconds = "seconds" in every ? every.seconds : (every.beats * 60) / bpm;
        const rate = flashesPerSecond(steps, stepSeconds, l.timing.attack, l.timing.order);
        if (rate > MAX_FLASHES_PER_SECOND) warn(`look ${l.id}`, say(`jusqu'à ${rate.toFixed(1)} éclats par seconde${"beats" in every ? ` à ${bpm} BPM` : ""} : au-delà de ${MAX_FLASHES_PER_SECOND}, un risque pour les personnes photosensibles (WCAG 2.3.1) ; ralentir la cadence ou adoucir l'attaque`, `up to ${rate.toFixed(1)} flashes a second${"beats" in every ? ` at ${bpm} BPM` : ""}: above ${MAX_FLASHES_PER_SECOND}, a risk for photosensitive people (WCAG 2.3.1); slow the rate down or soften the attack`));
      }
      // once per model: the same .qxf fixes them all
      const missing = new Map<string, string[]>();
      for (const m of runtime.venue.missingDefinitions()) missing.set(m.model, [...(missing.get(m.model) ?? []), m.name]);
      for (const [model, names] of missing) warn(say(`projecteur ${names.join(", ")}`, `fixture ${names.join(", ")}`), say(`définition manquante : ${model} — canaux non décodés, ajouter son .qxf (page Import)`, `missing definition: ${model} — channels not decoded, add its .qxf (Import page)`));
      // colour components a definition without <Head> repeats out of any head (names the deduction cannot split): only
      // one zone gets the colour. Info: a mono-colour pixel or an extra channel is often meant so
      const escaping = new Map<string, { names: string[]; channels: Set<string> }>();
      for (const f of runtime.venue.installed()) {
        const r = runtime.venue.resolve(f.id);
        if ("error" in r || !r.escapedColours.length) continue;
        const key = `${f.manufacturer} ${f.model} (${f.mode})`;
        const found = escaping.get(key) ?? { names: [], channels: new Set<string>() };
        found.names.push(f.name);
        for (const o of r.escapedColours) found.channels.add(r.mode.channels[o]!); // every fixture of the model counted, none overwriting another
        escaping.set(key, found);
      }
      for (const [model, { names, channels }] of escaping)
        note(
          say(`projecteur ${names.join(", ")}`, `fixture ${names.join(", ")}`),
          say(
            `${model} : les canaux ${[...channels].join(", ")} répètent une couleur hors de toute tête et ne reçoivent pas la couleur peinte ; pour en faire des zones, déclarer ses têtes (<Head>) dans la définition ou numéroter les canaux de chaque zone (« … 1 », « … 2 »)`,
            `${model}: channels ${[...channels].join(", ")} repeat a colour out of any head and do not get the painted colour; to make them zones, declare its heads (<Head>) in the definition or number each zone's channels (“… 1”, “… 2”)`,
          ),
        );
      // duplicate definitions: only those of a model the venue patches, and only when they change what it gets
      // (identical copies are harmless; an unused duplicate in the library is not this show's business)
      const dups = duplicatesUsedBy(runtime.venue.duplicateDefinitions(), runtime.venue.fixtures.list().map((f) => aliasTarget(runtime.venue.aliases, f)));
      for (const g of dups.sameName.filter((x) => x.others.some((o) => !o.identical))) warn(say(`définition ${g.manufacturer} ${g.model}`, `definition ${g.manufacturer} ${g.model}`), sameNameMessage(g));
      for (const g of dups.sameSignature.filter(crossManufacturer)) warn(say("définitions", "definitions"), sameSignatureMessage(g));
      sameName("look", runtime.looks.list());
      sameName(say("groupe", "group"), runtime.groups.list());
      sameName("fader", runtime.faders.list());
      // mappings: the same label for different targets (three QLC+ sliders all called « Master »)
      const labels = new Map<string, { id: string; target: string }>();
      for (const m of mappings()) {
        if (!m.label.trim()) continue;
        // the object, not the command: a fader and a button for one thing (a DCA and a look sharing its id) are a pair
        const target = typeof m.on.args.id === "string" ? m.on.args.id : m.on.command;
        const key = m.label.trim().toLocaleLowerCase("fr");
        const other = labels.get(key);
        if (other && other.target !== target) warn(`mapping ${m.id}`, say(`même libellé que ${other.id} (« ${m.label} ») pour une autre cible : renommer l'un des deux pour les distinguer`, `same label as ${other.id} (“${m.label}”) for another target: rename one of them to tell them apart`));
        else if (!other) labels.set(key, { id: m.id, target });
      }
      const checkChannels = (where: string, channels: { fixture: string; offset: number }[]) => {
        for (const c of channels) {
          const problem = runtime.venue.channelProblem(c);
          if (problem) err(where, problem);
        }
      };
      for (const f of runtime.faders.list()) {
        checkChannels(`fader ${f.id}`, f.channels);
        if (f.dca && !runtime.groups.get(f.dca)) err(`fader ${f.id}`, say(`DCA inconnu ${f.dca}`, `unknown DCA ${f.dca}`));
        // a fader on dimmers doses them: left at 0, those fixtures stay dark whatever plays
        const darkened = [...new Set(f.channels.filter((c) => runtime.dosesDimmer(c.fixture, c.offset)).map((c) => runtime.venue.fixtures.get(c.fixture)?.name ?? c.fixture))];
        if (darkened.length && f.level === 0 && (f.range?.min ?? 0) === 0)
          warn(`fader ${f.id}`, say(`à 0, il éteint ${darkened.length} projecteur(s) (${darkened.slice(0, 4).join(", ")}${darkened.length > 4 ? "…" : ""}) tant qu'on ne le monte pas`, `at 0 it darkens ${darkened.length} fixture(s) (${darkened.slice(0, 4).join(", ")}${darkened.length > 4 ? "…" : ""}) until it is raised`));
      }
      for (const l of runtime.looks.list()) if (l.channels) checkChannels(`look ${l.id}`, l.channels.targets);
      // the intentions a song names: known; one of this machine is copied into the show's archives
      const intentionsNow = stack();
      // one of this machine the show names but the schema refuses: the backups go without it
      const keyNow = refKey(intentionsNow);
      for (const r of embeddedIntentions(intentionsNow, intentionUsesByKey(showParts(), keyNow).keys()).refused)
        warn(
          say(`intention ${r.id}`, `intention ${r.id}`),
          say(`« ${r.label} » vient de cette machine et ne sera pas emportée par les sauvegardes du show : ${r.why} ; la corriger`, `“${r.label}” comes from this machine and will not be carried by the show's backups: ${r.why}; fix it`),
        );
      for (const m of intentions.base().privateMerged ?? []) warn(say("fichier privé des intentions", "private intentions file"), say(`${m.words.map((w) => `« ${w} »`).join(", ")} donnent la même clé « ${m.key} » : seule la dernière compte ; renommer les autres`, `${m.words.map((w) => `“${w}”`).join(", ")} make the same key “${m.key}”: only the last one counts; rename the others`));
      for (const e of intentions.loadErrors?.() ?? []) warn("intentions", say(`fichier ignoré, illisible : ${e}`, `file left out, unreadable: ${e}`));
      // several intentions of one label (T15b): allowed, but a word naming that label goes to one only
      for (const d of duplicateLabels(intentionsNow)) {
        const [first] = d.entries;
        const list = d.entries.map((e) => `« ${e.label || e.id} » (${originWord(e.origin)}, ${e.id})`).join(", ");
        const listEn = d.entries.map((e) => `“${e.label || e.id}” (${originWord(e.origin)}, ${e.id})`).join(", ");
        // the nearest wins a name, even over the key of a shipped or private one (decision of 2026-11-12)
        // the one a word of that label goes to, as songs read it (not merely the first listed)
        const winner = resolveIntention(intentionsNow, first!.label || first!.id)?.entry ?? first!;
        const won = `${winner.label || winner.id} (${originWord(winner.origin)}, ${winner.id})`;
        warn(
          say(`intentions « ${first!.label || first!.id} »`, `intentions “${first!.label || first!.id}”`),
          say(
            `${d.entries.length} intentions portent ce libellé : ${list} ; un mot qui le nomme par son nom va à la plus proche, ${won}, même s'il était la clé d'une autre. Renommer l'une, ou n'en garder qu'une`,
            `${d.entries.length} intentions have this label: ${listEn}; a word naming it by its name goes to the nearest, ${won}, even when it was another one's key. Rename one, or keep only one`,
          ),
        );
      }
      /** A word that names nothing here: unknown, or masked; said once per place. */
      const unknownWord = (where: string, word: string, e: IntentionEntry | undefined) =>
        warn(
          where,
          say(`intention inconnue « ${word} »${e?.hidden ? " (masquée dans ce show)" : ""} : la grille ne sait pas quelles couleurs prendre`, `unknown intention “${word}”${e?.hidden ? " (hidden in this show)" : ""}: the grid does not know which colours to take`) +
            // a strict form is exact: said, with the id it may have meant
            (!e && strictHint(intentionsNow, word) ? ` (${strictHint(intentionsNow, word)!})` : "") +
            // the private file's ids are its keywords: one renamed there no longer answers to the old word
            (!e && intentions.base().private ? say(" (un mot-clé renommé dans le fichier privé des intentions casse les liaisons de l'ancien : le remettre, ou recréer l'intention dans le show ou la bibliothèque)", " (a keyword renamed in the private intentions file breaks what named the old one: put it back, or make the intention again in the show or the library)") : ""),
        );
      /** A word written by name that several intentions answer to: it goes to the first, said so. */
      const ambiguous = (where: string, word: string, r: ResolvedIntention) =>
        warn(
          where,
          say(
            `« ${word} » nomme ${r.candidates.length} intentions (${r.candidates.map((c) => `${c.label || c.id} : ${originWord(c.origin)}, ${c.id}`).join(" ; ")}) : il va à « ${r.entry.label || r.entry.id} » (${originWord(r.entry.origin)}, ${r.entry.id}), la plus proche ; la choisir dans le sélecteur (une plus lointaine s'écrit « =id », sa forme stricte) pour la fixer`,
            `“${word}” names ${r.candidates.length} intentions (${r.candidates.map((c) => `${c.label || c.id}: ${originWord(c.origin)}, ${c.id}`).join("; ")}): it goes to “${r.entry.label || r.entry.id}” (${originWord(r.entry.origin)}, ${r.entry.id}), the nearest; pick it in the selector (a farther one is written “=id”, its strict form) to pin it`,
          ),
        );
      for (const l of runtime.looks.list())
        for (const t of l.tags) {
          if (!t.startsWith(AMBIANCE)) continue;
          const r = resolveIntention(intentionsNow, t.slice(AMBIANCE.length));
          if (r && r.by !== "id" && r.candidates.length > 1) ambiguous(`look ${l.id}`, t.slice(AMBIANCE.length), r);
        }
      for (const s of songs.list()) {
        if (!s.mood.length) warn(say(`chant ${s.id}`, `song ${s.id}`), say("pas d'ambiance globale", "no overall mood"));
        for (const word of s.mood) {
          const r = resolveIntention(intentionsNow, word);
          const e = r?.entry;
          if (!e || e.hidden) unknownWord(say(`chant ${s.id}`, `song ${s.id}`), word, e);
          else if (r.by !== "id" && r.candidates.length > 1) ambiguous(say(`chant ${s.id}`, `song ${s.id}`), word, r);
          if (e && !e.hidden && (e.origin === "personal" || e.origin === "private")) {
            // worth knowing: it lives on this machine, the show's archives carry a copy of it
            const from = e.origin === "personal" ? say("de la bibliothèque personnelle", "of the personal library") : say("du fichier privé", "of the private file");
            note(say(`chant ${s.id}`, `song ${s.id}`), say(`intention « ${e.label ?? word} » ${from} : les sauvegardes du show en emportent une copie, rendue comme intention du show à la restauration`, `intention “${e.label ?? word}” ${from}: the show's backups carry a copy of it, restored as an intention of the show`));
          }
        }
        s.sections.forEach((sec, i) => {
          if (!sec.look) warn(say(`chant ${s.id}`, `song ${s.id}`), say(`section ${sec.id} sans look`, `section ${sec.id} without a look`));
          else if (!runtime.looks.get(sec.look)) err(say(`chant ${s.id}`, `song ${s.id}`), say(`section ${sec.id} : look inconnu ${sec.look}`, `section ${sec.id}: unknown look ${sec.look}`));
          if (sec.program && !runtime.programs.get(sec.program)) err(say(`chant ${s.id}`, `song ${s.id}`), say(`section ${sec.id} : programme inconnu ${sec.program}`, `section ${sec.id}: unknown program ${sec.program}`));
          const prev = s.sections[i - 1];
          if (prev?.look && prev.look === sec.look && prev.idea !== sec.idea) warn(say(`chant ${s.id}`, `song ${s.id}`), say(`${prev.id} et ${sec.id} ont le même look alors que l'idée change`, `${prev.id} and ${sec.id} have the same look though the idea changes`));
        });
      }
      return { ok: !issues.some((i) => i.level === "erreur"), issues };
    },
  });
}
