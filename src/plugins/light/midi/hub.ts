/**
 * MIDI hub (docs/specs/midi.md, « Entrées MIDI »): one stream of normalised messages from every
 * source — local ports (IAC/USB via @julusian/midi), the built-in RTP-MIDI session, and Web MIDI
 * messages relayed by browsers.
 *
 * - Watched inputs are chosen by name (substring); ports are re-scanned every second (hot-plug) and
 *   a watched port that (re)appears is opened automatically.
 * - Local MIDI missing (no ALSA sequencer, no native module) is reported, never fatal.
 * - Feedback goes to a distinct output: a feedback port that is also a watched input is refused
 *   (QLC+ looped its feedback into its own input and its toggles flipped by themselves).
 * - The MIDI clock out (the light's tempo, timing/clock-out.ts) goes to its own output, refused on a
 *   watched input too: the tempo would follow its own clock.
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { parseMidi, type MidiMessage } from "./parse.js";
import { RtpMidiSession } from "./rtp/session.js";

export type MidiSource = "local" | "rtp" | "web";

export interface HubMessage {
  source: MidiSource;
  port: string;
  bytes: number[];
  msg: MidiMessage;
  ts: number;
}

export interface HubConfig {
  /** Name substrings of the inputs to watch (local ports). */
  inputs: string[];
  /** Local output port name substring for feedback, or "rtp". */
  feedbackOutput?: string;
  /** Local output port name substring for the MIDI clock out, or "rtp". */
  clockOutput?: string;
  rtp: { enabled: boolean; port: number; name: string };
}

interface NativeInput {
  getPortCount(): number;
  getPortName(i: number): string;
  openPort(i: number): void;
  closePort(): void;
  ignoreTypes(sysex: boolean, timing: boolean, activeSensing: boolean): void;
  on(event: "message", fn: (delta: number, message: number[]) => void): void;
}
interface NativeOutput {
  getPortCount(): number;
  getPortName(i: number): string;
  openPort(i: number): void;
  closePort(): void;
  sendMessage(bytes: number[]): void;
}
interface NativeMidi {
  Input: new () => NativeInput;
  Output: new () => NativeOutput;
}

