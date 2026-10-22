/**
 * Sends rendered universes over Art-Net and/or sACN, and discovers Art-Net nodes.
 *
 * - Art-Net: unicast to the nodes whose outputs match the universe's port-address (auto routing
 *   from ArtPollReply), or to configured IPs, or broadcast as a fallback. Keep-alive ≥ 1 Hz.
 * - Discovery: ArtPoll every 3 s on the bound interface; nodes expire after 10 s of silence.
 *   Needs UDP 6454: if it is taken (QLC+ running on the same machine), output still works from an
 *   ephemeral port and discovery is reported unavailable.
 * - sACN: multicast (or unicast) per universe, with priority.
 * - DMX USB: an interface plugged into this computer (dmx-usb.ts), at its own pace.
 */
import { createSocket, type Socket } from "node:dgram";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { ARTNET_PORT, decodeDmx, decodePollReply, encodeDmx, encodePoll, encodeSync } from "./artnet.js";
import { NodeRegistry, type KnownNode } from "./artnet-discovery.js";
import { SACN_PORT, encodeSacnData, multicastGroup } from "./sacn.js";
import { DmxUsbOutputs, type DmxUsbKind } from "./dmx-usb.js";

export interface UniverseRoute {
  universe: number; // 1-based internal universe
  artnet?: { portAddress: number; targets?: string[]; broadcast?: boolean };
  sacn?: { universe: number; priority?: number; unicast?: string[] };
  /** A DMX USB interface: its serial port, and its kind (Open DMX or USB Pro). */
  usb?: { path: string; kind: DmxUsbKind };
}

