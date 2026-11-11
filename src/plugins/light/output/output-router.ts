/**
 * Sends rendered universes over Art-Net and/or sACN, and discovers Art-Net nodes.
 *
 * - Art-Net: unicast to the nodes whose outputs match the universe's port-address (auto routing
 *   from ArtPollReply, broadcast as a fallback), or to the whole network, or only to chosen node
 *   IPs (artnetDestinations). Keep-alive ≥ 1 Hz.
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
import { SendHealth, HEALTH_WINDOW_MS, type HostHealth } from "./send-health.js";
import { NodeRegistry, artnetDestinations, coverage, type ArtnetRoute, type Coverage, type KnownNode } from "./artnet-discovery.js";
import { broadcastOf, isBroadcast, judgesReach, localBroadcasts, outOfSubnet, subnetsOf, type Subnet } from "./subnet.js";
import { SACN_PORT, encodeSacnData, multicastGroup } from "./sacn.js";
import { DmxUsbOutputs, portPath, type DmxUsbKind } from "./dmx-usb.js";

export interface UniverseRoute {
  universe: number; // 1-based internal universe
  artnet?: ArtnetRoute;
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
  /** Art-Net UDP port, 6454. Another one only for tests, which must never reach a real console or node. */
  artnetPort?: number;
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
  /** How long ago its last packet came (ms). */
  seenAgoMs: number;
  /** That moment on the wall clock (epoch ms): the router's own clock is monotonic and means nothing outside it. */
  lastSeen: number;
  /** From one of this machine's addresses: another instance, or QLC+ on the same computer. */
  local: boolean;
}
/** A foreign source as the router keeps it: `at` on its own (monotonic) clock. */
type HeardSource = Omit<ForeignSource, "seenAgoMs" | "lastSeen"> & { at: number };

const FOREIGN_EXPIRY_MS = 3000;

function localAddresses(): Set<string> {
  const out = new Set<string>(["127.0.0.1"]);
  for (const addrs of Object.values(networkInterfaces())) for (const a of addrs ?? []) if (a.family === "IPv4") out.add(a.address);
  return out;
}

const KEEPALIVE_MS = 1000;
const POLL_MS = 3000;

/** Broadcast address of the interface owning `address`, or the limited broadcast. */
export function broadcastFor(address?: string, all: readonly Subnet[] = subnetsOf(networkInterfaces())): string {
  const own = address && address !== "0.0.0.0" ? all.find((s) => s.address === address) : undefined;
  return (own && broadcastOf(own)) || "255.255.255.255";
}

/** The subnets a node can be reached on directly: the bound interface's, or every interface's when none is bound. */
function reachableSubnets(all: readonly Subnet[], bindAddress?: string): readonly Subnet[] {
  const own = bindAddress && bindAddress !== "0.0.0.0" ? all.filter((s) => s.address === bindAddress) : [];
  return own.length ? own : all;
}

