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
