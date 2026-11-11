/**
 * Registry of Art-Net nodes seen through ArtPollReply. Pure: the caller feeds replies and the
 * current time; expiry is computed, never timer-driven, so it is deterministic in tests.
 */
import type { PollReply } from "./artnet.js";
import { isBroadcast } from "./subnet.js";

export interface KnownNode extends PollReply {
  /** ip#bindIndex: multi-port nodes answer once per bind index. */
  key: string;
  firstSeen: number;
  lastSeen: number;
}

export interface RegistryChange {
  added: KnownNode[];
  updated: KnownNode[];
  lost: KnownNode[];
}

export class NodeRegistry {
  private readonly nodes = new Map<string, KnownNode>();

  constructor(private readonly expiryMs = 10_000) {}

  /** Records a reply; returns "added" or "updated". */
  seen(reply: PollReply, nowMs: number): "added" | "updated" {
    const key = `${reply.ip}#${reply.bindIndex}`;
    const previous = this.nodes.get(key);
    this.nodes.set(key, { ...reply, key, firstSeen: previous?.firstSeen ?? nowMs, lastSeen: nowMs });
    return previous ? "updated" : "added";
  }

  /** Removes nodes silent for longer than the expiry, and returns them. */
  expire(nowMs: number): KnownNode[] {
    const lost: KnownNode[] = [];
    for (const [key, node] of this.nodes) {
      if (nowMs - node.lastSeen > this.expiryMs) {
        this.nodes.delete(key);
        lost.push(node);
      }
    }
    return lost;
  }

  list(): KnownNode[] {
    return [...this.nodes.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Nodes outputting a given port-address: the automatic unicast routing targets. */
  outputsFor(portAddress: number): KnownNode[] {
    return this.list().filter((n) => n.outputAddresses.includes(portAddress));
  }
}

/**
 * How an Art-Net route is sent: « auto » to the nodes that output its port-address (broadcast when
 * none does, unless broadcast is false), « broadcast » to the whole network, « nodes » only to the
 * chosen IPs (none chosen: nothing). A route saved before the choice existed goes to its targets
 * when it has some.
 */
export type ArtnetSend = "auto" | "broadcast" | "nodes";

export interface ArtnetRoute {
  portAddress: number;
  send?: ArtnetSend;
  targets?: string[];
  /** In « auto », false sends nothing when no node outputs the address. */
  broadcast?: boolean;
}

export function artnetSend(route: ArtnetRoute): ArtnetSend {
  return route.send ?? (route.targets?.length ? "nodes" : "auto");
}

/** The hosts an Art-Net route's packets go to, given the nodes outputting its address. */
export function artnetDestinations(route: ArtnetRoute, outputs: readonly { ip: string }[], broadcast: string): string[] {
  switch (artnetSend(route)) {
    case "nodes":
      return [...new Set(route.targets ?? [])];
    case "broadcast":
      return [broadcast];
    case "auto": {
      const ips = [...new Set(outputs.map((n) => n.ip))];
      return ips.length ? ips : route.broadcast === false ? [] : [broadcast];
    }
  }
}

export interface Coverage {
  /** Routes sent to an Art-Net port-address that no node seen outputs (by broadcast, to no one). */
  unheard: { universe: number; portAddress: number }[];
  /** Art-Net output ports of the nodes seen that no route feeds. */
  unfed: { key: string; ip: string; shortName: string; portAddress: number }[];
  /**
   * Routes sent to chosen nodes (`send: "nodes"`), none of which answered discovery for a while,
   * while nodes seen do output the route's port-address: the node may answer from another address
   * (a likely cause, not a certainty). One entry per route.
   */
  misdirected: { universe: number; portAddress: number; targets: string[]; nodes: { key: string; ip: string; shortName: string }[] }[];
}

/** How long (3 polls, 3 s apart) a target may stay unseen before its route is called misdirected: a slow node, a lost reply. */
export const MISDIRECTED_GRACE_MS = 9_000;

/** What `coverage` needs to call a route misdirected without crying wolf. Times from one (monotonic) clock. */
export interface CoverageWatch {
  nowMs: number;
  /** Since when discovery has been polling (none: it is not, and nothing is called misdirected). */
  discoverySince?: number;
  /** When a universe's Art-Net route last changed (none: not since discovery started). */
  changedAt?: (universe: number) => number | undefined;
  /** Is this a broadcast address (default: subnet.ts isBroadcast without the interfaces): a target that is one is never a node failing to answer. */
  isBroadcast?: (ip: string) => boolean;
  graceMs?: number;
}

/**
 * Do the routes reach the nodes? Only Art-Net is checked: a route sent to chosen nodes is trusted,
 * and a port set to sACN listens to sACN universes, which ArtPollReply does not tell. With no node
 * seen (discovery off, or an empty network), there is nothing to say. A route aimed at nodes is
 * called misdirected only once discovery and the route itself have both lasted `graceMs`, and never
 * when one of its targets is a broadcast address. Without `watch`, no delay.
 */
export function coverage(routes: readonly { universe: number; artnet?: ArtnetRoute }[], nodes: readonly KnownNode[], watch?: CoverageWatch): Coverage {
  if (!nodes.length) return { unheard: [], unfed: [], misdirected: [] };
  const seenIps = new Set(nodes.map((n) => n.ip));
  const heard = new Set(nodes.flatMap((n) => n.ports.filter((p) => !p.sacn).map((p) => p.portAddress)));
  const fed = new Set(routes.flatMap((r) => (r.artnet ? [r.artnet.portAddress] : [])));
  const settled = (universe: number): boolean => {
    if (!watch) return true;
    if (watch.discoverySince === undefined) return false;
    const since = Math.max(watch.discoverySince, watch.changedAt?.(universe) ?? -Infinity);
    return watch.nowMs - since >= (watch.graceMs ?? MISDIRECTED_GRACE_MS);
  };
  return {
    unheard: routes.flatMap((r) => (r.artnet && artnetSend(r.artnet) !== "nodes" && !heard.has(r.artnet.portAddress) ? [{ universe: r.universe, portAddress: r.artnet.portAddress }] : [])),
    misdirected: routes.flatMap((r) => {
      const a = r.artnet;
      const targets = a && artnetSend(a) === "nodes" ? [...new Set(a.targets ?? [])] : [];
      if (!a || !targets.length || targets.some((ip) => seenIps.has(ip) || (watch?.isBroadcast ?? isBroadcast)(ip)) || !settled(r.universe)) return [];
      const outputs = new Map(nodes.filter((n) => n.ports.some((p) => !p.sacn && p.portAddress === a.portAddress)).map((n) => [n.ip, { key: n.key, ip: n.ip, shortName: n.shortName }]));
      return outputs.size ? [{ universe: r.universe, portAddress: a.portAddress, targets, nodes: [...outputs.values()] }] : [];
    }),
    unfed: nodes.flatMap((n) => n.ports.filter((p) => !p.sacn && !fed.has(p.portAddress)).map((p) => ({ key: n.key, ip: n.ip, shortName: n.shortName, portAddress: p.portAddress }))),
  };
}
