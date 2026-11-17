/**
 * WebSocket client for the hub (envelope {t, id, topic, data}; docs/architecture.md).
 * Two connections: control topics in JSON, DMX frames on the stream channel in msgpack (bytes
 * travel as native binary). The hub uses one codec per connection in both directions.
 * Reconnects with a fresh ticket and re-subscribes.
 */
import { decode, encode } from "@msgpack/msgpack";
import { wsTicket } from "./api";

type Handler = (data: unknown) => void;
interface Sub {
  topic: string;
  params?: unknown;
  handlers: Set<Handler>;
}

class Channel {
  private ws: WebSocket | null = null;
  private readonly subs = new Map<string, Sub>();
  private nextId = 1;
  private closed = true;
  private readonly statusListeners = new Set<(up: boolean) => void>();

  constructor(
    private readonly channel: "control" | "stream",
    private readonly codec: "json" | "msgpack",
  ) {}

  onStatus(fn: (up: boolean) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(up: boolean): void {
    for (const l of this.statusListeners) l(up);
  }

  async connect(): Promise<void> {
    if (!this.closed) return;
    this.closed = false;
    await this.open();
  }

  private async open(): Promise<void> {
    let ticket: string;
    try {
      ticket = await wsTicket();
    } catch {
      if (!this.closed) setTimeout(() => void this.open(), 2000);
      return;
    }
    // closed while the ticket was on its way (a sign-out, a role change): no socket left behind
    if (this.closed) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`, `light.${this.channel}.v1.${this.codec}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    /** The subscriptions sent on « hello » the hub has not answered yet: the link is up once it has taken them all. */
    let pending: Set<number> | null = null;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const up = () => {
      pending = null;
      clearTimeout(fallback);
      this.setStatus(true);
    };
    ws.onmessage = (ev) => {
      const msg = (typeof ev.data === "string" ? JSON.parse(ev.data) : decode(new Uint8Array(ev.data as ArrayBuffer))) as { t: string; id?: number; topic?: string; data?: unknown };
      if (msg.t === "hello") {
        // subscribed again first, and « up » only once the hub has them: whoever reads again on « up » hears what
        // follows. A read sent on the « sub » alone can reach the hub first (another connection, and a busy hub
        // inflates a compressed frame later), and a change made in between would be neither read nor heard.
        pending = new Set();
        for (const s of this.subs.values()) {
          const id = this.nextId++;
          pending.add(id);
          this.send({ t: "sub", id, topic: s.topic, params: s.params });
        }
        if (!pending.size) up();
        else fallback = setTimeout(up, 5000); // a hub that never answers one: up all the same, as before
      } else if ((msg.t === "ack" || msg.t === "err") && msg.id !== undefined && pending?.delete(msg.id)) {
        if (!pending.size) up();
      } else if (msg.t === "evt" && msg.topic) {
        for (const h of this.subs.get(msg.topic)?.handlers ?? []) h(msg.data);
      }
    };
    ws.onclose = () => {
      pending = null;
      clearTimeout(fallback);
      this.setStatus(false);
      if (!this.closed) setTimeout(() => void this.open(), 1500);
    };
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const clean = Object.fromEntries(Object.entries(msg).filter(([, v]) => v !== undefined));
    this.ws.send(this.codec === "json" ? JSON.stringify(clean) : encode(clean));
  }

  subscribe(topic: string, handler: Handler, params?: unknown): () => void {
    let sub = this.subs.get(topic);
    if (!sub) {
      sub = { topic, params, handlers: new Set() };
      this.subs.set(topic, sub);
      this.send({ t: "sub", id: this.nextId++, topic, params });
    } else if (params !== undefined && JSON.stringify(params) !== JSON.stringify(sub.params)) {
      sub.params = params;
      this.send({ t: "sub", id: this.nextId++, topic, params });
    }
    sub.handlers.add(handler);
    return () => {
      sub!.handlers.delete(handler);
      if (sub!.handlers.size === 0) {
        this.subs.delete(topic);
        this.send({ t: "unsub", id: this.nextId++, topic });
      }
    };
  }
}

export const control = new Channel("control", "json");
export const stream = new Channel("stream", "msgpack");
