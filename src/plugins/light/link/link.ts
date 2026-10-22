/**
 * Ableton Link, listening only (docs/specs/midi.md, « Ableton Link ») : Live, VirtualDJ and other
 * Link apps on the network share a session tempo, announced by each peer over UDP multicast
 * (224.76.78.75:20808). The light reads it and follows the tempo of the session with the most peers;
 * it never joins the session, so it can neither move the others' tempo nor their phase.
 *
 * Discovery message (Link's open source, discovery/v1): « _asdp_v » and version 1, then the type
 * (1 alive, 2 response, 3 bye), a time to live in seconds, a group id (2 bytes) and the node id
 * (8 bytes); then entries, each a four-letter key, a size and its bytes, big-endian:
 * `tmln` the timeline (microseconds per beat, beat origin in micro-beats, time origin in
 * microseconds: three int64), `sess` the session id (8 bytes), `mep4` where the peer answers
 * measurements (IPv4 address, port).
 *
 * The phase: the timeline counts the session's beats against the session's own time (Link's « ghost
 * time »). To place them on our clock, the light measures that time as Link does before joining
 * (Measurement.hpp): pings to one peer of the session (« _link_v » version 1, type 1, our time `__ht`
 * and the last session time heard `_pgt`), which any peer answers (type 2, its session `sess` and
 * session time `__gt`, then the ping's own entries); each answer gives the offset between the two
 * clocks, the way there and back taking as long, and the median of a hundred is kept. Pinging asks
 * nothing of the peer but that answer. The codecs and the measurement are pure; to be checked
 * against a real Live on the stage Mac.
 */
import { createSocket, type Socket } from "node:dgram";

const GROUP = "224.76.78.75";
const PORT = 20808;
const HEADER = Buffer.from([0x5f, 0x61, 0x73, 0x64, 0x70, 0x5f, 0x76, 0x01]); // « _asdp_v » v1
const MEASURE = Buffer.from([0x5f, 0x6c, 0x69, 0x6e, 0x6b, 0x5f, 0x76, 0x01]); // « _link_v » v1
const ALIVE = 1;
const RESPONSE = 2;
const BYEBYE = 3;
const PING = 1;
const PONG = 2;
const key = (s: string) => s.split("").reduce((k, c) => (k << 8) | c.charCodeAt(0), 0) >>> 0;
const TMLN = key("tmln");
const SESS = key("sess");
const MEP4 = key("mep4");
const HOST_TIME = key("__ht");
const GHOST_TIME = key("__gt");
const PREV_GHOST_TIME = key("_pgt");

/** The session's beats: `beatOrigin` falls at `timeOrigin` (session time, µs), then one beat every `microsPerBeat`. */
export interface LinkTimeline {
  microsPerBeat: number;
  beatOrigin: number;
  timeOrigin: number;
}

export interface LinkMessage {
  type: number;
  ttl: number;
  node: string;
  session?: string;
  /** From the timeline: microseconds per beat. */
  bpm?: number;
  timeline?: LinkTimeline;
  /** Where the peer answers measurement pings. */
  endpoint?: { address: string; port: number };
}

/** The entries following a header, by key. */
function readEntries(buf: Buffer, at: number): Map<number, Buffer> {
  const entries = new Map<number, Buffer>();
  while (at + 8 <= buf.length) {
    const size = buf.readUInt32BE(at + 4);
    const value = buf.subarray(at + 8, at + 8 + size);
    if (value.length < size) break;
    entries.set(buf.readUInt32BE(at), value);
    at += 8 + size;
  }
  return entries;
}

function entry(name: string, value: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(key(name), 0);
  head.writeUInt32BE(value.length, 4);
  return Buffer.concat([head, value]);
}

function int64(...values: number[]): Buffer {
  const b = Buffer.alloc(8 * values.length);
  values.forEach((v, i) => b.writeBigInt64BE(BigInt(Math.round(v)), 8 * i));
  return b;
}