/** Deep equality of plain JSON values, whatever the order of an object's keys. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export class OutputRouter {
  readonly registry = new NodeRegistry();
  private readonly health = new SendHealth();
  readonly stats: OutputStats = { framesSent: 0, packetsSent: 0, errors: 0, discovery: "off" };
  private artnet: Socket | undefined;
  private sacn: Socket | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly sequences = new Map<string, number>();
  private readonly lastSent = new Map<number, { at: number; data: Uint8Array }>();
  private readonly cid = randomBytes(16);
  private nodeListener: ((change: { added?: KnownNode; lost?: KnownNode[] }) => void) | undefined;
  private readonly foreign = new Map<string, HeardSource>();
  /**
   * The ArtDmx packets this router sent in the last seconds, by fingerprint. A broadcast comes back
   * to its sender: a copy of one of these is our own; anything else is another console, even from
   * this machine and the same port (two instances share 6454), so it is never excluded by address.
   */
  private readonly recentlySent = new Map<string, number>();
  private readonly locals = localAddresses();
  /** When discovery started polling, on `clock`; undefined while it does not. */
  private discoverySince: number | undefined;
  /** When each universe's Art-Net route last changed, on `clock`: a target just chosen is not called unseen at once. */
  private readonly artnetChangedAt = new Map<number, number>();

  constructor(
    private config: OutputConfig,
    /** The DMX USB interfaces; none by default (the plugin gives the machine's serial ports). */
    readonly usb: DmxUsbOutputs = new DmxUsbOutputs(null),
    /** Monotonic milliseconds for the send health, node expiry and the misdirected delay: a wall clock set back would freeze them. */
    private readonly clock: () => number = () => performance.now(),
    /** This machine's IPv4 subnets (os.networkInterfaces() by default): a test gives its own. */
    private readonly interfaces: () => readonly Subnet[] = () => subnetsOf(networkInterfaces()),
  ) {}

  /**
   * The subnets the output reaches directly (the bound interface's, else every interface's): coverage,
   * `localBroadcasts` and `outOfSubnet` all judge on them, so the interface (web/src/broadcast.ts)
   * tells a broadcast from a host as the server does.
   */
  private subnets(): readonly Subnet[] {
    return reachableSubnets(this.interfaces(), this.config.bindAddress);
  }

  private broadcast(): string {
    return broadcastFor(this.config.bindAddress, this.interfaces());
  }

  private get artnetPort(): number {
    return this.config.artnetPort ?? ARTNET_PORT;
  }

  private usbRoutes(): { path: string; kind: DmxUsbKind }[] {
    return this.config.routes.flatMap((r) => (r.usb ? [r.usb] : [])); // of two routes to one port, DmxUsbOutputs.use takes the first
  }

  onNodesChanged(fn: (change: { added?: KnownNode; lost?: KnownNode[] }) => void): void {
    this.nodeListener = fn;
  }

  setConfig(config: OutputConfig): void {
    this.noteArtnetChanges(config.routes);
    this.config = config;
    if (this.artnet) this.usb.use(this.usbRoutes());
  }

  private noteArtnetChanges(routes: readonly UniverseRoute[]): void {
    const now = this.clock();
    for (const u of this.artnetChangedAt.keys()) if (!routes.some((r) => r.universe === u)) this.artnetChangedAt.delete(u); // a removed universe forgets its date
    for (const r of routes) {
      const before = this.config.routes.find((x) => x.universe === r.universe)?.artnet;
      if (!sameValue(before, r.artnet)) this.artnetChangedAt.set(r.universe, now);
    }
  }

  /** New routes, sent at the next frame (not after the keep-alive): the light moves at once. */
  setRoutes(routes: UniverseRoute[]): void {
    this.noteArtnetChanges(routes);
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
      if (reply && this.registry.seen(reply, this.clock()) === "added") this.nodeListener?.({ added: this.registry.list().find((n) => n.ip === reply.ip) });
      if (!reply) this.received(msg, rinfo.address, rinfo.port);
    });
    const bindAddress = this.config.bindAddress ?? "0.0.0.0";
    if (options.discovery !== false) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.artnet!.once("error", reject);
          this.artnet!.bind(this.artnetPort, bindAddress, () => {
            this.artnet!.off("error", reject);
            resolve();
          });
        });
        this.artnet.setBroadcast(true);
        this.stats.discovery = "active";
        this.discoverySince = this.clock();
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
    this.discoverySince = undefined;
    this.artnet?.close();
    this.sacn?.close();
    this.artnet = this.sacn = undefined;
  }

  poll(): void {
    if (!this.artnet || this.stats.discovery !== "active") return;
    this.artnet.send(encodePoll(), this.artnetPort, this.broadcast());
    const lost = this.registry.expire(this.clock());
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
      this.health.record(host, !err, this.clock());
    });
    this.stats.packetsSent += 1;
  }

  /** Records an ArtDmx from another controller: any packet but the copies of our own. */
  received(msg: Buffer, ip: string, port: number, nowMs = this.clock()): void {
    const dmx = decodeDmx(msg);
    if (!dmx) return;
    const seen = this.recentlySent.get(fingerprint(msg));
    if (seen !== undefined && nowMs - seen <= SELF_ECHO_MS) return;
    const key = `${ip}:${port}`;
    const known = this.foreign.get(key);
    const portAddresses = known ? [...new Set([...known.portAddresses, dmx.portAddress])].sort((a, b) => a - b) : [dmx.portAddress];
    this.foreign.set(key, { ip, port, portAddresses, at: nowMs, local: this.locals.has(ip) });
  }

  private rememberSent(packet: Buffer, nowMs: number): void {
    for (const [key, at] of this.recentlySent) {
      if (nowMs - at <= SELF_ECHO_MS) break; // insertion order: the rest is newer
      this.recentlySent.delete(key);
    }
    this.recentlySent.set(fingerprint(packet), nowMs);
  }

  /** Controllers seen sending Art-Net in the last seconds, each with how long ago (`seenAgoMs`) and that moment on the wall clock (`lastSeen`), as `nodes()`. */
  foreignSources(nowMs = this.clock(), wallMs = Date.now()): ForeignSource[] {
    for (const [k, f] of this.foreign) if (nowMs - f.at > FOREIGN_EXPIRY_MS) this.foreign.delete(k);
    return [...this.foreign.values()].map(({ at, ...rest }) => {
      const ago = Math.max(0, nowMs - at);
      return { ...rest, seenAgoMs: Math.round(ago), lastSeen: Math.round(wallMs - ago) };
    });
  }

  /**
   * Standby: nothing is sent; leaving it resends every universe at once. Entering it sends a last
   * all-zero frame (3 times, UDP): a node merging two sources keeps a silent source's last frame
   * for ~10 s, and zeros are neutral in HTP (in LTP the other console's next frame wins at once).
   */
  setStandby(on: boolean, nowMs = this.clock()): void {
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

  private artnetHosts(route: ArtnetRoute): string[] {
    return artnetDestinations(route, this.registry.outputsFor(route.portAddress), this.broadcast());
  }

  /** Sends and errors per target host over the last HEALTH_WINDOW_MS, with the hosts that mostly fail. */
  sendHealth(nowMs = this.clock()): { windowSeconds: number; hosts: HostHealth[] } {
    return { windowSeconds: HEALTH_WINDOW_MS / 1000, hosts: this.health.hosts(nowMs) };
  }

  /** Do the routes reach the nodes seen (artnet-discovery.ts coverage), with the delays and broadcast targets this router knows. */
  coverage(nowMs = this.clock()): Coverage {
    const subnets = this.subnets();
    return coverage(this.config.routes, this.registry.list(), {
      nowMs,
      ...(this.discoverySince === undefined ? {} : { discoverySince: this.discoverySince }),
      changedAt: (u) => this.artnetChangedAt.get(u),
      isBroadcast: (ip) => isBroadcast(ip, subnets),
    });
  }

  /** Whether coverage takes this host for a broadcast (a broadcast target is never misdirected). */
  isBroadcast(ip: string): boolean {
    return isBroadcast(ip, this.subnets());
  }

  /** The broadcast addresses of the subnets the output reaches (as coverage judges them), the limited broadcast first. */
  localBroadcasts(): string[] {
    return localBroadcasts(this.subnets());
  }

  /** The broadcast address Art-Net goes to from the bound interface. */
  broadcastAddress(): string {
    return this.broadcast();
  }

  /** The nodes seen, each with how long ago it answered (`seenAgoMs`) and that moment on the wall clock (`lastSeen`, epoch ms): the router's own clock is monotonic and means nothing outside it. */
  nodes(nowMs = this.clock(), wallMs = Date.now()): (Omit<KnownNode, "firstSeen" | "lastSeen"> & { seenAgoMs: number; lastSeen: number })[] {
    return this.registry.list().map(({ firstSeen: _first, lastSeen, ...rest }) => ({ ...rest, seenAgoMs: Math.max(0, Math.round(nowMs - lastSeen)), lastSeen: Math.round(wallMs - Math.max(0, nowMs - lastSeen)) }));
  }

  /**
   * Of these addresses, those on none of the subnets the output can reach directly: a node announcing
   * one is out of reach without a router. A broadcast address is never one (it goes out on the
   * interface). Undefined when those subnets judge nothing (a bound /32): the interface then takes
   * any x.x.x.255 for a broadcast, as coverage does.
   */
  outOfSubnet(ips: readonly string[]): string[] | undefined {
    const subnets = this.subnets();
    return judgesReach(subnets) ? outOfSubnet(ips, subnets) : undefined;
  }

  /** Where each routed universe goes now, by protocol: node IPs, the broadcast or the multicast address. */
  destinations(): { universe: number; artnet?: string[]; sacn?: string[] }[] {
    return this.config.routes.map((r) => ({ universe: r.universe, ...(r.artnet ? { artnet: this.artnetHosts(r.artnet) } : {}), ...(r.sacn ? { sacn: sacnHosts(r.sacn) } : {}) }));
  }

  /** Sends every routed universe that changed, or that has not been sent for KEEPALIVE_MS. */
  sendFrame(buffers: readonly Uint8Array[], nowMs = this.clock(), force = false): void {
    if (this.config.standby) return;
    let sentAny = false;
    const usbPorts = new Set<string>();
    for (const route of this.config.routes) {
      const data = buffers[route.universe - 1];
      if (!data) continue;
      // the interface keeps its own pace; a port named by two routes gets the first one's universe, not the two in turn
      if (route.usb && !usbPorts.has(portPath(route.usb.path))) {
        usbPorts.add(portPath(route.usb.path));
        this.usb.send(route.usb.path, data);
      }
      const last = this.lastSent.get(route.universe);
      const changed = !last || !equalBytes(last.data, data);
      if (!force && !changed && last && nowMs - last.at < KEEPALIVE_MS) continue;
      this.lastSent.set(route.universe, { at: nowMs, data: data.slice() });
      sentAny = true;
      if (route.artnet) {
        const packet = encodeDmx({ sequence: this.nextSequence(`a${route.universe}`), physical: 0, portAddress: route.artnet.portAddress, data });
        this.rememberSent(packet, nowMs);
        for (const host of this.artnetHosts(route.artnet)) this.send(this.artnet, packet, this.artnetPort, host);
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
        for (const host of sacnHosts(route.sacn)) this.send(this.sacn, packet, SACN_PORT, host);
      }
    }
    if (sentAny) {
      this.stats.framesSent += 1;
      if (this.config.artSync) this.send(this.artnet, encodeSync(), this.artnetPort, this.broadcast());
    }
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** sACN goes to the chosen IPs, else to the universe's multicast group. */
function sacnHosts(route: NonNullable<UniverseRoute["sacn"]>): string[] {
  return route.unicast?.length ? route.unicast : [multicastGroup(route.universe)];
}

/** How long a packet we sent may take to come back to us (broadcast echo). */
const SELF_ECHO_MS = 2000;

/** FNV-1a over the whole packet (sequence, port-address and data included): cheap enough per frame. */
function fingerprint(buf: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) h = Math.imul(h ^ buf[i]!, 0x01000193);
  return `${buf.length}:${(h >>> 0).toString(36)}`;
}
