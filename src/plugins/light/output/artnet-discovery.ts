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

export interface Coverage {
  /** Routes sent to an Art-Net port-address that no node seen outputs (by broadcast, to no one). */
  unheard: { universe: number; portAddress: number }[];
  /** Art-Net output ports of the nodes seen that no route feeds. */
  unfed: { key: string; ip: string; shortName: string; portAddress: number }[];
}

/**
 * Do the routes reach the nodes? Only Art-Net is checked: a route with explicit targets is trusted,
 * and a port set to sACN listens to sACN universes, which ArtPollReply does not tell. With no node
 * seen (discovery off, or an empty network), there is nothing to say.
 */
export function coverage(routes: readonly { universe: number; artnet?: { portAddress: number; targets?: string[] } }[], nodes: readonly KnownNode[]): Coverage {
  if (!nodes.length) return { unheard: [], unfed: [] };
  const heard = new Set(nodes.flatMap((n) => n.ports.filter((p) => !p.sacn).map((p) => p.portAddress)));
  const fed = new Set(routes.flatMap((r) => (r.artnet ? [r.artnet.portAddress] : [])));
  return {
    unheard: routes.flatMap((r) => (r.artnet && !r.artnet.targets?.length && !heard.has(r.artnet.portAddress) ? [{ universe: r.universe, portAddress: r.artnet.portAddress }] : [])),
    unfed: nodes.flatMap((n) => n.ports.filter((p) => !p.sacn && !fed.has(p.portAddress)).map((p) => ({ key: n.key, ip: n.ip, shortName: n.shortName, portAddress: p.portAddress }))),
  };
}