export function decodeLink(buf: Buffer): LinkMessage | undefined {
  if (buf.length < 20 || !buf.subarray(0, 8).equals(HEADER)) return undefined;
  const msg: LinkMessage = { type: buf[8]!, ttl: buf[9]!, node: buf.subarray(12, 20).toString("hex") };
  const entries = readEntries(buf, 20);
  const tmln = entries.get(TMLN);
  if (tmln && tmln.length >= 8) {
    const micros = Number(tmln.readBigInt64BE(0));
    if (micros > 0) {
      msg.bpm = Math.round((60e6 / micros) * 100) / 100;
      if (tmln.length >= 24) msg.timeline = { microsPerBeat: micros, beatOrigin: Number(tmln.readBigInt64BE(8)) / 1e6, timeOrigin: Number(tmln.readBigInt64BE(16)) };
    }
  }
  const sess = entries.get(SESS);
  if (sess && sess.length >= 8) msg.session = sess.subarray(0, 8).toString("hex");
  const mep4 = entries.get(MEP4);
  if (mep4 && mep4.length >= 6) msg.endpoint = { address: [...mep4.subarray(0, 4)].join("."), port: mep4.readUInt16BE(4) };
  return msg;
}

/** A peer's announcement, as Link sends it (for tests). */
export function encodeLinkAlive(o: { node: string; session: string; bpm: number; beatOrigin?: number; timeOrigin?: number; endpoint?: { address: string; port: number }; ttl?: number; type?: number }): Buffer {
  const parts = [HEADER, Buffer.from([o.type ?? ALIVE, o.ttl ?? 5, 0, 0]), Buffer.from(o.node, "hex"), entry("tmln", int64(60e6 / o.bpm, (o.beatOrigin ?? 0) * 1e6, o.timeOrigin ?? 0)), entry("sess", Buffer.from(o.session, "hex"))];
  if (o.endpoint) {
    const mep = Buffer.alloc(6);
    o.endpoint.address.split(".").forEach((n, i) => mep.writeUInt8(Number(n), i));
    mep.writeUInt16BE(o.endpoint.port, 4);
    parts.push(entry("mep4", mep));
  }
  return Buffer.concat(parts);
}

/** A measurement ping: our time, and the session time the last answer gave. */
export function encodePing(hostMicros: number, prevGhostMicros?: number): Buffer {
  const parts = [MEASURE, Buffer.from([PING]), entry("__ht", int64(hostMicros))];
  if (prevGhostMicros !== undefined) parts.push(entry("_pgt", int64(prevGhostMicros)));
  return Buffer.concat(parts);
}

export interface LinkPong {
  session: string;
  /** The peer's session time when it answered. */
  ghost: number;
  /** Echoed from the ping. */
  host?: number;
  prevGhost?: number;
}

export function decodePong(buf: Buffer): LinkPong | undefined {
  if (buf.length < 9 || !buf.subarray(0, 8).equals(MEASURE) || buf[8] !== PONG) return undefined;
  const entries = readEntries(buf, 9);
  const sess = entries.get(SESS);
  const gt = entries.get(GHOST_TIME);
  if (!sess || sess.length < 8 || !gt || gt.length < 8) return undefined;
  const time = (k: number) => {
    const v = entries.get(k);
    return v && v.length >= 8 ? Number(v.readBigInt64BE(0)) : undefined;
  };
  const pong: LinkPong = { session: sess.subarray(0, 8).toString("hex"), ghost: Number(gt.readBigInt64BE(0)) };
  const host = time(HOST_TIME);
  const prevGhost = time(PREV_GHOST_TIME);
  if (host !== undefined) pong.host = host;
  if (prevGhost !== undefined) pong.prevGhost = prevGhost;
  return pong;
}

/** What a peer answers to a ping (PingResponder.hpp; for tests). */
export function encodePong(session: string, ghostMicros: number, ping: Buffer): Buffer {
  return Buffer.concat([MEASURE, Buffer.from([PONG]), entry("sess", Buffer.from(session, "hex")), entry("__gt", int64(ghostMicros)), ping.subarray(9)]);
}

const DATA_POINTS = 100;

/** The offset from our clock to the session's, from a peer's answers (Measurement.hpp). Pure. */
export class GhostMeasure {
  private readonly data: number[] = [];

