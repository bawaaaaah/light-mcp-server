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
 * - RTP-MIDI: the session takes the next free port when its own is held (on a Mac, the system's
 *   network session holds 5004), announces itself by Bonjour, finds the sessions of the network,
 *   and joins those it was told to keep joining whenever they are there.
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { parseMidi, type MidiMessage } from "./parse.js";
import { RtpMidiSession } from "./rtp/session.js";
import { advertise, browse, localHost, type FoundService } from "../../../core/mdns.js";

export type MidiSource = "local" | "rtp" | "web" | "os2l";

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
  /** advertise: Bonjour, to be found and to find the others (default on); connect: sessions joined by name whenever seen. */
  rtp: { enabled: boolean; port: number; name: string; advertise?: boolean; connect?: string[] };
}

interface NativeInput {
  getPortCount(): number;
  getPortName(i: number): string;
  openPort(i: number): void;
  closePort(): void;
  /** Frees the native object at once (else it waits for the garbage collector). */
  destroy?(): void;
  ignoreTypes(sysex: boolean, timing: boolean, activeSensing: boolean): void;
  on(event: "message", fn: (delta: number, message: number[]) => void): void;
}
interface NativeOutput {
  getPortCount(): number;
  getPortName(i: number): string;
  openPort(i: number): void;
  closePort(): void;
  destroy?(): void;
  sendMessage(bytes: number[]): void;
}
interface NativeMidi {
  /** getPortNames: the names, from a native object freed at once. */
  Input: (new () => NativeInput) & { getPortNames?: () => string[] };
  Output: (new () => NativeOutput) & { getPortNames?: () => string[] };
}

/** Closes a port and frees its native object at once. */
function release(port: NativeInput | NativeOutput | undefined): void {
  port?.closePort();
  port?.destroy?.();
}

