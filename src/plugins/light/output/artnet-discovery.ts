/**
 * Registry of Art-Net nodes seen through ArtPollReply. Pure: the caller feeds replies and the
 * current time; expiry is computed, never timer-driven, so it is deterministic in tests.
 */
import type { PollReply } from "./artnet.js";

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
}

/**
 * Do the routes reach the nodes? Only Art-Net is checked: a route sent to chosen nodes is trusted,
 * and a port set to sACN listens to sACN universes, which ArtPollReply does not tell. With no node
 * seen (discovery off, or an empty network), there is nothing to say.
 */
export function coverage(routes: readonly { universe: number; artnet?: ArtnetRoute }[], nodes: readonly KnownNode[]): Coverage {
  if (!nodes.length) return { unheard: [], unfed: [] };
  const heard = new Set(nodes.flatMap((n) => n.ports.filter((p) => !p.sacn).map((p) => p.portAddress)));
  const fed = new Set(routes.flatMap((r) => (r.artnet ? [r.artnet.portAddress] : [])));
  return {
    unheard: routes.flatMap((r) => (r.artnet && artnetSend(r.artnet) !== "nodes" && !heard.has(r.artnet.portAddress) ? [{ universe: r.universe, portAddress: r.artnet.portAddress }] : [])),
    unfed: nodes.flatMap((n) => n.ports.filter((p) => !p.sacn && !fed.has(p.portAddress)).map((p) => ({ key: n.key, ip: n.ip, shortName: n.shortName, portAddress: p.portAddress }))),
  };
}