function loadNative(): { midi?: NativeMidi; error?: string } {
  try {
    const midi = createRequire(import.meta.url)("@julusian/midi") as NativeMidi;
    new midi.Input().getPortCount(); // throws when the system MIDI layer is unavailable
    return { midi };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export interface PortStatus {
  name: string;
  watched: boolean;
  open: boolean;
  lastMessageAt?: number;
}

export class MidiHub extends EventEmitter {
  private native: NativeMidi | undefined;
  readonly localError: string | undefined;
  private readonly openInputs = new Map<string, NativeInput>();
  private feedbackPort: { name: string; out: NativeOutput } | undefined;
  private clockPort: { name: string; out: NativeOutput } | undefined;
  private knownInputs: string[] = [];
  private knownOutputs: string[] = [];
  private readonly activity = new Map<string, number>();
  private scanTimer: NodeJS.Timeout | undefined;
  private rtp: RtpMidiSession | undefined;
  /** Why the RTP-MIDI session could not open (port taken); the rest of MIDI keeps working. */
  private rtpError: string | undefined;

  constructor(
    private config: HubConfig,
    options: { native?: NativeMidi | null } = {},
  ) {
    super();
    if (options.native === null) {
      this.localError = "MIDI local désactivé";
    } else if (options.native) {
      this.native = options.native;
    } else {
      const loaded = loadNative();
      this.native = loaded.midi;
      this.localError = loaded.error;
    }
  }

  get localAvailable(): boolean {
    return this.native !== undefined;
  }

  async start(): Promise<void> {
    this.scan();
    this.scanTimer = setInterval(() => this.scan(), 1000);
    this.scanTimer.unref();
    await this.applyRtp();
  }

  stop(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    for (const input of this.openInputs.values()) input.closePort();
    this.openInputs.clear();
    this.feedbackPort?.out.closePort();
    this.feedbackPort = undefined;
    this.clockPort?.out.closePort();
    this.clockPort = undefined;
    this.rtp?.stop();
    this.rtp = undefined;
  }

  async setConfig(config: HubConfig): Promise<void> {
    const rtpChanged = JSON.stringify(config.rtp) !== JSON.stringify(this.config.rtp);
    this.config = config;
    for (const [name, input] of this.openInputs) {
      if (!this.isWatched(name)) {
        input.closePort();
        this.openInputs.delete(name);
      }
    }
    this.feedbackPort?.out.closePort();
    this.feedbackPort = undefined;
    this.clockPort?.out.closePort();
    this.clockPort = undefined;
    this.scan();
    if (rtpChanged) await this.applyRtp();
  }

  getConfig(): HubConfig {
    return this.config;
  }

  private async applyRtp(): Promise<void> {
    this.rtp?.stop();
    this.rtp = undefined;
    this.rtpError = undefined;
    if (!this.config.rtp.enabled) return;
    const session = new RtpMidiSession({ name: this.config.rtp.name, port: this.config.rtp.port });
    session.on("midi", (bytes: number[], ssrc: number) => {
      const peer = session.listPeers().find((p) => p.ssrc === ssrc);
      this.dispatch("rtp", `RTP · ${peer?.name ?? "session"}`, bytes);
    });
    session.on("peer", () => this.emit("ports"));
    session.on("peerLeft", () => this.emit("ports"));
    try {
      await session.start();
    } catch (err) {
      this.rtpError = `port ${this.config.rtp.port} : ${(err as Error).message}`;
      console.warn(`RTP-MIDI indisponible (${this.rtpError}). Sur un Mac, la session réseau de « Configuration audio et MIDI » occupe souvent le port 5004.`);
      return;
    }
    this.rtp = session;
  }

  private isWatched(name: string): boolean {
    return this.config.inputs.some((w) => name.toLowerCase().includes(w.toLowerCase()));
  }

  /** Re-lists ports, opens newly visible watched inputs, notifies on changes. */
  scan(): void {
    if (!this.native) return;
    let inputs: string[] = [];
    let outputs: string[] = [];
    try {
      const probeIn = new this.native.Input();
      inputs = Array.from({ length: probeIn.getPortCount() }, (_, i) => probeIn.getPortName(i));
      const probeOut = new this.native.Output();
      outputs = Array.from({ length: probeOut.getPortCount() }, (_, i) => probeOut.getPortName(i));
    } catch {
      return;
    }
    const changed = inputs.join("|") !== this.knownInputs.join("|") || outputs.join("|") !== this.knownOutputs.join("|");
    const appeared = inputs.filter((n) => !this.knownInputs.includes(n));
    this.knownInputs = inputs;
    this.knownOutputs = outputs;
    for (const [name, input] of this.openInputs) {
      if (!inputs.includes(name)) {
        input.closePort();
        this.openInputs.delete(name);
      }
    }
    inputs.forEach((name, index) => {
      if (!this.isWatched(name) || this.openInputs.has(name)) return;
      const input = new this.native!.Input();
      input.ignoreTypes(true, false, true);
      input.on("message", (_delta, bytes) => this.dispatch("local", name, bytes));
      input.openPort(index);
      this.openInputs.set(name, input);
    });
    if (!this.feedbackPort) this.feedbackPort = this.openOutput(outputs, this.config.feedbackOutput, "retour MIDI");
    if (!this.clockPort) this.clockPort = this.openOutput(outputs, this.config.clockOutput, "horloge MIDI");
    if (changed) this.emit("ports", { appeared });
  }

  /** An output by name substring, never one that is also a watched input (it would loop back). */
  private openOutput(outputs: string[], wanted: string | undefined, what: string): { name: string; out: NativeOutput } | undefined {
    if (!wanted || wanted === "rtp" || !this.native) return undefined;
    const index = outputs.findIndex((n) => n.toLowerCase().includes(wanted.toLowerCase()));
    if (index === -1) return undefined;
    const name = outputs[index]!;
    if (this.isWatched(name)) {
      this.emit("warning", `${what} refusé sur « ${name} » : c'est aussi une entrée surveillée (risque de boucle)`);
      return undefined;
    }
    const out = new this.native.Output();
    out.openPort(index);
    return { name, out };
  }

  /** Entry point for every source, including Web MIDI relayed by browsers. */
  dispatch(source: MidiSource, port: string, bytes: number[]): void {
    const ts = performance.now();
    this.activity.set(port, Date.now());
    this.emit("message", { source, port, bytes, msg: parseMidi(bytes), ts } satisfies HubMessage);
  }

  sendFeedback(messages: number[][]): void {
    if (messages.length === 0) return;
    if (this.config.feedbackOutput === "rtp") {
      this.rtp?.send(messages);
      return;
    }
    if (!this.feedbackPort) return;
    for (const m of messages) this.feedbackPort.out.sendMessage(m);
  }

  /** MIDI clock bytes (0xF8 clock, 0xFA start, 0xFC stop) to the clock output. */
  sendClock(bytes: number[]): void {
    if (this.config.clockOutput === "rtp") this.rtp?.send([bytes]);
    else this.clockPort?.out.sendMessage(bytes);
  }

  status(): { localAvailable: boolean; localError?: string; inputs: PortStatus[]; outputs: string[]; feedback?: string; clock?: string; rtp: { enabled: boolean; port: number; peers: string[]; error?: string } } {
    const inputs: PortStatus[] = this.knownInputs.map((name) => ({ name, watched: this.isWatched(name), open: this.openInputs.has(name), lastMessageAt: this.activity.get(name) }));
    for (const [name, at] of this.activity) {
      if (name.startsWith("Web MIDI")) inputs.push({ name, watched: true, open: true, lastMessageAt: at });
    }
    for (const peer of this.rtp?.listPeers() ?? []) {
      const name = `RTP · ${peer.name}`;
      inputs.push({ name, watched: true, open: true, lastMessageAt: this.activity.get(name) });
    }
    return {
      localAvailable: this.localAvailable,
      localError: this.localError,
      inputs,
      outputs: this.knownOutputs,
      feedback: this.feedbackPort?.name ?? (this.config.feedbackOutput === "rtp" ? "rtp" : undefined),
      clock: this.clockPort?.name ?? (this.config.clockOutput === "rtp" ? "rtp" : undefined),
      rtp: { enabled: this.config.rtp.enabled, port: this.config.rtp.port, peers: this.rtp?.listPeers().map((p) => `${p.name} (${p.address})`) ?? [], error: this.rtpError },
    };
  }
}