function loadNative(): { midi?: NativeMidi; error?: string } {
  try {
    const midi = createRequire(import.meta.url)("@julusian/midi") as NativeMidi;
    release(new midi.Input()); // throws when the system MIDI layer is unavailable
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
  /** The port the session holds, when not its own. */
  private rtpPort: number | undefined;
  private bonjour: { stop: () => Promise<void> } | undefined;
  private browser: { ask: () => void; list: () => FoundService[]; stop: () => Promise<void> } | undefined;
  private joinTimer: NodeJS.Timeout | undefined;
  private readonly joining = new Set<string>();
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
    for (const input of this.openInputs.values()) release(input);
    this.openInputs.clear();
    release(this.feedbackPort?.out);
    this.feedbackPort = undefined;
    release(this.clockPort?.out);
    this.clockPort = undefined;
    void this.stopRtp();
  }

  private async stopRtp(): Promise<void> {
    if (this.joinTimer) clearInterval(this.joinTimer);
    this.joinTimer = undefined;
    this.rtp?.stop();
    this.rtp = undefined;
    this.rtpPort = undefined;
    const [bonjour, browser] = [this.bonjour, this.browser];
    this.bonjour = this.browser = undefined;
    await Promise.all([bonjour?.stop(), browser?.stop()]);
  }

  async setConfig(config: HubConfig): Promise<void> {
    // the sessions to keep joining change without a restart: the ones joined stay
    const session = (r: HubConfig["rtp"]) => JSON.stringify({ ...r, connect: undefined });
    const rtpChanged = session(config.rtp) !== session(this.config.rtp);
    this.config = config;
    for (const [name, input] of this.openInputs) {
      if (!this.isWatched(name)) {
        release(input);
        this.openInputs.delete(name);
      }
    }
    release(this.feedbackPort?.out);
    this.feedbackPort = undefined;
    release(this.clockPort?.out);
    this.clockPort = undefined;
    this.scan();
    if (rtpChanged) await this.applyRtp();
  }

  getConfig(): HubConfig {
    return this.config;
  }

  private async applyRtp(): Promise<void> {
    await this.stopRtp();
    this.rtpError = undefined;
    const { enabled, port: wanted, name } = this.config.rtp;
    if (!enabled) return;
    // its own port, else the next free pair: the control port and the next one, so by twos
    for (let port = wanted; port < wanted + 10; port += 2) {
      const session = new RtpMidiSession({ name, port });
      session.on("midi", (bytes: number[], ssrc: number) => {
        const peer = session.listPeers().find((p) => p.ssrc === ssrc);
        this.dispatch("rtp", `RTP · ${peer?.name ?? "session"}`, bytes);
      });
      session.on("peer", () => this.emit("ports"));
      session.on("peerLeft", () => this.emit("ports"));
      try {
        await session.start();
      } catch (err) {
        this.rtpError = `port ${port} : ${(err as Error).message}`;
        if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
        break;
      }
      this.rtp = session;
      this.rtpPort = port;
      this.rtpError = undefined;
      break;
    }
    if (!this.rtp) {
      console.warn(`RTP-MIDI indisponible (${this.rtpError}). Sur un Mac, la session réseau de « Configuration audio et MIDI » occupe souvent le port 5004.`);
      return;
    }
    if (this.config.rtp.advertise === false) return;
    this.bonjour = await advertise({ instance: name, type: "_apple-midi._udp", port: this.rtpPort!, ...localHost() });
    this.browser = await browse("_apple-midi._udp");
    this.joinTimer = setInterval(() => this.joinKept(), 5000);
    this.joinTimer.unref();
  }

  /** The RTP-MIDI sessions found on the network (Bonjour), and which are joined, kept, or this one. */
  rtpSessions(): { name: string; host: string; address: string; port: number; connected: boolean; kept: boolean; self: boolean; local: boolean }[] {
    const peers = this.rtp?.listPeers() ?? [];
    const mine = new Set(localHost().addresses);
    return (this.browser?.list() ?? []).map((s) => ({
      name: s.name,
      host: s.host,
      address: s.addresses[0]!,
      port: s.port,
      connected: peers.some((p) => s.addresses.includes(p.address) && p.controlPort === s.port),
      kept: this.config.rtp.connect?.includes(s.name) ?? false,
      self: s.port === this.rtpPort && s.addresses.some((a) => mine.has(a)),
      local: s.addresses.some((a) => mine.has(a)),
    }));
  }

  /** Asks the network again for its RTP-MIDI sessions (answers come within a second). */
  rtpLookAgain(): void {
    this.browser?.ask();
  }

  /** Joins a session: found by its name, or given by address and port. */
  async rtpConnect(target: { name: string } | { address: string; port: number }): Promise<{ name: string; address: string; port: number }> {
    if (!this.rtp) throw new Error(this.rtpError ?? "RTP-MIDI désactivé");
    const found = "name" in target ? this.rtpSessions().find((s) => s.name === target.name && !s.self) : undefined;
    if ("name" in target && !found) throw new Error(`session RTP-MIDI introuvable : ${target.name}`);
    const { address, port } = found ?? (target as { address: string; port: number });
    const peer = await this.rtp.invite(address, port);
    this.emit("ports");
    return { name: peer.name, address, port };
  }

  /** Leaves a session, by its name or its address. */
  rtpDisconnect(nameOrAddress: string): boolean {
    const peer = this.rtp?.listPeers().find((p) => p.name === nameOrAddress || p.address === nameOrAddress);
    if (!peer) return false;
    this.rtp!.bye(peer.ssrc);
    return true;
  }

  /** The sessions to keep joining, when seen and not joined yet. */
  private joinKept(): void {
    for (const s of this.rtpSessions()) {
      if (!s.kept || s.connected || s.self || this.joining.has(s.name)) continue;
      this.joining.add(s.name);
      void this.rtpConnect({ name: s.name })
        .catch(() => undefined)
        .finally(() => this.joining.delete(s.name));
    }
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
      inputs = this.portNames(this.native.Input);
      outputs = this.portNames(this.native.Output);
    } catch {
      return;
    }
    const changed = inputs.join("|") !== this.knownInputs.join("|") || outputs.join("|") !== this.knownOutputs.join("|");
    const appeared = inputs.filter((n) => !this.knownInputs.includes(n));
    this.knownInputs = inputs;
    this.knownOutputs = outputs;
    for (const [name, input] of this.openInputs) {
      if (!inputs.includes(name)) {
        release(input);
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

  /**
   * The names of the ports, read every second for hot-plug: never by a native object left to the
   * garbage collector, which on a Mac kept a CoreMIDI client alive per second until collected.
   */
  private portNames(kind: { new (): NativeInput | NativeOutput; getPortNames?: () => string[] }): string[] {
    if (kind.getPortNames) return kind.getPortNames();
    const probe = new kind();
    try {
      return Array.from({ length: probe.getPortCount() }, (_, i) => probe.getPortName(i));
    } finally {
      probe.destroy?.();
    }
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
    try {
      for (const m of messages) this.feedbackPort.out.sendMessage(m);
    } catch (err) {
      this.feedbackPort = undefined; // a controller unplugged: reopened by the next scan when it is back
      this.emit("warning", `retour MIDI : ${(err as Error).message}`);
    }
  }

  /** MIDI clock bytes (0xF8 clock, 0xFA start, 0xFC stop) to the clock output. */
  sendClock(bytes: number[]): void {
    try {
      if (this.config.clockOutput === "rtp") this.rtp?.send([bytes]);
      else this.clockPort?.out.sendMessage(bytes);
    } catch (err) {
      // a port gone (a USB interface unplugged): drop it, the next scan opens it again when it is back;
      // a timer that throws would stop the whole server
      this.clockPort = undefined;
      this.emit("warning", `horloge MIDI : ${(err as Error).message}`);
    }
  }

  status(): { localAvailable: boolean; localError?: string; inputs: PortStatus[]; outputs: string[]; feedback?: string; clock?: string; rtp: { enabled: boolean; port: number; wanted?: number; peers: string[]; error?: string } } {
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
      rtp: { enabled: this.config.rtp.enabled, port: this.rtpPort ?? this.config.rtp.port, ...(this.rtpPort !== undefined && this.rtpPort !== this.config.rtp.port ? { wanted: this.config.rtp.port } : {}), peers: this.rtp?.listPeers().map((p) => `${p.name} (${p.address})`) ?? [], error: this.rtpError },
    };
  }
}
