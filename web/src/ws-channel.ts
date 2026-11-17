/**
 * One live connection to the hub (envelope {t, id, topic, data}; docs/architecture.md), without the browser: the ticket,
 * the socket and the timers come from outside (ws.ts gives the real ones; the unit tests fakes). Reconnects with a fresh
 * ticket and re-subscribes.
 */
import { decode, encode } from "@msgpack/msgpack";

export type Handler = (data: unknown) => void;
interface Sub {
  topic: string;
  params?: unknown;
  handlers: Set<Handler>;
}

/** What the channel uses of a WebSocket. */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

export interface ChannelDeps {
  /** A one-time ticket for the socket's address. */
  ticket: () => Promise<string>;
  /** Opens the socket for a ticket and a subprotocol. */
  socket: (ticket: string, protocol: string) => SocketLike;
  later: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
}

/** WebSocket.OPEN. */
const OPEN = 1;
/** A ticket that could not be had: tried again after this. */
const TICKET_RETRY_MS = 2000;
/** A socket that closed on its own: opened again after this. */
const RECONNECT_MS = 1500;
/** A hub that never answers a subscription: up all the same after this. */
const ACK_FALLBACK_MS = 5000;

export class Channel {
  private ws: SocketLike | null = null;
  private readonly subs = new Map<string, Sub>();
  private nextId = 1;
  private closed = true;
  /**
   * Bumped by every connect() and close(): an open() of an older generation (its ticket still on its way, a retry or a
   * reconnection timer, the close of a socket it opened) stops there. Without it, a close() then a connect() within a
   * retry delay ran two of them: two sockets, one orphaned on the hub, subscriptions twice, « offline » said wrongly.
   */
  private generation = 0;
  private readonly statusListeners = new Set<(up: boolean) => void>();
  /** The id the hub gave this connection in « hello »: what a request relayed for it names (a Web MIDI relay). */
  connectionId: string | undefined;

  constructor(
    private readonly channel: "control" | "stream",
    private readonly codec: "json" | "msgpack",
    private readonly deps: ChannelDeps,
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
    await this.open(++this.generation);
  }

  /** Still the connection this open() was started for. */
  private current(gen: number): boolean {
    return gen === this.generation && !this.closed;
  }

  private async open(gen: number): Promise<void> {
    if (!this.current(gen)) return;
    let ticket: string;
    try {
      ticket = await this.deps.ticket();
    } catch {
      if (this.current(gen)) this.deps.later(() => void this.open(gen), TICKET_RETRY_MS);
      return;
    }
    // closed (or closed and connected again) while the ticket was on its way: no socket left behind
    if (!this.current(gen)) return;
    const ws = this.deps.socket(ticket, `light.${this.channel}.v1.${this.codec}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    /** The subscriptions sent on « hello » the hub has not answered yet: the link is up once it has taken them all. */
    let pending: Set<number> | null = null;
    let fallback: unknown;
    const up = () => {
      // the ack fallback of a connection closed since: it must not say up for the next one
      if (!this.current(gen)) return;
      pending = null;
      this.deps.cancel(fallback);
      this.setStatus(true);
    };
    ws.onmessage = (ev) => {
      if (!this.current(gen)) return;
      const msg = (typeof ev.data === "string" ? JSON.parse(ev.data) : decode(new Uint8Array(ev.data as ArrayBuffer))) as { t: string; id?: number; topic?: string; data?: unknown; connection?: string };
      if (msg.t === "hello") {
        this.connectionId = msg.connection;
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
        else fallback = this.deps.later(up, ACK_FALLBACK_MS);
      } else if ((msg.t === "ack" || msg.t === "err") && msg.id !== undefined && pending?.delete(msg.id)) {
        if (!pending.size) up();
      } else if (msg.t === "evt" && msg.topic) {
        for (const h of this.subs.get(msg.topic)?.handlers ?? []) h(msg.data);
      }
    };
    ws.onclose = () => {
      pending = null;
      if (this.current(gen)) this.connectionId = undefined;
      this.deps.cancel(fallback);
      // a socket of an older connection: the current one says its own status and reconnects itself
      if (!this.current(gen)) return;
      this.setStatus(false);
      this.deps.later(() => void this.open(gen), RECONNECT_MS);
    };
  }

  close(): void {
    this.closed = true;
    this.generation++;
    this.ws?.close();
    this.ws = null;
    this.setStatus(false);
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState !== OPEN) return;
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
