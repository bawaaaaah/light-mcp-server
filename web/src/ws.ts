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
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`, `light.${this.channel}.v1.${this.codec}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (ev) => {
      const msg = (typeof ev.data === "string" ? JSON.parse(ev.data) : decode(new Uint8Array(ev.data as ArrayBuffer))) as { t: string; topic?: string; data?: unknown };
      if (msg.t === "hello") {
        this.setStatus(true);
        for (const s of this.subs.values()) this.send({ t: "sub", id: this.nextId++, topic: s.topic, params: s.params });
      } else if (msg.t === "evt" && msg.topic) {
        for (const h of this.subs.get(msg.topic)?.handlers ?? []) h(msg.data);
      }
    };
    ws.onclose = () => {
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
