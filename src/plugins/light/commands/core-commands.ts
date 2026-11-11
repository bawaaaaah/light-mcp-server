/**
 * Base commands: DMX console (park/release), blackout, output and Art-Net nodes.
 */
import { isIPv4 } from "node:net";
import { z } from "zod";
import { CommandError, type CommandRegistry } from "./registry.js";
import type { DmxEngine } from "../engine/dmx-engine.js";
import type { OutputRouter, UniverseRoute } from "../output/output-router.js";
import { coverage } from "../output/artnet-discovery.js";
import { portPath } from "../output/dmx-usb.js";
import { say } from "../../../core/lang.js";

const universe = z.number().int().min(1).describe("Univers (1..N)");
const channel = z.number().int().min(1).max(512).describe("Canal DMX (1..512)");
const value = z.number().int().min(0).max(255).describe("Valeur (0..255)");

/** A route's output with its cleared fields dropped: an empty list or a null is « back to the default ». */
function compact<T extends object>(o: T): { [K in keyof T]: Exclude<T[K], null> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))) as { [K in keyof T]: Exclude<T[K], null> };
}

export function registerCoreCommands(
  reg: CommandRegistry,
  engine: DmxEngine,
  router: OutputRouter,
  persistStandby: (on: boolean) => Promise<void> = async () => undefined,
  persistRoutes: (routes: UniverseRoute[]) => Promise<void> = async () => undefined,
): void {
  const routeCoverage = () => coverage(router.getConfig().routes, router.registry.list());
  reg.register({
    name: "dmx.get",
    title: "Lire un univers",
    description: "Returns the 512 output values of a universe as rendered by the engine, and the channels parked from the DMX console.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design", "live"],
    schema: z.object({ universe }),
    run: ({ universe: u }) => ({ universe: u, values: Array.from(engine.output.get(u)), parked: engine.parked(u) }),
  });

  reg.register({
    name: "dmx.set",
    title: "Forcer des canaux",
    description: "Parks DMX channels at fixed values (DMX console / programmer). Several channels at once with `values` (channel → value).",
    right: "commands:dmx",
    profiles: ["setup"],
    schema: z.object({ universe, channel: channel.optional(), value: value.optional(), values: z.record(z.string(), value).optional() }),
    run: ({ universe: u, channel: c, value: v, values }) => {
      const entries: [number, number][] = values ? Object.entries(values).map(([k, x]) => [Number(k), x]) : [];
      if (c !== undefined) {
        if (v === undefined) throw new Error(say("value requis avec channel", "value required with channel"));
        entries.push([c, v]);
      }
      if (entries.length === 0) throw new Error(say("rien à forcer : donner channel+value ou values", "nothing to force: give channel+value or values"));
      for (const [ch, x] of entries) engine.park(u, ch, x);
      return { parked: entries.length };
    },
  });

  reg.register({
    name: "dmx.release",
    title: "Relâcher des canaux",
    description: "Releases parked channels: all of them, one universe, or a list of channels.",
    right: "commands:dmx",
    profiles: ["setup"],
    schema: z.object({ universe: universe.optional(), channels: z.array(channel).optional() }),
    run: ({ universe: u, channels }) => ({ released: engine.release(u, channels) }),
  });

  reg.register({
    name: "blackout",
    title: "Blackout",
    description: "Blackout: every channel to zero (strobe included) while on.",
    right: "commands:blackout",
    profiles: ["setup", "design", "live"],
    schema: z.object({ on: z.boolean().default(true) }),
    run: ({ on }) => {
      engine.setBlackout(on);
      return { blackout: on };
    },
  });

  reg.register({
    name: "output.status",
    title: "État de la sortie",
    description:
      "Art-Net/sACN/DMX USB output: routes, where each universe actually goes now (destinations: node IPs, broadcast or multicast address), packets sent, errors, discovery state, coverage (routes whose Art-Net port-address no node seen outputs: unheard; node ports no route feeds: unfed; routes sent to chosen nodes none of which answered discovery while another node outputs their address: misdirected, with the nodes that do), sendHealth (sends and errors per target host over the last windowSeconds; failing = most sends failed, i.e. that host does not answer), and the DMX USB interfaces in use (open, frames sent, error).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({}),
    run: () => ({
      config: router.getConfig(),
      stats: router.stats,
      frames: engine.frames,
      standby: router.isStandby(),
      foreignSources: router.foreignSources(),
      merging: router.registry.list().filter((n) => n.merging.length).map((n) => ({ ip: n.ip, shortName: n.shortName, portAddresses: n.merging })),
      coverage: routeCoverage(),
      sendHealth: router.sendHealth(),
      destinations: router.destinations(),
      universes: engine.output.count,
      usb: { available: router.usb.binding !== undefined, ...(router.usb.error ? { error: router.usb.error } : {}), devices: router.usb.status() },
    }),
  });

  reg.register({
    name: "output.usb.list",
    title: "Interfaces DMX USB",
    description: "The serial ports of this machine a DMX USB interface may be on (FTDI chips first: Enttec Open DMX, USB Pro and their clones), to route a universe to with output.route.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({}),
    run: async () => ({ available: router.usb.binding !== undefined, ...(router.usb.error ? { error: router.usb.error } : {}), ports: await router.usb.list() }),
  });

  reg.register({
    name: "output.route",
    title: "Router un univers",
    description:
      "Where a universe goes, any of: an Art-Net port-address, sent as `send` says — « auto » (default) to the nodes that output it, else broadcast (unless broadcast is false), « broadcast » to the whole network, « nodes » only to the node IPs in `targets` (none: nothing is sent; a node answering every address stays out unless ticked); an sACN universe (multicast, or unicast to the IPs in `unicast`; an empty list goes back to multicast); a DMX USB interface plugged into this machine (its serial port from output.usb.list, and its kind: « open » for Open DMX and FTDI cables, « pro » for USB Pro). null removes that output; all removed, the universe is not sent. An interface feeds one universe. Takes effect at once (the fixtures there light up with the show) and is kept in the machine config.",
    right: "commands:output",
    profiles: ["setup"],
    schema: z.object({
      universe,
      artnet: z
        .object({ portAddress: z.number().int().min(0).max(32767), send: z.enum(["auto", "broadcast", "nodes"]).optional(), targets: z.array(z.string().min(1)).optional(), broadcast: z.boolean().nullable().optional() })
        .nullable()
        .optional(),
      sacn: z.object({ universe: z.number().int().min(1).max(63999), priority: z.number().int().min(0).max(200).optional(), unicast: z.array(z.string().min(1)).optional() }).nullable().optional(),
      usb: z.object({ path: z.string().min(1).transform((p) => portPath(p)), kind: z.enum(["open", "pro"]).default("open") }).nullable().optional(),
    }),
    run: async ({ universe: u, artnet, sacn, usb }) => {
      if (u > engine.output.count) throw new CommandError("invalid", say(`univers ${u} hors de 1..${engine.output.count}`, `universe ${u} out of 1..${engine.output.count}`));
      const routes = router.getConfig().routes;
      const before = routes.find((r) => r.universe === u);
      const next: UniverseRoute = { universe: u };
      // a field left out keeps its value: the targets stay chosen while « auto » or « broadcast » is tried;
      // an empty list, or a null broadcast, clears it
      // a node address is IPv4; a value already stored stays as it is, so a route saved before this check can still be edited
      const checkIps = (given: string[] | undefined, stored: string[] | undefined) => {
        const bad = given?.find((ip) => !stored?.includes(ip) && !isIPv4(ip));
        if (bad !== undefined) throw new CommandError("invalid", say(`« ${bad} » n'est pas une adresse IPv4`, `“${bad}” is not an IPv4 address`));
      };
      checkIps(artnet?.targets, before?.artnet?.targets);
      checkIps(sacn?.unicast, before?.sacn?.unicast);
      const a = artnet === undefined ? before?.artnet : artnet === null ? undefined : compact({ ...before?.artnet, ...artnet });
      const s = sacn === undefined ? before?.sacn : sacn === null ? undefined : compact({ ...before?.sacn, ...sacn });
      const d = usb === undefined ? before?.usb : usb === null ? undefined : usb;
      if (a) next.artnet = a;
      if (s) next.sacn = s;
      if (d) next.usb = d;
      const others = routes.filter((r) => r.universe !== u);
      const taken = usb && others.find((r) => r.usb?.path === usb.path); // only for an interface being given: an old config with two routes to one port can still be edited otherwise
      if (taken) throw new CommandError("invalid", say(`${usb.path} sort déjà l'univers ${taken.universe} : une interface DMX USB sort un seul univers`, `${usb.path} already outputs universe ${taken.universe}: a DMX USB interface outputs one universe`));
      const updated = (next.artnet || next.sacn || next.usb ? [...others, next] : others).sort((x, y) => x.universe - y.universe);
      router.setRoutes(updated);
      await persistRoutes(updated);
      return { routes: updated, coverage: routeCoverage() };
    },
  });

  reg.register({
    name: "output.standby",
    title: "Sortie en veille",
    description:
      "Standby (on): the show keeps running and following MIDI, but no Art-Net/sACN is sent, so another console (QLC+) can hold the nodes without a merge. Off: every universe is sent again at once. Kept across restarts. Used for the switchover with QLC+ (docs/bascule-qlc.md).",
    right: "commands:output",
    profiles: ["setup", "live"],
    schema: z.object({ on: z.boolean() }),
    run: async ({ on }) => {
      router.setStandby(on);
      await persistStandby(on);
      return { standby: on, foreignSources: router.foreignSources().map((f) => f.ip) };
    },
  });

  reg.register({
    name: "nodes.list",
    title: "Nodes Art-Net",
    description: "Art-Net nodes discovered on the network (ArtPollReply), with their output ports: port-address, DMX going out (data), Art-Net or sACN, merge mode.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({}),
    run: () => router.registry.list().map(({ key, ip, shortName, longName, outputAddresses, ports, mac, nodeReport, lastSeen }) => ({ key, ip, shortName, longName, outputAddresses, ports, mac, nodeReport, lastSeen })),
  });

  reg.register({
    name: "nodes.discover",
    title: "Chercher les nodes",
    description: "Sends an ArtPoll now (discovery also runs every 3 s).",
    right: "commands:output",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({}),
    run: () => {
      router.poll();
      return { discovery: router.stats.discovery };
    },
  });
}
