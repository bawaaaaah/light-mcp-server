/**
 * Sends rendered universes over Art-Net and/or sACN, and discovers Art-Net nodes.
 *
 * - Art-Net: unicast to the nodes whose outputs match the universe's port-address (auto routing
 *   from ArtPollReply), or to configured IPs, or broadcast as a fallback. Keep-alive ≥ 1 Hz.
 * - Discovery: ArtPoll every 3 s on the bound interface; nodes expire after 10 s of silence.
 *   Needs UDP 6454: if it is taken (QLC+ running on the same machine), output still works from an
 *   ephemeral port and discovery is reported unavailable.
 * - sACN: multicast (or unicast) per universe, with priority.
 */
import { createSocket, type Socket } from "node:dgram";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { ARTNET_PORT, decodePollReply, encodeDmx, encodePoll, encodeSync } from "./artnet.js";
import { NodeRegistry, type KnownNode } from "./artnet-discovery.js";
import { SACN_PORT, encodeSacnData, multicastGroup } from "./sacn.js";

export interface UniverseRoute {
  universe: number; // 1-based internal universe
  artnet?: { portAddress: number; targets?: string[]; broadcast?: boolean };
  sacn?: { universe: number; priority?: number; unicast?: string[] };
}

export interface OutputConfig {
  /** Local IPv4 to bind (selects the interface). Default: all interfaces. */
  bindAddress?: string;
  routes: UniverseRoute[];
  artSync?: boolean;
  sourceName?: string;
}

export interface OutputStats {
  framesSent: number;
  packetsSent: number;
  errors: number;
  discovery: "active" | "unavailable" | "off";
  discoveryError?: string;
}

const KEEPALIVE_MS = 1000;
const POLL_MS = 3000;

/** Broadcast address of the interface owning `address`, or the limited broadcast. */
export function broadcastFor(address?: string): string {
  if (address && address !== "0.0.0.0") {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === "IPv4" && a.address === address) {
          const ip = a.address.split(".").map(Number);
          const mask = a.netmask.split(".").map(Number);
          return ip.map((b, i) => (b & mask[i]!) | (~mask[i]! & 255)).join(".");
        }
      }
    }
  }
  return "255.255.255.255";
}

export class OutputRouter {
  readonly registry = new NodeRegistry();
  readonly stats: OutputStats = { framesSent: 0, packetsSent: 0, errors: 0, discovery: "off" };
  private artnet: Socket | undefined;
  private sacn: Socket | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly sequences = new Map<string, number>();
  private readonly lastSent = new Map<number, { at: number; data: Uint8Array }>();
  private readonly cid = randomBytes(16);
  private nodeListener: ((change: { added?: KnownNode; lost?: KnownNode[] }) => void) | undefined;

  constructor(private config: OutputConfig) {}

  onNodesChanged(fn: (change: { added?: KnownNode; lost?: KnownNode[] }) => void): void {
    this.nodeListener = fn;
  }

  setConfig(config: OutputConfig): void {
    this.config = config;
  }

  getConfig(): OutputConfig {
    return this.config;
  }

