/**
 * Ableton Link, listening only (docs/specs/midi.md, « Ableton Link ») : Live, VirtualDJ and other
 * Link apps on the network share a session tempo, announced by each peer over UDP multicast
 * (224.76.78.75:20808). The light reads it and follows the tempo of the session with the most peers;
 * it never joins the session (nothing is sent), so it can neither move the others' tempo nor their
 * phase. The phase is not read either: it needs Link's time measurement between peers.
 *
 * Discovery message (Link's open source, discovery/v1): « _asdp_v » and version 1, then the type
 * (1 alive, 2 response, 3 bye), a time to live in seconds, a group id (2 bytes) and the node id
 * (8 bytes); then entries, each a four-letter key, a size and its bytes, big-endian:
 * `tmln` the timeline (microseconds per beat, beat origin, time origin: three int64), `sess` the
 * session id (8 bytes). The codec is pure; to be checked against a real Live on the stage Mac.
 */
import { createSocket, type Socket } from "node:dgram";

const GROUP = "224.76.78.75";
const PORT = 20808;
const HEADER = Buffer.from([0x5f, 0x61, 0x73, 0x64, 0x70, 0x5f, 0x76, 0x01]); // « _asdp_v » v1
const ALIVE = 1;
const RESPONSE = 2;
const BYEBYE = 3;
const key = (s: string) => s.split("").reduce((k, c) => (k << 8) | c.charCodeAt(0), 0) >>> 0;
const TMLN = key("tmln");
const SESS = key("sess");

export interface LinkMessage {
  type: number;
  ttl: number;
  node: string;
  session?: string;
  /** From the timeline: microseconds per beat. */
  bpm?: number;
}

export function decodeLink(buf: Buffer): LinkMessage | undefined {
  if (buf.length < 20 || !buf.subarray(0, 8).equals(HEADER)) return undefined;
  const msg: LinkMessage = { type: buf[8]!, ttl: buf[9]!, node: buf.subarray(12, 20).toString("hex") };
  for (let at = 20; at + 8 <= buf.length; ) {
    const k = buf.readUInt32BE(at);
    const size = buf.readUInt32BE(at + 4);
    const value = buf.subarray(at + 8, at + 8 + size);
    if (value.length < size) break;
    if (k === TMLN && size >= 8) {
      const micros = Number(value.readBigInt64BE(0));
      if (micros > 0) msg.bpm = Math.round((60e6 / micros) * 100) / 100;
    } else if (k === SESS && size >= 8) msg.session = value.subarray(0, 8).toString("hex");
    at += 8 + size;
  }
  return msg;
}

/** A peer's announcement, as Link sends it (for tests). */
export function encodeLinkAlive(o: { node: string; session: string; bpm: number; ttl?: number; type?: number }): Buffer {
  const entry = (name: string, value: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(key(name), 0);
    head.writeUInt32BE(value.length, 4);
    return Buffer.concat([head, value]);
  };
  const tmln = Buffer.alloc(24);
  tmln.writeBigInt64BE(BigInt(Math.round(60e6 / o.bpm)), 0);
  return Buffer.concat([HEADER, Buffer.from([o.type ?? ALIVE, o.ttl ?? 5, 0, 0]), Buffer.from(o.node, "hex"), entry("tmln", tmln), entry("sess", Buffer.from(o.session, "hex"))]);
}

/** Peers and their sessions; the tempo of the session with the most peers. Pure, the time given. */
export class LinkPeers {
  private readonly peers = new Map<string, { session: string; bpm: number; until: number }>();

  receive(m: LinkMessage, nowMs: number): void {
    if (m.type === BYEBYE) {
      this.peers.delete(m.node);
      return;
    }
    if ((m.type !== ALIVE && m.type !== RESPONSE) || m.bpm === undefined || !m.session) return;
    this.peers.set(m.node, { session: m.session, bpm: m.bpm, until: nowMs + Math.max(1, m.ttl) * 1000 });
  }

  /** The session most peers are in, and its tempo (its newest announcement). */
  state(nowMs: number): { peers: number; sessions: number; bpm?: number } {
    for (const [node, p] of this.peers) if (p.until < nowMs) this.peers.delete(node);
    const sessions = new Map<string, { count: number; bpm: number; until: number }>();
    for (const p of this.peers.values()) {
      const s = sessions.get(p.session) ?? { count: 0, bpm: p.bpm, until: 0 };
      s.count++;
      if (p.until >= s.until) Object.assign(s, { bpm: p.bpm, until: p.until });
      sessions.set(p.session, s);
    }
    const best = [...sessions.values()].sort((a, b) => b.count - a.count)[0];
    return { peers: this.peers.size, sessions: sessions.size, ...(best ? { bpm: best.bpm } : {}) };
  }
}

/** Listens to the Link peers of the network while started; `onTempo` gets the session's tempo as it changes. */
export class LinkListener {
  readonly peers = new LinkPeers();
  private socket: Socket | undefined;
  private last: number | undefined;

  constructor(
    private readonly onTempo: (bpm: number) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get listening(): boolean {
    return this.socket !== undefined;
  }

  async start(): Promise<void> {
    if (this.socket) return;
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    socket.on("error", () => undefined);
    socket.on("message", (buf) => this.handle(buf));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(PORT, () => resolve());
      });
      socket.addMembership(GROUP);
      this.socket = socket;
    } catch {
      socket.close(); // no multicast here: the status says « no peer »
    }
  }

  handle(buf: Buffer): void {
    const m = decodeLink(buf);
    if (!m) return;
    this.peers.receive(m, this.now());
    const { bpm } = this.peers.state(this.now());
    if (bpm !== undefined && bpm !== this.last && bpm >= 20 && bpm <= 400) {
      this.last = bpm;
      this.onTempo(bpm);
    }
  }

  status(): { listening: boolean; peers: number; sessions: number; bpm?: number } {
    return { listening: this.listening, ...this.peers.state(this.now()) };
  }

  async stop(): Promise<void> {
    const s = this.socket;
    this.socket = undefined;
    this.last = undefined;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}