  constructor(readonly session: string) {}

  /** An answer received at `hostMicros`; the next ping to send, or undefined once measured (or not this session's). */
  answer(p: LinkPong, hostMicros: number): Buffer | undefined {
    if (p.session !== this.session) return undefined;
    if (p.ghost !== 0 && p.host) {
      this.data.push(p.ghost - (hostMicros + p.host) / 2);
      if (p.prevGhost) this.data.push((p.ghost + p.prevGhost) / 2 - p.host);
    }
    return this.done ? undefined : encodePing(hostMicros, p.ghost);
  }

  get done(): boolean {
    return this.data.length > DATA_POINTS;
  }

  /** Session time minus our time, in µs: the median of the measures. */
  offset(): number | undefined {
    if (!this.data.length) return undefined;
    const s = [...this.data].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  }
}

/** How long ago the session's last beat fell, at our time `hostMicros`, given the offset to the session's time. */
export function beatAgoMs(t: LinkTimeline, offsetMicros: number, hostMicros: number): number {
  const beats = t.beatOrigin + (hostMicros + offsetMicros - t.timeOrigin) / t.microsPerBeat;
  return ((beats - Math.floor(beats)) * t.microsPerBeat) / 1000;
}

interface Peer {
  session: string;
  bpm: number;
  timeline?: LinkTimeline;
  endpoint?: { address: string; port: number };
  until: number;
}

/** Peers and their sessions; the tempo of the session with the most peers. Pure, the time given. */
export class LinkPeers {
  private readonly peers = new Map<string, Peer>();

  receive(m: LinkMessage, nowMs: number): void {
    if (m.type === BYEBYE) {
      this.peers.delete(m.node);
      return;
    }
    if ((m.type !== ALIVE && m.type !== RESPONSE) || m.bpm === undefined || !m.session) return;
    this.peers.set(m.node, { session: m.session, bpm: m.bpm, ...(m.timeline ? { timeline: m.timeline } : {}), ...(m.endpoint ? { endpoint: m.endpoint } : {}), until: nowMs + Math.max(1, m.ttl) * 1000 });
  }

  /** The session most peers are in: its newest announcement, and a peer of it to measure. */
  leading(nowMs: number): (Peer & { count: number }) | undefined {
    for (const [node, p] of this.peers) if (p.until < nowMs) this.peers.delete(node);
    const sessions = new Map<string, Peer & { count: number }>();
    for (const p of this.peers.values()) {
      const s = sessions.get(p.session);
      if (!s) sessions.set(p.session, { ...p, count: 1 });
      else {
        s.count++;
        if (p.until >= s.until) Object.assign(s, { bpm: p.bpm, timeline: p.timeline, until: p.until });
        s.endpoint ??= p.endpoint;
      }
    }
    return [...sessions.values()].sort((a, b) => b.count - a.count)[0];
  }

  state(nowMs: number): { peers: number; sessions: number; bpm?: number } {
    const best = this.leading(nowMs);
    return { peers: this.peers.size, sessions: new Set([...this.peers.values()].map((p) => p.session)).size, ...(best ? { bpm: best.bpm } : {}) };
  }
}

const PING_WAIT_MS = 50;
const PING_TRIES = 5;
/** The two clocks drift apart slowly: measured again now and then. */
const REMEASURE_MS = 30_000;
/** A peer that did not answer is asked again, not flooded. */
const RETRY_MS = 10_000;
/** The light's count is put back on the session's beats this often (its tempo is rounded). */
const RESYNC_MS = 2000;

/**
 * Listens to the Link peers of the network while started; `onTempo` gets the session's tempo as it
 * changes, and once the session time is measured, how long ago its last beat fell.
 */
export class LinkListener {
  readonly peers = new LinkPeers();
  private socket: Socket | undefined;
  private pinger: Socket | undefined;
  private last: string | undefined;
  private synced: number | undefined;
  private clock: { session: string; offset: number; atMs: number } | undefined;
  private measuring: { measure: GhostMeasure; timer?: NodeJS.Timeout; tries: number; to: { address: string; port: number } } | undefined;
  private lastAttempt: { session: string; atMs: number } | undefined;