export interface OutputConfig {
  /** Local IPv4 to bind (selects the interface). Default: all interfaces. */
  bindAddress?: string;
  routes: UniverseRoute[];
  /** Standby: render but send nothing (another console holds the nodes). */
  standby?: boolean;
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

/** Another controller seen sending ArtDmx (only visible while discovery holds UDP 6454). */
export interface ForeignSource {
  ip: string;
  port: number;
  portAddresses: number[];
  lastSeen: number;
  /** From one of this machine's addresses: another instance, or QLC+ on the same computer. */
  local: boolean;
}

const FOREIGN_EXPIRY_MS = 3000;

function localAddresses(): Set<string> {
  const out = new Set<string>(["127.0.0.1"]);
  for (const addrs of Object.values(networkInterfaces())) for (const a of addrs ?? []) if (a.family === "IPv4") out.add(a.address);
  return out;
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
  private readonly foreign = new Map<string, ForeignSource>();
  /**
   * The ArtDmx packets this router sent in the last seconds, by fingerprint. A broadcast comes back
   * to its sender: a copy of one of these is our own; anything else is another console, even from
   * this machine and the same port (two instances share 6454), so it is never excluded by address.
   */
  private readonly recentlySent = new Map<string, number>();
  private readonly locals = localAddresses();

  constructor(
    private config: OutputConfig,
    /** The DMX USB interfaces; none by default (the plugin gives the machine's serial ports). */
    readonly usb: DmxUsbOutputs = new DmxUsbOutputs(null),
  ) {}

  private usbRoutes(): { path: string; kind: DmxUsbKind }[] {
    return this.config.routes.flatMap((r) => (r.usb ? [r.usb] : []));
  }

  onNodesChanged(fn: (change: { added?: KnownNode; lost?: KnownNode[] }) => void): void {
    this.nodeListener = fn;
  }

  setConfig(config: OutputConfig): void {
    this.config = config;
    if (this.artnet) this.usb.use(this.usbRoutes());
  }

  /** New routes, sent at the next frame (not after the keep-alive): the light moves at once. */
  setRoutes(routes: UniverseRoute[]): void {
    this.config = { ...this.config, routes };
    this.lastSent.clear();
    if (this.artnet) this.usb.use(this.usbRoutes());
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
    this.artnet.on("message", (msg, rinfo) => {
      const reply = decodePollReply(msg);
      if (reply && this.registry.seen(reply, Date.now()) === "added") this.nodeListener?.({ added: this.registry.list().find((n) => n.ip === reply.ip) });
      if (!reply) this.received(msg, rinfo.address, rinfo.port);
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
    this.usb.setActive(!this.config.standby);
    this.usb.use(this.usbRoutes());
  }

  stop(): void {
    void this.usb.stop();
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

  /** Records an ArtDmx from another controller: any packet but the copies of our own. */
  received(msg: Buffer, ip: string, port: number, nowMs = Date.now()): void {
    const dmx = decodeDmx(msg);
    if (!dmx) return;
    const seen = this.recentlySent.get(fingerprint(msg));
    if (seen !== undefined && nowMs - seen <= SELF_ECHO_MS) return;
    const key = `${ip}:${port}`;
    const known = this.foreign.get(key);
    const portAddresses = known ? [...new Set([...known.portAddresses, dmx.portAddress])].sort((a, b) => a - b) : [dmx.portAddress];
    this.foreign.set(key, { ip, port, portAddresses, lastSeen: nowMs, local: this.locals.has(ip) });
  }

  private rememberSent(packet: Buffer, nowMs: number): void {
    for (const [key, at] of this.recentlySent) {
      if (nowMs - at <= SELF_ECHO_MS) break; // insertion order: the rest is newer
      this.recentlySent.delete(key);
    }
    this.recentlySent.set(fingerprint(packet), nowMs);
  }

  /** Controllers seen sending Art-Net in the last seconds. */
  foreignSources(nowMs = Date.now()): ForeignSource[] {
    for (const [k, f] of this.foreign) if (nowMs - f.lastSeen > FOREIGN_EXPIRY_MS) this.foreign.delete(k);
    return [...this.foreign.values()];
  }

  /**
   * Standby: nothing is sent; leaving it resends every universe at once. Entering it sends a last
   * all-zero frame (3 times, UDP): a node merging two sources keeps a silent source's last frame
   * for ~10 s, and zeros are neutral in HTP (in LTP the other console's next frame wins at once).
   */
  setStandby(on: boolean, nowMs = Date.now()): void {
    if (on && !this.config.standby) {
      const zeros = Array.from({ length: Math.max(0, ...this.config.routes.map((r) => r.universe)) }, () => new Uint8Array(512));
      for (let i = 0; i < 3; i++) this.sendFrame(zeros, nowMs, true);
    }
    this.config = { ...this.config, standby: on };
    if (!on) this.lastSent.clear();
    if (this.artnet) this.usb.setActive(!on);
  }

  isStandby(): boolean {
    return Boolean(this.config.standby);
  }

  /** Sends every routed universe that changed, or that has not been sent for KEEPALIVE_MS. */
  sendFrame(buffers: readonly Uint8Array[], nowMs = Date.now(), force = false): void {
    if (this.config.standby) return;
    let sentAny = false;
    for (const route of this.config.routes) {
      const data = buffers[route.universe - 1];
      if (!data) continue;
      if (route.usb) this.usb.send(route.usb.path, data); // the interface keeps its own pace
      const last = this.lastSent.get(route.universe);
      const changed = !last || !equalBytes(last.data, data);
      if (!force && !changed && last && nowMs - last.at < KEEPALIVE_MS) continue;
      this.lastSent.set(route.universe, { at: nowMs, data: data.slice() });
      sentAny = true;
      if (route.artnet) {
        const packet = encodeDmx({ sequence: this.nextSequence(`a${route.universe}`), physical: 0, portAddress: route.artnet.portAddress, data });
        this.rememberSent(packet, nowMs);
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

/** How long a packet we sent may take to come back to us (broadcast echo). */
const SELF_ECHO_MS = 2000;

/** FNV-1a over the whole packet (sequence, port-address and data included): cheap enough per frame. */
function fingerprint(buf: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) h = Math.imul(h ^ buf[i]!, 0x01000193);
  return `${buf.length}:${(h >>> 0).toString(36)}`;
}
