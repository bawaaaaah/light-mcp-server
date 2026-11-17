/**
 * MIDI in the light plugin (docs/specs/midi.md): the hub and its ports, the show's mappings turned into commands,
 * the journal of what each message did, and the feedback that keeps the controllers' LEDs on the real state.
 */
import { MidiProfileSchema, PortLossSchema, registerMidiCommands, type MidiProfile } from "../commands/midi-commands.js";
import type { CommandRegistry } from "../commands/registry.js";
import type { DmxEngine } from "../engine/dmx-engine.js";
import { MidiHub, type HubMessage, type MidiSource } from "../midi/hub.js";
import { argText, MappingSchema, type Mapping, type MappingOutput, type MidiMapper } from "../midi/mapping.js";
import type { MidiMessage } from "../midi/parse.js";
import type { OutputRouter } from "../output/output-router.js";
import type { ShowRuntime } from "../show/runtime.js";
import { ClockOut } from "../timing/clock-out.js";
import type { TempoClock } from "../timing/tempo.js";
import type { Collection, FolderStore } from "../data/store.js";
import type { LoopDelay } from "../../../core/loop-delay.js";
import { say } from "../../../core/lang.js";
import type { ConfigSection, LightConfig } from "../light-config.js";
import { frozenFor } from "../show/motion-summary.js";

const MIDI_JOURNAL_SIZE = 300;

export interface MidiJournalEntry {
  at: number;
  port: string;
  source: string;
  msg: MidiMessage;
  /** The mappings it matched (a note off in latch matches and does nothing). */
  matched: { id: string; label: string; mode: string }[];
  calls: { command: string; target: string; ok: boolean; error?: string }[];
  /** From its arrival in the handler to its commands done, in ms. */
  ms: number;
}

/** The ports of the active MIDI profile, as the hub takes them. */
export function activeMidiProfile(midi: LightConfig["midi"]): { inputs: string[]; feedbackOutput?: string; clockOutput?: string; rtp: MidiProfile["rtp"] } {
  const p = midi.profiles[midi.active] ?? MidiProfileSchema.parse({});
  return { inputs: p.inputs, feedbackOutput: p.feedbackOutput, clockOutput: p.clockOutput, rtp: p.rtp };
}

export interface MidiWiringDeps {
  commands: CommandRegistry;
  engine: DmxEngine;
  router: OutputRouter;
  runtime: ShowRuntime;
  show: FolderStore;
  mapper: MidiMapper;
  tempo: TempoClock;
  loopDelay: LoopDelay;
  /** The MIDI profiles and the active one. */
  config: ConfigSection<"midi">;
  /** Test seam: no native MIDI. */
  midiNative?: null;
  publish: (type: string, payload: unknown) => void;
  /** The plugin's state, published when a Program Change selects a rule program. */
  state: () => unknown;
}

/**
 * Opens the show's mappings and the hub, listens to it and registers the midi.* commands (in this order: the
 * mappings are loaded before the first message can come).
 */