  async start(options: { discovery?: boolean } = {}): Promise<void> {
    this.artnet = createSocket({ type: "udp4", reuseAddr: true });
    this.artnet.on("error", (err) => {
      this.stats.errors += 1;
      console.warn("Art-Net socket error:", err.message);
    });
    this.artnet.on("message", (msg) => {
      const reply = decodePollReply(msg);
      if (reply && this.registry.seen(reply, Date.now()) === "added") this.nodeListener?.({ added: this.registry.list().find((n) => n.ip === reply.ip) });
    });
    const bindAddress = this.config.bindAddress ?? "0.0.0.0";
    if (options.discovery !== false) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.artnet!.once("error", reject);
          this.artnet!.bind(ARTNET_PORT, bindAddress, () => {
            this.artnet!.off("error", reject);
            resolve();
          });
        });
        this.artnet.setBroadcast(true);
        this.stats.discovery = "active";
        this.poll();
        this.pollTimer = setInterval(() => this.poll(), POLL_MS);
        this.pollTimer.unref();
      } catch (err) {
        // Port 6454 busy: fall back to an ephemeral port, output only.
        this.stats.discovery = "unavailable";
        this.stats.discoveryError = (err as Error).message;
        this.artnet.close();
        this.artnet = createSocket({ type: "udp4" });
        await new Promise<void>((resolve) => this.artnet!.bind(0, bindAddress === "0.0.0.0" ? undefined : bindAddress, resolve));
        this.artnet.setBroadcast(true);
      }
    } else {
      await new Promise<void>((resolve) => this.artnet!.bind(0, bindAddress === "0.0.0.0" ? undefined : bindAddress, resolve));
      this.artnet.setBroadcast(true);
    }
    this.sacn = createSocket({ type: "udp4", reuseAddr: true });
    await new Promise<void>((resolve) => this.sacn!.bind(0, bindAddress === "0.0.0.0" ? undefined : bindAddress, resolve));
    if (bindAddress !== "0.0.0.0") this.sacn.setMulticastInterface(bindAddress);
    this.sacn.setMulticastTTL(8);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.artnet?.close();
    this.sacn?.close();
    this.artnet = this.sacn = undefined;
  }

  poll(): void {
    if (!this.artnet || this.stats.discovery !== "active") return;
    this.artnet.send(encodePoll(), ARTNET_PORT, broadcastFor(this.config.bindAddress));
    const lost = this.registry.expire(Date.now());
    if (lost.length) this.nodeListener?.({ lost });
  }

  private nextSequence(key: string): number {
    const seq = ((this.sequences.get(key) ?? 0) % 255) + 1;
    this.sequences.set(key, seq);
    return seq;
  }

  private send(sock: Socket | undefined, buf: Buffer, port: number, host: string): void {
    if (!sock) return;
    sock.send(buf, port, host, (err) => {
      if (err) this.stats.errors += 1;
    });
    this.stats.packetsSent += 1;
  }

  /** Sends every routed universe that changed, or that has not been sent for KEEPALIVE_MS. */
  sendFrame(buffers: readonly Uint8Array[], nowMs = Date.now(), force = false): void {
    let sentAny = false;
    for (const route of this.config.routes) {
      const data = buffers[route.universe - 1];
      if (!data) continue;
      const last = this.lastSent.get(route.universe);
      const changed = !last || !equalBytes(last.data, data);
      if (!force && !changed && last && nowMs - last.at < KEEPALIVE_MS) continue;
      this.lastSent.set(route.universe, { at: nowMs, data: data.slice() });
      sentAny = true;
      if (route.artnet) {
        const packet = encodeDmx({ sequence: this.nextSequence(`a${route.universe}`), physical: 0, portAddress: route.artnet.portAddress, data });
        const targets = route.artnet.targets?.length ? route.artnet.targets : this.registry.outputsFor(route.artnet.portAddress).map((n) => n.ip);
        if (targets.length > 0) for (const ip of [...new Set(targets)]) this.send(this.artnet, packet, ARTNET_PORT, ip);
        else if (route.artnet.broadcast !== false) this.send(this.artnet, packet, ARTNET_PORT, broadcastFor(this.config.bindAddress));
      }
      if (route.sacn) {
        const packet = encodeSacnData({
          cid: this.cid,
          sourceName: this.config.sourceName ?? "light-mcp-server",
          priority: route.sacn.priority ?? 100,
          syncAddress: 0,
          sequence: this.nextSequence(`s${route.universe}`),
          options: 0,
          universe: route.sacn.universe,
          data,
        });
        const targets = route.sacn.unicast?.length ? route.sacn.unicast : [multicastGroup(route.sacn.universe)];
        for (const host of targets) this.send(this.sacn, packet, SACN_PORT, host);
      }
    }
    if (sentAny) {
      this.stats.framesSent += 1;
      if (this.config.artSync) this.send(this.artnet, encodeSync(), ARTNET_PORT, broadcastFor(this.config.bindAddress));
    }
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
