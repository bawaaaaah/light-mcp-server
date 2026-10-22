/**
 * Minimal AppleMIDI (RTP-MIDI) session endpoint over UDP, in pure Node: no system daemon, so it
 * works the same on macOS, Linux, Raspberry Pi and Docker.
 *
 * - Listens on a control port and control+1 (data); accepts invitations (responder role).
 * - Can invite a remote session (initiator role) and runs the CK clock-sync exchange.
 * - Emits "midi" with each complete MIDI message received; send() transmits messages.
 *
 * Bonjour (announcing the session, finding the others) is the hub's (core/mdns.ts). Out of scope:
 * recovery journal, receiver feedback (RS) handling.
 */
import { createSocket, type Socket } from "node:dgram";
import { EventEmitter } from "node:events";
import { randomInt } from "node:crypto";
import { PROTOCOL_VERSION, decodeControl, decodeRtpMidi, encodeControl, encodeRtpMidi, isControlPacket } from "./applemidi.js";

export interface Peer {
  name: string;
  address: string;
  controlPort: number;
  dataPort: number;
  ssrc: number;
}

export interface RtpSessionOptions {
  name: string;
  port: number; // control port; data port is port + 1
  host?: string;
}

/** AppleMIDI timestamps are in 100 µs units. */
const now100us = (): bigint => BigInt(Math.round(performance.now() * 10));

/** Rejects when the port is taken (on a Mac, the system's network MIDI session holds 5004) instead of never settling. */
const bind = (socket: Socket, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, host, () => {
      socket.off("error", reject);
      resolve();
    });
  });

export class RtpMidiSession extends EventEmitter {
  readonly ssrc = randomInt(1, 0xffffffff);
  private control!: Socket;
  private data!: Socket;
  private peers = new Map<number, Peer>();
  private sequence = randomInt(0, 0xffff);
  private pendingInvites = new Map<number, { resolve: (p: Peer) => void; reject: (e: Error) => void; stage: "control" | "data"; address: string; port: number }>();

  constructor(private readonly options: RtpSessionOptions) {
    super();
  }

  async start(): Promise<void> {
    const host = this.options.host ?? "0.0.0.0";
    this.control = createSocket("udp4");
    this.data = createSocket("udp4");
    this.control.on("message", (msg, rinfo) => this.onControl(msg, rinfo.address, rinfo.port, "control"));
    this.data.on("message", (msg, rinfo) => this.onData(msg, rinfo.address, rinfo.port));
    try {
      await bind(this.control, this.options.port, host);
      await bind(this.data, this.options.port + 1, host);
    } catch (err) {
      this.control.close();
      this.data.close();
      throw err;
    }
  }

  stop(): void {
    for (const peer of this.peers.values()) {
      const by = encodeControl({ command: "BY", version: PROTOCOL_VERSION, token: 0, ssrc: this.ssrc, name: "" });
      this.control.send(by, peer.controlPort, peer.address);
    }
    this.peers.clear();
    this.control.close();
    this.data.close();
  }

  listPeers(): Peer[] {
    return [...this.peers.values()];
  }

  /** Ends the session with one peer (BY), as stop() does with all of them. */
  bye(ssrc: number): void {
    const peer = this.peers.get(ssrc);
    if (!peer) return;
    this.control.send(encodeControl({ command: "BY", version: PROTOCOL_VERSION, token: 0, ssrc: this.ssrc, name: "" }), peer.controlPort, peer.address);
    this.peers.delete(ssrc);
    this.emit("peerLeft", peer);
  }

