/**
 * Channel faders: raw channels (white, UV, strobe, machines) driven at a level.
 * Part of the show commands (show-commands.ts registers them all, with the scope they share: show-command-scope.ts).
 */
import { z } from "zod";
import { ChannelFaderSchema } from "../show/model.js";
import { say } from "../../../core/lang.js";
import type { ShowCommandScope } from "./show-command-scope.js";

export function registerFaderCommands(common: ShowCommandScope): void {
  const { reg, engine, show, venue, removable, deletable, checkChannels } = common;
  // ---- channel faders (white, UV, strobe, machines — like QLC+ « Level » sliders)
  reg.register({ name: "fader.list", title: "Faders de canaux", description: "Channel faders: raw channels (white, UV, strobe, machines…) driven at a level, highest-takes-precedence with the show; on a fixture's dimmer the fader doses it instead (the show holds dimmers at full; at 0 the fixture is dark). A fader dosed by a DCA (dca) follows it.", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => show.faders.list() });
  reg.register({
    name: "fader.put",
    title: "Fader de canaux",
    description: "Creates or updates a channel fader: name, channels as {fixture, offset from its address (0-based)}, level 0..1, optional dca (a group with a master whose level multiplies the fader's). The rules mask still applies after it.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ fader: ChannelFaderSchema }),
    run: ({ fader }) => {
      checkChannels(fader.channels);
      if (fader.range && fader.range.min > fader.range.max) throw new Error(say(`plage du fader inversée : le minimum (${fader.range.min}) dépasse le maximum (${fader.range.max})`, `fader range reversed: the minimum (${fader.range.min}) is above the maximum (${fader.range.max})`));
      if (fader.dca && !show.groups.get(fader.dca)?.master) throw new Error(say(`DCA inconnu : ${fader.dca}`, `unknown DCA: ${fader.dca}`));
      return show.faders.put(fader);
    },
  });
  /** Whether a fader's range leaves part of the travel out (an explicit 0..255 is the whole travel). */
  const narrowed = (range: { min: number; max: number } | undefined) => range !== undefined && (range.min > 0 || range.max < 255);
  reg.register({
    name: "fader.channel",
    title: "Fader d'un canal",
    description: "The fader of one fixture channel, created at its first touch: returns the channel fader driving exactly that channel and nothing else over its whole travel (one narrowed to a function is not reused), or creates one (id panel-<fixture>-<offset>, at `level`; without one, so that creating it switches nothing off: at 1 on the master dimmer of a colour fixture, which such a fader doses, else at the value the channel has on the output now). An existing one is left as it is: move it with fader.level.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ fixture: z.string(), offset: z.number().int().min(0), name: z.string().min(1).optional().describe("the new fader's name; default « <fixture> · <offset + 1> »"), level: z.number().min(0).max(1).optional() }),
    run: ({ fixture, offset, name, level }) => {
      // only a fader over the whole travel is this channel's: one narrowed to a function (T12) is something else
      const own = show.faders.list().find((f) => f.channels.length === 1 && f.channels[0]!.fixture === fixture && f.channels[0]!.offset === offset && !narrowed(f.range));
      if (own) return { ...own, created: false };
      checkChannels([{ fixture, offset }]);
      const patch = venue.fixtures.get(fixture)!;
      const now = engine.output.get(patch.universe)[patch.address - 1 + offset] ?? 0;
      const taken = new Set(show.faders.list().map((f) => f.id));
      const base = `panel-${fixture}-${offset}`;
      let faderId = base;
      for (let k = 2; taken.has(faderId); k++) faderId = `${base}-${k}`;
      // a fader on a colour fixture's master dimmer doses it (runtime.compose): at 1 it changes nothing
      const unchanged = show.dosesDimmer(fixture, offset) ? 1 : Math.round((now / 255) * 1000) / 1000;
      const fader = show.faders.put({ id: faderId, name: name ?? `${patch.name} · ${offset + 1}`, channels: [{ fixture, offset }], level: level ?? unchanged });
      return { ...fader, created: true };
    },
  });
  reg.register({
    name: "fader.delete",
    title: "Supprimer un fader de canaux",
    description: "Deletes a channel fader. Refused while something uses it (mapping, dashboard, snapshot, song), unless force.",
    right: "show:write",
    profiles: ["setup"],
    schema: deletable,
    run: ({ id: i, force }) => (removable("fader", i, show.faders.get(i)?.name, force), { deleted: show.faders.delete(i) }),
  });
  reg.register({
    name: "fader.level",
    title: "Niveau d'un fader de canaux",
    description: "Sets a channel fader's level (0..1).",
    right: "commands:level",
    profiles: ["live", "design"],
    schema: z.object({ id: z.string(), level: z.number().min(0).max(1) }),
    run: ({ id: i, level }) => {
      const f = show.faders.get(i);
      if (!f) throw new Error(say(`fader inconnu : ${i}`, `unknown fader: ${i}`));
      return show.faders.putLive({ ...f, level });
    },
  });
}
