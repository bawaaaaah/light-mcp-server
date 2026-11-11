/**
 * The two « modes » of a fixture (T6, docs/specs/venue-fixtures-stage.md):
 * - venue.fixture.mode: its DMX mode (the definition's personality: 14 channels, 29 channels…), the
 *   objects naming its channels carried over by channel name (venue/mode-change.ts), written as one
 *   proposal (show.propose + show.apply: all or nothing, one show.revert takes it back);
 * - fixture.channel.mode: a channel's working mode (a channel cut into named functions, read as modes and
 *   variants by venue/channel-modes.ts), set through the channel's own fader (fader.channel), highest
 *   takes precedence with the looks (decision T6, question 2): a look holding it higher is named.
 */
import path from "node:path";
import { z } from "zod";
import { say } from "../../../core/lang.js";
import { FolderStore } from "../data/store.js";
import type { DmxEngine } from "../engine/dmx-engine.js";
import { ChannelFaderSchema, LookSchema, type ChannelFader, type Look } from "../show/model.js";
import type { ShowRuntime } from "../show/runtime.js";
import { channelModes, valueOf } from "../venue/channel-modes.js";
import { headsOf } from "../venue/heads.js";
import { freeAddress, planReferences, remapByName, type Carried, type ModeLayout } from "../venue/mode-change.js";
import { beyondMessage, overlapMessage, patchBeyondUniverse, patchOverlaps } from "../venue/patch-check.js";
import { findMode, type FixtureDefinition, type FixtureMode } from "../venue/qxf-import.js";
import type { Canvas } from "../venue/venue.js";
import { CommandError, type CommandRegistry } from "./registry.js";
import type { ProposalHooks, ShowCommandsApi } from "./show-commands.js";

/** Another show on the open venue, as its folder holds it (not opened). */
export interface OtherShow {
  id: string;
  name: string;
  /** data/shows/<id> and its history folder. */
  dir: string;
  backups: string;
}

export interface FixtureModeOptions {
  /** The other shows on the open venue, by name; throws when one's settings cannot be read. */
  sharedWith?: () => string[];
  /** The same shows with their folders, for a change made for every show (`shared: "all"`); throws likewise. */
  otherShows?: () => OtherShow[];
}

/** One show's looks and faders that a mode change rewrites, and how to put them back. */
interface Rewrite {
  show: string;
  looks: Look[];
  faders: ChannelFader[];
  emptied: ChannelFader[];
  carried: Carried[];
  store?: { looks: { put(v: unknown): unknown; get(id: string): Look | undefined }; faders: { put(v: unknown): unknown; get(id: string): ChannelFader | undefined; delete(id: string): boolean } };
}