  /** Invites a remote session (control port). Resolves once both ports accepted and CK ran. */
  invite(address: string, controlPort: number, timeoutMs = 3000): Promise<Peer> {
    const token = randomInt(1, 0xffffffff);
    return new Promise<Peer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInvites.delete(token);
        reject(new Error(`no answer from ${address}:${controlPort}`));
      }, timeoutMs);
      this.pendingInvites.set(token, {
        resolve: (p) => {
          clearTimeout(timer);
          resolve(p);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        stage: "control",
        address,
        port: controlPort,
      });
      this.control.send(encodeControl({ command: "IN", version: PROTOCOL_VERSION, token, ssrc: this.ssrc, name: this.options.name }), controlPort, address);
    });
  }

  send(messages: number[][]): void {
    if (this.peers.size === 0 || messages.length === 0) return;
    this.sequence = (this.sequence + 1) & 0xffff;
    const packet = encodeRtpMidi({ sequence: this.sequence, timestamp: Number(now100us() & 0xffffffffn), ssrc: this.ssrc, messages });
    for (const peer of this.peers.values()) this.data.send(packet, peer.dataPort, peer.address);
  }

  private onControl(msg: Buffer, address: string, port: number, via: "control" | "data"): void {
    const p = decodeControl(msg);
    if (!p) return;
    const sock = via === "control" ? this.control : this.data;
    switch (p.command) {
      case "IN": {
        // Responder: accept on the port the invitation came to.
        sock.send(encodeControl({ command: "OK", version: PROTOCOL_VERSION, token: p.token, ssrc: this.ssrc, name: this.options.name }), port, address);
        const existing = this.peers.get(p.ssrc);
        const peer: Peer = existing ?? { name: p.name, address, controlPort: port, dataPort: port + 1, ssrc: p.ssrc };
        if (via === "control") peer.controlPort = port;
        else peer.dataPort = port;
        this.peers.set(p.ssrc, peer);
        if (via === "data") this.emit("peer", peer);
        return;
      }
      case "OK": {
        const pending = this.pendingInvites.get(p.token);
        if (!pending) return;
        if (pending.stage === "control") {
          pending.stage = "data";
          this.data.send(encodeControl({ command: "IN", version: PROTOCOL_VERSION, token: p.token, ssrc: this.ssrc, name: this.options.name }), pending.port + 1, pending.address);
          return;
        }
        this.pendingInvites.delete(p.token);
        const peer: Peer = { name: p.name, address: pending.address, controlPort: pending.port, dataPort: pending.port + 1, ssrc: p.ssrc };
        this.peers.set(p.ssrc, peer);
        this.data.send(encodeControl({ command: "CK", ssrc: this.ssrc, count: 0, timestamps: [now100us(), 0n, 0n] }), peer.dataPort, peer.address);
        pending.resolve(peer);
        this.emit("peer", peer);
        return;
      }
      case "NO": {
        const pending = this.pendingInvites.get(p.token);
        this.pendingInvites.delete(p.token);
        pending?.reject(new Error(`invitation refused by ${address}`));
        return;
      }
      case "BY": {
        const peer = this.peers.get(p.ssrc);
        this.peers.delete(p.ssrc);
        if (peer) this.emit("peerLeft", peer);
        return;
      }
      case "CK": {
        const [t1, t2] = p.timestamps;
        if (p.count === 0) {
          this.data.send(encodeControl({ command: "CK", ssrc: this.ssrc, count: 1, timestamps: [t1, now100us(), 0n] }), port, address);
        } else if (p.count === 1) {
          const t3 = now100us();
          this.data.send(encodeControl({ command: "CK", ssrc: this.ssrc, count: 2, timestamps: [t1, t2, t3] }), port, address);
          this.emit("clockSync", { latencyMs: Number(t3 - t1) / 20 });
        }
        return;
      }
      default:
        return;
    }
  }

  private onData(msg: Buffer, address: string, port: number): void {
    if (isControlPacket(msg)) {
      this.onControl(msg, address, port, "data");
      return;
    }
    const packet = decodeRtpMidi(msg);
    if (!packet || !this.peers.has(packet.ssrc)) return;
    for (const m of packet.messages) this.emit("midi", m, packet.ssrc);
  }
}
