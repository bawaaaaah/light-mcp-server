/** The light plugin's machine config (core/config-store.ts, scope « light ») and the one way to change it. */
import { z } from "zod";
import type { ScopedConfigStore } from "../../core/config-store.js";
import { MidiProfileSchema } from "./commands/midi-commands.js";
import { portPath } from "./output/dmx-usb.js";

const RouteSchema = z.object({
  universe: z.number().int().min(1),
  artnet: z.object({ portAddress: z.number().int().min(0).max(32767), send: z.enum(["auto", "broadcast", "nodes"]).optional(), targets: z.array(z.string()).optional(), broadcast: z.boolean().optional() }).optional(),
  sacn: z.object({ universe: z.number().int().min(1).max(63999), priority: z.number().int().min(0).max(200).optional(), unicast: z.array(z.string()).optional() }).optional(),
  usb: z.object({ path: z.string().min(1).transform((p) => portPath(p)), kind: z.enum(["open", "pro"]) }).optional(),
});

export const LightConfigSchema = z.object({
  universes: z.number().int().min(1).max(16).default(4),
  output: z
    .object({
      bindAddress: z.string().optional(),
      artSync: z.boolean().optional(),
      sourceName: z.string().optional(),
      /** Tests only: another Art-Net port, out of reach of the real consoles and nodes. */
      artnetPort: z.number().int().min(1).max(65535).optional(),
      routes: z.array(RouteSchema),
      /** Standby: the show runs but nothing is sent (QLC+ or another console holds the nodes). Kept across restarts. */
      standby: z.boolean().default(false),
    })
    .prefault({ routes: [{ universe: 1, artnet: { portAddress: 0 } }] }),
  discovery: z.boolean().default(true),
  /** Current show and venue (folders under <dataRoot>/shows and /venues). */
  show: z.string().default("default"),
  venue: z.string().default("default"),
  midi: z
    .object({
      profiles: z.record(z.string(), MidiProfileSchema).prefault({ local: MidiProfileSchema.parse({ inputs: ["IAC"] }) }),
      active: z.string().default("local"),
    })
    .prefault({}),
  osc: z.object({ enabled: z.boolean().default(true), port: z.number().int().min(0).max(65535).default(9000), allow: z.array(z.string()).default([]) }).prefault({}),
  /** DJ software (VirtualDJ…) over OS2L: TCP, any DJ computer of the network unless `allow` names some, as for OSC. */
  os2l: z
    .object({
      enabled: z.boolean().default(true),
      port: z.number().int().min(0).max(65535).default(7272),
      allow: z.array(z.string()).default([]),
      /** Announced on the network (mDNS, `_os2l._tcp`), so the DJ software finds the desk by itself. */
      advertise: z.boolean().default(true),
    })
    .prefault({}),
  /** AbleSet (setlist for Ableton Live) followed over OSC: off until the desk turns it on. */
  ableset: z.object({ enabled: z.boolean().default(false), host: z.string().default("127.0.0.1"), port: z.number().int().min(1).max(65535).default(39051) }).prefault({}),
});
export type LightConfig = z.infer<typeof LightConfigSchema>;

/**
 * One section of the config, as a wiring piece sees it: read at the time of use (a profile choice changes it),
 * replaced in memory, then kept on disk (`save` writes the whole config as it is in memory then).
 */
export interface ConfigSection<K extends keyof LightConfig> {
  get(): LightConfig[K];
  put(next: LightConfig[K]): void;
  save(): Promise<void> | undefined;
}

/** The plugin's config in memory: every change goes through put(), then save() keeps it in the machine config. */
export class ConfigCell {
  constructor(
    private value: LightConfig,
    /** The machine config store, read at the time of the save (none: in memory only). */
    private readonly store: () => ScopedConfigStore | undefined,
  ) {}

  get(): LightConfig {
    return this.value;
  }

  put(next: LightConfig): void {
    this.value = next;
  }

  save(): Promise<void> | undefined {
    return this.store()?.set(this.value);
  }

  /** The access to one section only (midi for the MIDI wiring, os2l and ableset for the external sync). */
  section<K extends keyof LightConfig>(key: K): ConfigSection<K> {
    return {
      get: () => this.value[key],
      put: (next) => (this.value = { ...this.value, [key]: next }),
      save: () => this.save(),
    };
  }
}