  constructor(
    private readonly onTempo: (bpm: number, beatAgoMs?: number) => void,
    private readonly now: () => number = Date.now,
    private readonly micros: () => number = () => Number(process.hrtime.bigint() / 1000n),
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
      return;
    }
    const pinger = createSocket("udp4");
    pinger.on("error", () => undefined);
    pinger.on("message", (buf, from) => this.pong(buf, from));
    await new Promise<void>((resolve) => pinger.bind(0, resolve));
    this.pinger = pinger;
  }

  handle(buf: Buffer): void {
    const m = decodeLink(buf);
    if (!m) return;
    this.peers.receive(m, this.now());
    this.update();
  }

  /** Measures the leading session's time when due, and tells its tempo (and phase, once known). */
  private update(): void {
    const s = this.peers.leading(this.now());
    if (!s || s.bpm < 20 || s.bpm > 400) return;
    if (s.endpoint && !this.measuring && this.pinger && this.due(s.session)) this.measure(s.session, s.endpoint);
    const phase = s.timeline && this.clock?.session === s.session ? beatAgoMs(s.timeline, this.clock.offset, this.micros()) : undefined;
    const t = s.timeline;
    const tl = t ? `${s.bpm}/${t.beatOrigin}/${t.timeOrigin}` : String(s.bpm);
    const resync = phase !== undefined && (this.synced === undefined || this.now() - this.synced >= RESYNC_MS);
    if (tl === this.last && !resync) return;
    this.last = tl;
    if (phase !== undefined) this.synced = this.now();
    this.onTempo(s.bpm, phase);
  }

  private due(session: string): boolean {
    const t = this.now();
    if (this.lastAttempt?.session === session && t - this.lastAttempt.atMs < RETRY_MS) return false;
    return this.clock?.session !== session || t - this.clock.atMs >= REMEASURE_MS;
  }

  private measure(session: string, to: { address: string; port: number }): void {
    this.lastAttempt = { session, atMs: this.now() };
    this.measuring = { measure: new GhostMeasure(session), tries: 0, to };
    this.ping(encodePing(this.micros()), to);
  }

  private ping(buf: Buffer, to: { address: string; port: number }): void {
    const m = this.measuring;
    if (!m) return;
    this.pinger?.send(buf, to.port, to.address);
    if (m.timer) clearTimeout(m.timer);
    m.timer = setTimeout(() => {
      // no answer: a fresh ping, a few times, then give up until the next measure is due
      if (++m.tries < PING_TRIES) this.ping(encodePing(this.micros()), m.to);
      else this.measured(undefined);
    }, PING_WAIT_MS);
    m.timer.unref();
  }

  private pong(buf: Buffer, from: { address: string; port: number }): void {
    const m = this.measuring;
    const p = decodePong(buf);
    if (!m || !p) return;
    if (p.session !== m.measure.session) return this.measured(undefined); // the peer moved to another session
    const next = m.measure.answer(p, this.micros());
    if (next) this.ping(next, from);
    else if (m.measure.done) this.measured(m.measure.offset());
  }

  private measured(offset: number | undefined): void {
    const m = this.measuring;
    if (m?.timer) clearTimeout(m.timer);
    this.measuring = undefined;
    if (!m || offset === undefined) return;
    this.clock = { session: m.measure.session, offset, atMs: this.now() };
    this.synced = undefined;
    this.update();
  }

  status(): { listening: boolean; peers: number; sessions: number; bpm?: number; phase: boolean } {
    const s = this.peers.leading(this.now());
    return { listening: this.listening, ...this.peers.state(this.now()), phase: s !== undefined && s.timeline !== undefined && this.clock?.session === s.session };
  }

  async stop(): Promise<void> {
    this.measured(undefined);
    const sockets = [this.socket, this.pinger];
    this.socket = undefined;
    this.pinger = undefined;
    this.last = undefined;
    this.synced = undefined;
    this.clock = undefined;
    this.lastAttempt = undefined;
    await Promise.all(sockets.map((s) => s && new Promise<void>((resolve) => s.close(() => resolve()))));
  }
}