export class MidiWiring {
  readonly hub: MidiHub;
  readonly mappings: Collection<Mapping>;
  /** The last MIDI messages and what each did (midi.journal, the MIDI page's monitor). */
  private readonly journal: MidiJournalEntry[] = [];
  /** The light's tempo as MIDI clock, to the profile's clock output (none set: nothing is sent). */
  private readonly clockOut = new ClockOut(() => this.deps.tempo.state(), (bytes) => this.hub.sendClock(bytes));
  private clockTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: MidiWiringDeps) {
    const { commands, show, mapper, config, publish } = deps;
    const mappings = show.collection("mappings", MappingSchema);
    this.mappings = mappings;
    mapper.setMappings(mappings.list());
    const hub = new MidiHub(activeMidiProfile(config.get()), deps.midiNative === null ? { native: null } : {});
    this.hub = hub;
    hub.on("message", (m: HubMessage) => this.onMessage(m));
    hub.on("ports", () => publish("midi", { status: hub.status() }));
    hub.on("warning", (w: string) => publish("midi", { warning: w }));
    // a port gone: the wheels it had pushed are forgotten, what they held released unless kept for that kind of input
    // (docs/specs/midi.md, « Pitch bend »); a release made outside a message runs as a message's would
    mapper.onRelease = (out) => this.run(out, "midi");
    hub.on("inputClosed", (port: string, source: MidiSource) => mapper.forgetPort(port, this.portLoss()[source === "rtp" ? "rtp" : source === "web" ? "web" : "local"] === "release"));
    registerMidiCommands(commands, {
      journal: () => this.journal,
      loopDelay: () => deps.loopDelay.stats(),
      hub,
      mapper,
      mappings,
      tempo: deps.tempo,
      profiles: () => config.get().profiles,
      activeProfile: () => config.get().active,
      selectProfile: async (name) => {
        const midi = config.get();
        if (!midi.profiles[name]) throw new Error(say(`profil inconnu : ${name}`, `unknown profile: ${name}`));
        config.put({ ...midi, active: name });
        mapper.forgetPort(undefined, true); // another profile: every port's wheels released and forgotten
        await hub.setConfig(activeMidiProfile(config.get()));
        await config.save();
      },
      saveProfile: async (name, profile) => {
        const midi = config.get();
        config.put({ ...midi, profiles: { ...midi.profiles, [name]: profile } });
        if (name === config.get().active) {
          mapper.forgetPort(undefined, true);
          await hub.setConfig(activeMidiProfile(config.get()));
        }
        await config.save();
      },
      portLoss: () => this.portLoss(),
      setPortLoss: async (portLoss) => {
        config.put({ ...config.get(), portLoss });
        await config.save();
      },
    });
  }

  /** What a wheel holding an action does when its input goes (a config written before the setting: release). */
  private portLoss() {
    return PortLossSchema.parse(this.deps.config.get().portLoss ?? {});
  }

  /** Every millisecond: a clock every ~21 ms at 120 BPM, measured within ±1 ms of its time. */
  startClock(): void {
    this.clockTimer = setInterval(() => activeMidiProfile(this.deps.config.get()).clockOutput && this.clockOut.tick(), 1);
    this.clockTimer.unref();
  }

  stopClock(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
  }

  /** Sends MIDI feedback for state changes (all of it with `full`); silent on standby, where QLC+ holds the controllers. */
  syncFeedback(full = false): void {
    const { router, mapper, runtime } = this.deps;
    if (router.isStandby()) return;
    const out: number[][] = [];
    for (const m of mapper.list()) {
      const target = argText(m.on.args.id);
      if (m.on.command === "look.go") out.push(...mapper.syncState(m.id, runtime.isActive(target)));
      else if (m.on.command === "motion.freeze") out.push(...mapper.syncState(m.id, frozenFor(runtime, m.on.args)));
      else if (m.on.command === "group.level") {
        const g = runtime.groups.get(target);
        if (g?.master) out.push(...mapper.syncState(m.id, !g.master.mute && g.master.level > 0, g.master.level));
      }
    }
    this.hub.sendFeedback(full ? mapper.allFeedback() : out);
  }

  /** A mapping output played: its feedback to the controller's LEDs (not the DJ's), its calls run; their outcomes. */
  private run(out: MappingOutput, origin: "midi" | "os2l"): Promise<{ command: string; target: string; ok: boolean; error?: string }>[] {
    const { commands, router, publish } = this.deps;
    if (!router.isStandby() && origin !== "os2l") this.hub.sendFeedback(out.feedback);
    return out.calls.map((call) => {
      const target = argText(call.args.id ?? call.args.section);
      return commands.invoke(call.command, call.args, { origin, can: () => true }).then(
        () => ({ command: call.command, target, ok: true }),
        (err: Error) => {
          publish("midi", { error: `${call.command} : ${err.message}` });
          return { command: call.command, target, ok: false, error: err.message };
        },
      );
    });
  }

  /**
   * Every MIDI message: tempo follows the clock; mappings turn the rest into commands. What each
   * message did (the mappings it matched, each command and whether it worked, how long it took)
   * goes to the monitor and the journal: a note that « did not work » shows why.
   */
  private onMessage(m: HubMessage): void {
    const { engine, runtime, mapper, tempo, publish } = this.deps;
    const started = performance.now();
    tempo.handleMidi(m.msg);
    const t = m.msg.type;
    // a transport restart on this port rearms its wheels (mapper.handle answers it with nothing to do); the tempo is above
    if (t === "start" || t === "continue" || t === "songposition") mapper.handle(m.msg, m.port);
    if (t === "clock" || t === "start" || t === "stop" || t === "continue" || t === "songposition") return;
    // A Program Change selects the rule program carrying that number on that channel (no mapping needed).
    if (m.msg.type === "programchange") {
      const program = runtime.programFor(m.msg.channel, m.msg.program);
      if (program && runtime.selectProgram(program.id)) {
        engine.requestFrame();
        publish("state", this.deps.state());
      }
    }
    const out = mapper.handle(m.msg, m.port);
    const calls = this.run(out, m.source === "os2l" ? "os2l" : "midi");
    // in the journal at once, in the order of arrival; its commands' outcome filled in when done
    const entry: MidiJournalEntry = { at: Date.now(), port: m.port, source: m.source, msg: m.msg, matched: out.matched, calls: [], ms: 0 };
    this.journal.push(entry);
    if (this.journal.length > MIDI_JOURNAL_SIZE) this.journal.shift();
    void Promise.all(calls).then((done) => {
      entry.calls = done;
      entry.ms = Math.round((performance.now() - started) * 100) / 100;
      publish("midi", { monitor: entry });
    });
  }
}
