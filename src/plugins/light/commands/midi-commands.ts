/**
 * MIDI, tempo and OSC commands: inputs and profiles, mappings and learn, Web MIDI relay, tempo.
 */
import { z } from "zod";
import type { CommandRegistry } from "./registry.js";
import type { MidiHub, HubMessage } from "../midi/hub.js";
import { MappingSchema, type Mapping, type MidiMapper } from "../midi/mapping.js";
import type { Collection } from "../data/store.js";
import type { TempoClock } from "../timing/tempo.js";
import { oscRoutes } from "../osc/server.js";

export const MidiProfileSchema = z.object({
  inputs: z.array(z.string()).default([]),
  feedbackOutput: z.string().optional(),
  rtp: z.object({ enabled: z.boolean().default(true), port: z.number().int().min(1024).max(65534).default(5004), name: z.string().default("light-mcp-server") }).default({}),
});
export type MidiProfile = z.infer<typeof MidiProfileSchema>;

export interface MidiServices {
  hub: MidiHub;
  mapper: MidiMapper;
  mappings: Collection<Mapping>;
  tempo: TempoClock;
  profiles: () => Record<string, MidiProfile>;
  activeProfile: () => string;
  selectProfile: (name: string) => Promise<void>;
  saveProfile: (name: string, profile: MidiProfile) => Promise<void>;
}

export function registerMidiCommands(reg: CommandRegistry, s: MidiServices): void {
  const reloadMappings = () => s.mapper.setMappings(s.mappings.list());

  reg.register({
    name: "midi.status",
    title: "État MIDI",
    description: "MIDI inputs detected and watched (with last activity), feedback port, RTP-MIDI sessions, active input profile.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "live"],
    schema: z.object({}),
    run: () => ({ ...s.hub.status(), profile: s.activeProfile(), profiles: Object.keys(s.profiles()) }),
  });

  reg.register({
    name: "midi.profile.save",
    title: "Enregistrer un profil d'entrées",
    description: "Saves a MIDI input profile (watched inputs, feedback output, RTP-MIDI session) under a name, e.g. « local IAC » or « RTP régie ».",
    right: "midi:configure",
    profiles: ["setup"],
    schema: z.object({ name: z.string().min(1), profile: MidiProfileSchema }),
    run: async ({ name, profile }) => {
      await s.saveProfile(name, profile);
      return { saved: name };
    },
  });

  reg.register({
    name: "midi.profile.select",
    title: "Basculer de profil d'entrées",
    description: "Switches the active MIDI input profile (e.g. between local MIDI and RTP-MIDI) in one call.",
    right: "midi:configure",
    profiles: ["setup", "live"],
    schema: z.object({ name: z.string() }),
    run: async ({ name }) => {
      await s.selectProfile(name);
      return { active: name };
    },
  });

  reg.register({
    name: "midi.mapping.list",
    title: "Mappings MIDI",
    description: "Lists the show's MIDI mappings (input, mode, commands, feedback).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({}),
    run: () => s.mappings.list(),
  });

  reg.register({
    name: "midi.mapping.put",
    title: "Créer ou modifier un mapping",
    description: "Creates or replaces a MIDI mapping: input (note/CC/PC, channel, number), mode (trigger « Déclencher », latch, momentary « Momentané »), on/off commands, level argument for faders.",
    right: "midi:configure",
    profiles: ["setup", "design"],
    schema: z.object({ mapping: MappingSchema }),
    run: ({ mapping }) => {
      const saved = s.mappings.put(mapping);
      reloadMappings();
      return saved;
    },
  });

  reg.register({
    name: "midi.mapping.delete",
    title: "Supprimer un mapping",
    description: "Deletes a MIDI mapping.",
    right: "midi:configure",
    profiles: ["setup"],
    schema: z.object({ id: z.string() }),
    run: ({ id }) => {
      const deleted = s.mappings.delete(id);
      reloadMappings();
      return { deleted };
    },
  });

  reg.register({
    name: "midi.learn",
    title: "Apprendre une entrée MIDI",
    description: "Waits for the next note, CC or program change on the watched inputs and returns it as a mapping input (learn mode).",
    right: "midi:configure",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({ timeoutMs: z.number().int().min(500).max(60000).default(10000) }),
    run: ({ timeoutMs }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          s.hub.off("message", handler);
          reject(new Error("aucun message MIDI reçu"));
        }, timeoutMs);
        const handler = (m: HubMessage) => {
          const msg = m.msg;
          let input: Mapping["input"] | undefined;
          if (msg.type === "noteon") input = { type: "note", channel: msg.channel, number: msg.note, port: m.port };
          else if (msg.type === "cc") input = { type: "cc", channel: msg.channel, number: msg.controller, port: m.port };
          else if (msg.type === "programchange") input = { type: "programchange", channel: msg.channel, number: msg.program, port: m.port };
          if (!input) return;
          clearTimeout(timer);
          s.hub.off("message", handler);
          resolve({ input });
        };
        s.hub.on("message", handler);
      }),
  });

  reg.register({
    name: "midi.in",
    title: "Message Web MIDI",
    description: "Relays MIDI bytes received by a browser (Web MIDI) into the hub.",
    right: "midi:input",
    schema: z.object({ port: z.string().default("Web MIDI"), bytes: z.array(z.number().int().min(0).max(255)).min(1).max(3) }),
    run: ({ port, bytes }) => {
      s.hub.dispatch("web", port, bytes);
      return { ok: true };
    },
  });

  reg.register({
    name: "tempo.get",
    title: "Tempo",
    description: "Current tempo: BPM, source (manual, tap, MIDI clock), whether the clock is received, beat position.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "design", "live"],
    schema: z.object({}),
    run: () => s.tempo.state(),
  });

  reg.register({
    name: "tempo.tap",
    title: "Tap tempo",
    description: "Tap tempo: call on each beat; returns the BPM once two taps are in.",
    right: "commands:tempo",
    profiles: ["live"],
    schema: z.object({}),
    run: () => ({ bpm: s.tempo.tap() }),
  });

  reg.register({
    name: "tempo.set",
    title: "Régler le tempo",
    description: "Sets a manual BPM, or selects the tempo source (manual, tap, midi = follow MIDI clock).",
    right: "commands:tempo",
    profiles: ["setup", "live"],
    schema: z.object({ bpm: z.number().min(20).max(400).optional(), source: z.enum(["manual", "tap", "midi"]).optional() }),
    run: ({ bpm, source }) => {
      if (bpm !== undefined) s.tempo.setBpm(bpm);
      if (source) s.tempo.setSource(source);
      return s.tempo.state();
    },
  });

  reg.register({
    name: "osc.table",
    title: "Table des adresses OSC",
    description: "Every OSC address the server answers, with its parameters (same content as /light/help).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({}),
    run: () => oscRoutes(reg),
  });
}