export function registerFixtureModeCommands(reg: CommandRegistry, engine: DmxEngine, show: ShowRuntime, api: ShowCommandsApi, options: FixtureModeOptions = {}): void {
  const venue = show.venue;
  const { sharedWith = () => [], otherShows = () => [] } = options;

  const layoutOf = (def: FixtureDefinition, mode: FixtureMode | undefined, overrides: Parameters<typeof headsOf>[2]): ModeLayout =>
    mode ? { channels: mode.channels, heads: new Map([...headsOf(def, mode, overrides).heads].map(([h, comps]) => [h, Object.values(comps)])) } : { channels: [], heads: new Map() };

  /** A lost or moved reference as people read it. */
  const sentence = (c: Carried): string => {
    const what = { look: say("look", "look"), fader: say("fader", "fader"), canvas: say("canevas", "canvas") }[c.kind];
    if (c.kind === "canvas") return c.fate === "lost" ? say(`${what} « ${c.name} » : tête ${c.from + 1} perdue`, `${what} “${c.name}”: head ${c.from + 1} lost`) : say(`${what} « ${c.name} » : tête ${c.from + 1} → ${c.to! < 0 ? "projecteur entier" : c.to! + 1}`, `${what} “${c.name}”: head ${c.from + 1} → ${c.to! < 0 ? "whole fixture" : c.to! + 1}`);
    const channel = c.channel ? ` « ${c.channel} »` : "";
    if (c.fate !== "lost") return say(`${what} « ${c.name} » : canal${channel} ${c.from + 1} → ${c.to! + 1}`, `${what} “${c.name}”: channel${channel.replace(/[«»]/g, '"')} ${c.from + 1} → ${c.to! + 1}`);
    const why = { absent: say("absent du nouveau mode", "not in the new mode"), ambiguous: say("nom en double, ambigu", "repeated name, ambiguous"), beyond: say("au-delà de l'ancien mode", "beyond the old mode") }[c.why ?? "absent"];
    return say(`${what} « ${c.name} » : canal${channel} ${c.from + 1} perdu (${why})`, `${what} “${c.name}”: channel${channel.replace(/[«»]/g, '"')} ${c.from + 1} lost (${why})`);
  };

  reg.register({
    name: "venue.fixture.mode",
    title: "Changer le mode DMX",
    description:
      "Changes a patched fixture's DMX mode (one of its definition's modes, venue.library), carrying over by channel name what names its channels: the raw channels of looks, the channels of channel faders, the heads canvases target (a head is known by its channels' names). A channel whose name is not in the new mode, or is repeated in either mode, is lost: taken out of the look or the fader (a fader left with none is deleted), a lost canvas target taken out of the canvas (cellsWithoutRender says which cells it leaves dark). dryRun: the plan only, nothing written (show it first). Written as one proposal, fixture first then canvases, faders, looks, all or nothing: show.revert with the returned proposal id takes it all back. Refused unless force when something is lost or the new footprint shares channels with another fixture (freeAddress: the first place where it fits). A venue shared with other shows is refused unless `shared` says what to do: « copy » gives this show its own copy of the venue first (show.venue.detach), « all » changes it for every show and carries over their looks and faders too. Looks playing whose channels move are restarted (relaunched). info: overrides of the model that no longer apply in the new mode (a wheel, a halo).",
    right: "show:write",
    profiles: ["setup"],
    dry: (a) => a.dryRun,
    schema: z.object({
      id: z.string(),
      mode: z.string().min(1),
      dryRun: z.boolean().default(false),
      force: z.boolean().default(false).describe("change it even if references are lost or the new footprint shares channels with another fixture"),
      shared: z.enum(["copy", "all"]).optional().describe("the venue is shared with other shows: « copy » = a venue of its own for this show first, « all » = for every show, their looks and faders carried over too"),
    }),
    run: async ({ id, mode, dryRun, force, shared }, ctx) => {
      let f = venue.fixtures.get(id);
      if (!f) throw new CommandError("invalid", say(`fixture inconnue : ${id}`, `unknown fixture: ${id}`));
      const def = venue.definitionFor(f.manufacturer, f.model);
      if (!def) throw new CommandError("invalid", say(`définition manquante : ${f.manufacturer} ${f.model} (ses modes ne sont pas connus)`, `missing definition: ${f.manufacturer} ${f.model} (its modes are not known)`));
      const target = def.modes.find((m) => m.name === mode) ?? findMode(def, mode);
      const known = def.modes.map((m) => `${m.name} (${m.channels.length})`).join(", ");
      if (!target) throw new CommandError("invalid", say(`mode inconnu pour ${def.model} : ${mode}. Modes : ${known}`, `unknown mode for ${def.model}: ${mode}. Modes: ${known}`), { modes: def.modes.map((m) => ({ name: m.name, channels: m.channels.length })) });
      const current = findMode(def, f.mode);
      if (f.mode === target.name) return { fixture: id, from: f.mode, to: target.name, unchanged: true };

      // the other shows on the venue: their looks would keep the old offsets, so the user chooses
      let others: string[] = [];
      try {
        others = sharedWith();
      } catch (err) {
        const reason = (err as Error).message;
        if (!force) throw new CommandError("invalid", `${reason}. ${say("Changer le mode quand même, sans les autres shows de ce lieu : force: true", "Change the mode anyway, without the venue's other shows: force: true")}`, { force: true, reason });
      }
      if (others.length && !dryRun) {
        if (!shared) {
          throw new CommandError(
            "invalid",
            say(
              `ce lieu est partagé avec d'autres shows (${others.join(", ")}) : leurs looks et faders garderaient les anciens canaux. Choisir shared: « copy » (un lieu à ce show, les autres gardent l'ancien) ou « all » (pour tous les shows, leurs looks et faders reportés aussi)`,
              `this venue is shared with other shows (${others.join(", ")}): their looks and faders would keep the old channels. Choose shared: “copy” (a venue of this show's own, the others keep the old one) or “all” (for every show, their looks and faders carried over too)`,
            ),
            { shared: others },
          );
        }
        if (shared === "copy") {
          // the open show gets its own copy and is reopened on it (same show): the fixture is now the copy's
          await reg.invoke("show.venue.detach", {}, ctx);
          f = venue.fixtures.get(id);
          if (!f) throw new CommandError("failed", say(`fixture absente de la copie du lieu : ${id}`, `fixture missing from the venue's copy: ${id}`));
        }
      }
      const detached = shared === "copy" && others.length > 0 && !dryRun;
      const carryOthers = shared === "all" && others.length > 0;

      const overrides = venue.overridesOf(f);
      const remap = remapByName(layoutOf(def, current, overrides.heads), layoutOf(def, target, overrides.heads));
      const here = planReferences(id, remap, { looks: show.looks.list(), faders: show.faders.list(), canvases: venue.canvases.list() as Canvas[] });
      const rewrites: Rewrite[] = [{ show: say("ce show", "this show"), looks: here.looks, faders: here.faders, emptied: here.emptied, carried: here.carried }];
      if (carryOthers) {
        for (const o of otherShows()) {
          const store = new FolderStore(o.dir, o.backups);
          const looks = store.collection("looks", LookSchema);
          const faders = store.collection("faders", ChannelFaderSchema);
          const p = planReferences(id, remap, { looks: looks.list(), faders: faders.list(), canvases: [] });
          rewrites.push({ show: o.name, looks: p.looks, faders: p.faders, emptied: p.emptied, carried: p.carried, store: { looks, faders } });
        }
      }

      // the footprint: overlaps it creates (not those already there), past 512, the first place where it fits
      const count = target.channels.length;
      const ranges = venue.patchRanges().map((r) => (r.id === id ? { ...r, channels: count, kind: `${f!.manufacturer}|${f!.model}|${target.name}` } : r));
      const name = (x: string) => venue.fixtures.get(x)?.name ?? x;
      const pair = (o: { a: string; b: string }) => [o.a, o.b].sort().join("|");
      const before = new Set(venue.patchProblems(id).map(pair));
      const overlaps = patchOverlaps(ranges).filter((o) => (o.a === id || o.b === id) && !before.has(pair(o)));
      const beyond = patchBeyondUniverse(ranges).filter((b) => b.id === id);
      const free = overlaps.length || beyond.length ? freeAddress(ranges, f.universe, count, id) : undefined;
      // the model's corrections never move (no offset in them), but may no longer act
      const info: string[] = [];
      if (overrides.wheel && !target.channels.some((n) => def.channels.get(n)?.attribute === "colorWheel")) info.push(say("la correspondance de roue ne s'applique pas : ce mode n'a pas de roue de couleurs", "the wheel correspondence does not apply: this mode has no colour wheel"));
      if (overrides.heads?.accent?.length && !overrides.heads.accent.some((n) => target.channels.includes(n))) info.push(say("aucun canal d'halo listé n'est dans ce mode : la détection par nom s'applique", "none of the listed halo channels is in this mode: the detection by name applies"));

      const all = rewrites.flatMap((r) => r.carried.map((c) => ({ ...c, show: r.show })));
      const lost = all.filter((c) => c.fate === "lost");
      const moved = all.filter((c) => c.fate === "moved");
      const emptied = rewrites.flatMap((r) => r.emptied.map((x) => ({ show: r.show, id: x.id, name: x.name })));
      const relaunched = here.looks.filter((l) => show.isActive(l.id)).map((l) => l.name);
      const plan = {
        fixture: id,
        name: f.name,
        from: f.mode,
        to: target.name,
        channels: { before: current?.channels.length ?? null, after: count },
        address: { universe: f.universe, from: f.address, to: f.address + count - 1 },
        moved: moved.map((c) => ({ ...c, message: sentence(c) })),
        lost: lost.map((c) => ({ ...c, message: sentence(c) })),
        emptied,
        cellsWithoutRender: here.cellsWithoutRender,
        overlaps: overlaps.map((o) => overlapMessage(o, name)),
        beyond: beyond.map((b) => beyondMessage(b, name)),
        ...(free !== undefined ? { freeAddress: free } : {}),
        info,
        relaunched,
        sharedWith: detached ? [] : others,
        ...(carryOthers ? { otherShows: rewrites.slice(1).map((r) => ({ show: r.show, looks: r.looks.length, faders: r.faders.length, lost: r.carried.filter((c) => c.fate === "lost").length })) } : {}),
      };
      if (dryRun) return { dryRun: true, ...plan };

      const losses = [...plan.lost.map((c) => (rewrites.length > 1 ? `${c.show} · ${c.message}` : c.message)), ...emptied.map((x) => say(`fader « ${x.name} » sans canal, supprimé`, `fader “${x.name}” left with no channel, deleted`))];
      if ((losses.length || plan.overlaps.length) && !force) {
        throw new CommandError(
          "invalid",
          say(`mode ${target.name} non appliqué : ${[...losses, ...plan.overlaps].join(" ; ")}. L'appliquer quand même : force: true`, `mode ${target.name} not applied: ${[...losses, ...plan.overlaps].join("; ")}. Apply it anyway: force: true`),
          { force: true, plan },
        );
      }

      // one proposal: the fixture first (looks and faders are checked against its mode), then canvases, faders, looks
      const changes = [
        { command: "venue.fixture.put", args: { fixture: { ...f, mode: target.name } } },
        // the same cells drive the same lamps, renumbered: no look shifts, and the other shows were dealt with above
        ...here.canvases.map((c) => ({ command: "venue.canvas.put", args: { canvas: c, force: true, shared: true } })),
        ...here.faders.map((x) => ({ command: "fader.put", args: { fader: x } })),
        ...here.looks.map((l) => ({ command: "look.put", args: { look: l } })),
      ];
      const proposed = (await reg.invoke("show.propose", { changes, title: say(`Mode DMX de ${f.name} : ${f.mode} → ${target.name}`, `DMX mode of ${f.name}: ${f.mode} → ${target.name}`) }, ctx)) as { valid: boolean; id?: string; preview: { valid: boolean; issues?: string[] }[] };
      if (!proposed.valid || !proposed.id) throw new CommandError("failed", proposed.preview.flatMap((p) => p.issues ?? []).join(" ; "));
      api.hookProposal(proposed.id, elsewhere(rewrites, show));
      await reg.invoke("show.apply", { id: proposed.id }, ctx);
      return { ...plan, proposal: proposed.id, ...(detached ? { detached: true } : {}) };
    },
  });

  reg.register({
    name: "fixture.channel.mode",
    title: "Mode de fonctionnement d'un canal",
    description:
      "Sets a fixture channel cut into named functions to one of its working modes (venue.fixture.channels `modes`: « Auto », « Sound »…) and, when it has several, a variant (« Auto 2 »), by name: the value sent is the middle of the variant's range (the first variant when none is given; `value` inside the range for a continuous mode, a speed). The channel is given by offset or by name. Sent through the channel's own fader (created at its first touch, as fader.channel), highest takes precedence with the looks: when the output is not in the asked range at once, heldBy names the looks and other faders writing the channel (one of them holds it higher).",
    right: "show:write",
    profiles: ["setup", "design", "live"],
    schema: z
      .object({
        fixture: z.string(),
        offset: z.number().int().min(0).optional(),
        channel: z.string().optional().describe("the channel's name, instead of its offset"),
        mode: z.string().min(1),
        variant: z.string().optional(),
        value: z.number().int().min(0).max(255).optional().describe("a continuous mode's value (DMX, inside its range)"),
      })
      .refine((a) => a.offset !== undefined || a.channel !== undefined, { message: say("donner offset ou channel", "give offset or channel") }),
    run: async ({ fixture, offset, channel, mode, variant, value }, ctx) => {
      // a level is set too (the panel's « Lumière » asks both rights): checked here, a fader created at its level needs no fader.level
      if (!ctx.can("commands:level")) throw new CommandError("forbidden", say("droit requis : commands:level", "right required: commands:level"));
      const r = venue.resolve(fixture);
      if ("error" in r) throw new CommandError("invalid", r.error);
      let at = offset;
      if (at === undefined) {
        const found = r.mode.channels.flatMap((n, i) => (n.toLowerCase() === channel!.toLowerCase() ? [i] : []));
        if (found.length !== 1) throw new CommandError("invalid", found.length ? say(`canal « ${channel} » en double dans ce mode : donner offset`, `channel “${channel}” repeated in this mode: give offset`) : say(`canal inconnu : ${channel}. Canaux : ${r.mode.channels.join(", ")}`, `unknown channel: ${channel}. Channels: ${r.mode.channels.join(", ")}`));
        at = found[0]!;
      }
      const chName = r.mode.channels[at];
      if (chName === undefined) throw new CommandError("invalid", say(`${r.patch.name} n'a que ${r.mode.channels.length} canaux (canal ${at + 1} demandé)`, `${r.patch.name} has only ${r.mode.channels.length} channels (channel ${at + 1} asked)`));
      const modes = channelModes(r.def.channels.get(chName)?.capabilities ?? []);
      if (!modes.length) throw new CommandError("invalid", say(`le canal « ${chName} » n'a pas de fonctions nommées`, `channel “${chName}” has no named functions`));
      const m = modes.find((x) => x.name === mode) ?? modes.find((x) => x.name.toLowerCase() === mode.toLowerCase());
      if (!m) throw new CommandError("invalid", say(`mode inconnu pour « ${chName} » : ${mode}. Modes : ${modes.map((x) => x.name).join(", ")}`, `unknown mode for “${chName}”: ${mode}. Modes: ${modes.map((x) => x.name).join(", ")}`), { modes: modes.map((x) => x.name) });
      const v = variant === undefined ? undefined : (m.variants.find((x) => x.name === variant) ?? m.variants.find((x) => x.name.toLowerCase() === variant.toLowerCase()));
      if (variant !== undefined && !v) throw new CommandError("invalid", say(`variante inconnue de « ${m.name} » : ${variant}. Variantes : ${m.variants.map((x) => x.name).join(", ")}`, `unknown variant of “${m.name}”: ${variant}. Variants: ${m.variants.map((x) => x.name).join(", ")}`));
      if (value !== undefined && !m.continuous) throw new CommandError("invalid", say(`« ${m.name} » n'est pas un mode continu : choisir une variante, pas une valeur`, `“${m.name}” is no continuous mode: choose a variant, not a value`));
      const dmx = valueOf(m, v?.name, value);
      const level = dmx / 255;
      // the channel's own fader, found or created by fader.channel (one logic), then set
      const fader = (await reg.invoke("fader.channel", { fixture, offset: at, name: `${r.patch.name} · ${chName}`, level }, ctx)) as { id: string; created: boolean };
      if (!fader.created) await reg.invoke("fader.level", { id: fader.id, level }, ctx);
      // what goes out now: a look or another fader holding the channel higher wins (HTP), and is named
      engine.render();
      const universe = r.patch.universe;
      const output = engine.output.get(universe)[r.patch.address - 1 + at] ?? 0;
      const range = m.continuous && value !== undefined ? { min: dmx, max: dmx } : (v ?? m.variants[0]!);
      const held = output < range.min || output > range.max;
      const why = held ? show.explainChannel(universe, r.patch.address + at) : undefined;
      return {
        fixture,
        offset: at,
        channel: chName,
        mode: m.name,
        variant: (v ?? m.variants[0]!).name,
        value: dmx,
        fader: fader.id,
        output,
        ...(why ? { heldBy: { looks: why.rawLooks, faders: why.faders.filter((x) => x.id !== fader.id).map(({ id: fid, name }) => ({ id: fid, name })) } } : {}),
      };
    },
  });
}

