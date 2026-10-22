/**
 * AbleSet (docs/specs/midi.md, « AbleSet ») : the setlist tool for Ableton Live tells, over OSC, which
 * song and which section play. The light follows: the section of the same name in the song of the
 * same title starts as AbleSet reaches it, while it plays.
 *
 * AbleSet's OSC API (ableset.com/docs/osc): it listens on UDP 39051; `/subscribe auto <port> <name>`
 * makes it send every value to that port as it changes (`/setlist/activeSongName`, `/setlist/
 * activeSectionName`, `/global/isPlaying`…) and a `/heartbeat` every 2 seconds; `/getValues` asks for
 * them all at once. Without a heartbeat for a while (AbleSet restarted, or started after us), the
 * subscription is sent again. The other way, `/setlist/jumpToSong <title>` and `/setlist/jumpToSection
 * <name>` move AbleSet from the light.
 */
import { createSocket, type Socket } from "node:dgram";
import { decodeOsc, encodeOsc, type OscArg } from "../osc/codec.js";

export interface AbleSetConfig {
  enabled: boolean;
  host: string;
  port: number;
}

/** What AbleSet says plays, and the section to start when that changes. Pure: messages in, decisions out. */
export class AbleSetFollower {
  song = "";
  section = "";
  playing = false;
  private started = "";

  /** A value from AbleSet; returns the song and section to start, when one is due. */
  receive(address: string, args: OscArg[]): { song: string; section: string } | undefined {
    const first = args[0];
    const text = typeof first === "string" ? first : "";
    const value = typeof first === "object" && first !== null ? first.value : typeof first === "number" ? first : first === true ? 1 : 0;
    if (address === "/setlist/activeSongName") this.song = text;
    else if (address === "/setlist/activeSectionName") this.section = text;
    else if (address === "/global/isPlaying") this.playing = value >= 0.5;
    else return undefined;
    if (!this.playing) {
      this.started = ""; // stopped: the next start plays the section it starts on, even the same one
      return undefined;
    }
    const key = `${this.song}\u0000${this.section}`;
    if (!this.song || !this.section || key === this.started) return undefined;
    this.started = key;
    return { song: this.song, section: this.section };
  }
}

const HEARTBEAT_LOST_MS = 6000;

export class AbleSetClient {
  readonly follower = new AbleSetFollower();
  private socket: Socket | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastHeartbeat = 0;
  /** The last section asked for, and whether the show has it. */
  lastMatch: { song: string; section: string; found: boolean } | undefined;

  constructor(
    private config: AbleSetConfig,
    private readonly onSection: (song: string, section: string) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  async start(): Promise<void> {
    if (!this.config.enabled || this.socket) return;
    const socket = createSocket("udp4");
    socket.on("error", () => undefined); // AbleSet absent: nothing to say beyond « not connected »
    socket.on("message", (buf) => {
      let messages;
      try {
        messages = decodeOsc(buf);
      } catch {
        return;
      }
      for (const m of messages) {
        if (m.address === "/heartbeat") this.lastHeartbeat = this.now();
        const due = this.follower.receive(m.address, m.args);
        if (due) this.lastMatch = { ...due, found: this.onSection(due.song, due.section) };
      }
    });
    await new Promise<void>((resolve) => socket.bind(0, resolve));
    this.socket = socket;
    this.subscribe();
    this.timer = setInterval(() => !this.connected && this.subscribe(), 3000);
    this.timer.unref();
  }

  private send(address: string, args: OscArg[] = []): void {
    this.socket?.send(encodeOsc({ address, args }), this.config.port, this.config.host);
  }

  private subscribe(): void {
    const port = (this.socket?.address() as { port: number } | undefined)?.port;
    if (!port) return;
    this.send("/subscribe", ["auto", { type: "i", value: port }, "light-mcp-server"]);
    this.send("/getValues");
  }

  /** Moves AbleSet to a song (by title), then to one of its sections (by name). */
  jump(song: string, section?: string): void {
    this.send("/setlist/jumpToSong", [song]);
    if (section) this.send("/setlist/jumpToSection", [section]);
  }

  get connected(): boolean {
    return this.now() - this.lastHeartbeat < HEARTBEAT_LOST_MS;
  }

  status(): { enabled: boolean; host: string; port: number; connected: boolean; song: string; section: string; playing: boolean; lastMatch?: AbleSetClient["lastMatch"] } {
    const f = this.follower;
    return { ...this.config, connected: this.connected, song: f.song, section: f.section, playing: f.playing, ...(this.lastMatch ? { lastMatch: this.lastMatch } : {}) };
  }

  async setConfig(config: AbleSetConfig): Promise<void> {
    await this.stop();
    this.config = config;
    await this.start();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.socket) this.send("/unsubscribe");
    const s = this.socket;
    this.socket = undefined;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}
