/**
 * Base commands: DMX console (park/release), blackout, output and Art-Net nodes.
 */
import { z } from "zod";
import type { CommandRegistry } from "./registry.js";
import type { DmxEngine } from "../engine/dmx-engine.js";
import type { OutputRouter } from "../output/output-router.js";

const universe = z.number().int().min(1).describe("Univers (1..N)");
const channel = z.number().int().min(1).max(512).describe("Canal DMX (1..512)");
const value = z.number().int().min(0).max(255).describe("Valeur (0..255)");

export function registerCoreCommands(reg: CommandRegistry, engine: DmxEngine, router: OutputRouter): void {
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
        if (v === undefined) throw new Error("value requis avec channel");
        entries.push([c, v]);
      }
      if (entries.length === 0) throw new Error("rien à forcer : donner channel+value ou values");
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
    description: "Art-Net/sACN output: routes, packets sent, errors, discovery state.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({}),
    run: () => ({ config: router.getConfig(), stats: router.stats, frames: engine.frames }),
  });

  reg.register({
    name: "nodes.list",
    title: "Nodes Art-Net",
    description: "Art-Net nodes discovered on the network (ArtPollReply), with their output port-addresses.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({}),
    run: () => router.registry.list().map(({ key, ip, shortName, longName, outputAddresses, mac, nodeReport, lastSeen }) => ({ key, ip, shortName, longName, outputAddresses, mac, nodeReport, lastSeen })),
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