/** The writes a mode change makes outside the proposal's put commands: emptied faders here, every write in the other shows. */
function elsewhere(rewrites: Rewrite[], show: ShowRuntime): ProposalHooks {
  const undo: (() => void)[] = [];
  return {
    apply() {
      undo.length = 0;
      for (const r of rewrites) {
        const faders = r.store?.faders ?? show.faders;
        for (const x of r.emptied) {
          const was = faders.get(x.id);
          if (was && faders.delete(x.id)) undo.push(() => void faders.put(was));
        }
        if (!r.store) continue; // this show's looks and faders are the proposal's
        const looks = r.store.looks;
        for (const l of r.looks) {
          const was = looks.get(l.id);
          looks.put(l);
          if (was) undo.push(() => void looks.put(was));
        }
        for (const x of r.faders) {
          const was = faders.get(x.id);
          faders.put(x);
          if (was) undo.push(() => void faders.put(was));
        }
      }
    },
    revert() {
      for (const u of [...undo].reverse()) u();
      undo.length = 0;
    },
  };
}

/** The folders of the other shows on a venue, for registerFixtureModeCommands' `otherShows`. */
export const showFolder = (dataRoot: string, id: string, name: string): OtherShow => ({ id, name, dir: path.join(dataRoot, "shows", id), backups: path.join(dataRoot, "backups", "shows", id) });
