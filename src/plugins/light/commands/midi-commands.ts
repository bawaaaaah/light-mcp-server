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
import { say } from "../../../core/lang.js";
import type { LoopDelayStats } from "../../../core/loop-delay.js";

export const MidiProfileSchema = z.object({
  inputs: z.array(z.string()).default([]),
  feedbackOutput: z.string().optional(),
  /** Where the MIDI clock out goes (the light's tempo, 24 per beat): an output name, or "rtp". */
  clockOutput: z.string().optional(),
  rtp: z
    .object({
      enabled: z.boolean().default(true),
      port: z.number().int().min(1024).max(65534).default(5004),
      name: z.string().default("light-mcp-server"),
      /** Bonjour: the session announced, and the others found (off in tests). */
      advertise: z.boolean().default(true),
      /** Sessions joined by name whenever they are on the network. */
      connect: z.array(z.string()).default([]),
    })
    .default({}),
});
export type MidiProfile = z.infer<typeof MidiProfileSchema>;

export interface MidiServices {
  /** The last MIDI messages and what each did. */
  journal: () => { at: number; port: string; msg: object; matched: { id: string; mode: string }[]; calls: { command: string; ok: boolean }[]; ms: number }[];
  /** How long Node keeps a message waiting (core/loop-delay.ts). */
  loopDelay: () => LoopDelayStats;
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
    description: "MIDI inputs detected and watched (with last activity), feedback port, RTP-MIDI sessions, active input profile and its settings (watched input patterns, feedback output), and how long Node keeps a message waiting (node: p50, p99 and max of the last 10 s, the worst stall of the last hour, in ms).",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "live"],
    schema: z.object({}),
    run: () => ({ ...s.hub.status(), profile: s.activeProfile(), profiles: Object.keys(s.profiles()), profileConfig: s.profiles()[s.activeProfile()], node: s.loopDelay() }),
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
    name: "midi.journal",
    title: "Journal MIDI",
    description:
      "The last MIDI messages received (clock excepted, 300 at most), newest first, and what each did: the mappings it matched (with their mode: a note off in latch matches and does nothing), each command and whether it worked, and how long it took (ms). To tell why a note « did not work ». port filters by input name, note by note number.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup", "live"],
    schema: z.object({ limit: z.number().int().min(1).max(300).default(50), port: z.string().optional(), note: z.number().int().min(0).max(127).optional() }),
    run: ({ limit, port, note }) =>
      s
        .journal()
        .filter((e) => (!port || e.port.toLowerCase().includes(port.toLowerCase())) && (note === undefined || (e.msg as { note?: number }).note === note))
        .slice(-limit)
        .reverse(),
  });

  /** Adds or removes a session from those the active profile keeps joining. */
  const keep = async (name: string, on: boolean) => {
    const active = s.activeProfile();
    const profile = MidiProfileSchema.parse(s.profiles()[active] ?? {});
    const connect = on ? [...new Set([...profile.rtp.connect, name])] : profile.rtp.connect.filter((n) => n !== name);
    await s.saveProfile(active, { ...profile, rtp: { ...profile.rtp, connect } });
  };

  reg.register({
    name: "midi.rtp.sessions",
    title: "Sessions RTP-MIDI du réseau",
    description:
      "The RTP-MIDI sessions announced on the network by Bonjour (another Mac's network session, an iPad, a console): name, host, address and port, whether the light is connected to it, whether it is kept (joined whenever seen), and this server's own session (self). Asks the network again first.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({}),
    run: async () => {
      s.hub.rtpLookAgain();
      await new Promise((r) => setTimeout(r, 800));
      return { sessions: s.hub.rtpSessions(), session: s.hub.status().rtp };
    },
  });

  reg.register({
    name: "midi.rtp.connect",
    title: "Rejoindre une session RTP-MIDI",
    description:
      "Joins an RTP-MIDI session: by its name as midi.rtp.sessions lists it, or by address and control port (a device Bonjour does not announce). Its messages then reach the mappings like any input (« RTP · <name> »). keep: joined again by itself whenever it is on the network, after a restart too.",
    right: "midi:configure",
    profiles: ["setup"],
    schema: z.object({ name: z.string().min(1).optional(), address: z.string().optional(), port: z.number().int().min(1).max(65535).optional(), keep: z.boolean().default(false) }),
    run: async ({ name, address, port, keep: kept }) => {
      if (!name && !(address && port)) throw new Error(say("donner le nom d'une session, ou son adresse et son port", "give a session's name, or its address and port"));
      const joined = await s.hub.rtpConnect(name ? { name } : { address: address!, port: port! }).catch((e: Error) => {
        throw new Error(say(`connexion RTP-MIDI impossible : ${e.message}`, `cannot join the RTP-MIDI session: ${e.message}`));
      });
      if (kept) await keep(name ?? joined.name, true);
      return { joined, kept };
    },
  });

  reg.register({
    name: "midi.rtp.keep",
    title: "Rejoindre toujours une session RTP-MIDI",
    description: "Whether the light joins an RTP-MIDI session (by its name) by itself whenever it is on the network, after a restart too; a session joined stays joined either way.",
    right: "midi:configure",
    profiles: ["setup"],
    schema: z.object({ name: z.string().min(1), keep: z.boolean() }),
    run: async ({ name, keep: on }) => {
      await keep(name, on);
      return { name, kept: on };
    },
  });

  reg.register({
    name: "midi.rtp.disconnect",
    title: "Quitter une session RTP-MIDI",
    description: "Leaves an RTP-MIDI session (by its name or address), and stops joining it by itself.",
    right: "midi:configure",
    profiles: ["setup"],
    schema: z.object({ name: z.string().min(1) }),
    run: async ({ name }) => {
      const left = s.hub.rtpDisconnect(name);
      await keep(name, false);
      return { left };
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
    description: "Creates or replaces a MIDI mapping: input (note/CC/PC, channel, number), mode (trigger « Déclencher », latch, momentary « Momentané », toggle), threshold (raw CC value under which the action does not answer, 0..127 for a CC, 0 by default = immediate), on/off commands, level argument for faders.",
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
          reject(new Error(say("aucun message MIDI reçu", "no MIDI message received")));
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
    description:
      "Sets a manual BPM, or selects the tempo source (manual, tap, midi = follow MIDI clock, os2l = follow DJ software, link = follow the Ableton Link session's tempo (listening only), audio = the tempo heard by a microphone in the interface, with beatAgoMs: how long ago one of its beats fell, to put the looks on the music's beats).",
    right: "commands:tempo",
    profiles: ["setup", "live"],
    schema: z.object({ bpm: z.number().min(20).max(400).optional(), source: z.enum(["manual", "tap", "midi", "audio", "os2l", "link"]).optional(), beatAgoMs: z.number().min(0).max(10_000).optional() }),
    run: ({ bpm, source, beatAgoMs }) => {
      if (source === "audio" && bpm !== undefined) s.tempo.follow(bpm, beatAgoMs);
      else {
        if (bpm !== undefined) s.tempo.setBpm(bpm);
        if (source) s.tempo.setSource(source);
      }
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
