/**
 * TypeScript SDK for light-mcp-server (docs/specs/data-cli-sdk.md, « SDK de scripts »).
 * No dependency: native fetch and WebSocket (Node ≥ 22, browsers). Every action goes through the
 * server's command layer, like the MCP tools and the OSC addresses: see `light commands` or
 * GET /api/plugins/light/openapi.json for the list and the arguments.
 *
 *   const light = await LightClient.login("http://localhost:8790", "1234");
 *   await light.call("look.go", { id: "joie" });
 *   const stop = light.subscribe("light:state", (s) => console.log(s));
 */
export type { Look, Palette, Group, ShowSettings } from "../src/plugins/light/show/model.js";
export type { Song, Section, Setlist } from "../src/plugins/light/songs/songs.js";
export type { Mapping } from "../src/plugins/light/midi/mapping.js";
export type { PatchedFixture, Canvas } from "../src/plugins/light/venue/venue.js";

export class LightError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export interface Role {
  id: string;
  name: string;
  rights: string[];
}

export class LightClient {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  private closed = false;

  /** `token`: from a PIN login, or the master token (`light token`). */
  constructor(
    readonly url: string,
    private readonly token: string,
  ) {
    this.url = url.replace(/\/$/, "");
  }

  /** Logs in with a role's PIN. */
  static async login(url: string, pin: string): Promise<LightClient & { role: Role }> {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) });
    const body = (await res.json().catch(() => ({}))) as { token?: string; role?: Role; error?: string };
    if (!res.ok || !body.token) throw new LightError(res.status, body.error ?? "connexion refusée");
    return Object.assign(new LightClient(url, body.token), { role: body.role! });
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.url}${path}`, { ...init, headers: { authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) } });
  }

  /** Runs a command (e.g. "look.go", { id }) and returns its result. */
  async call<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await this.request(`/api/plugins/light/commands/${command}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
    const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string; detail?: unknown };
    if (!res.ok) throw new LightError(res.status, `${command} : ${body.error ?? res.statusText}`, body.detail);
    return body.result as T;
  }

  /** Commands available (name, title, right, read-only, JSON schema of the arguments). */
  async commands(): Promise<{ name: string; title: string; description: string; right: string; readOnly: boolean; schema: unknown }[]> {
    const res = await this.request("/api/plugins/light/commands");
    if (!res.ok) throw new LightError(res.status, res.statusText);
    return res.json() as Promise<never>;
  }

  async state(): Promise<{ blackout: boolean; standby: boolean; universes: number; discovery: string; foreignSources: string[] }> {
    const res = await this.request("/api/plugins/light/state");
    if (!res.ok) throw new LightError(res.status, res.statusText);
    return res.json() as Promise<never>;
  }

  /** .lightshow backup of the show (and the venue unless `venue` is false). */
  async downloadArchive(venue = true): Promise<Uint8Array> {
    const res = await this.request(`/api/plugins/light/archive${venue ? "" : "?venue=0"}`);
    if (!res.ok) throw new LightError(res.status, res.statusText);
    return new Uint8Array(await res.arrayBuffer());
  }

  async restoreArchive(bytes: Uint8Array): Promise<unknown> {
    const res = await this.request("/api/plugins/light/archive", { method: "POST", headers: { "content-type": "application/zip" }, body: bytes });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new LightError(res.status, body.error ?? res.statusText);
    return body;
  }

  /**
   * Follows a live topic (light:state, light:tempo, light:song, light:command, light:midi…).
   * Connects on first use, reconnects by itself; returns the unsubscribe function.
   */
  subscribe(topic: string, handler: (data: unknown) => void): () => void {
    let set = this.handlers.get(topic);
    if (!set) {
      this.handlers.set(topic, (set = new Set()));
      this.send({ t: "sub", id: Date.now(), topic });
    }
    set.add(handler);
    void this.connect();
    return () => {
      set!.delete(handler);
      if (set!.size === 0) {
        this.handlers.delete(topic);
        this.send({ t: "unsub", id: Date.now(), topic });
      }
    };
  }

  /** Closes the live connection. */
  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private connecting: Promise<void> | null = null;
  private connect(): Promise<void> {
    if (this.ws || this.closed) return Promise.resolve();
    return (this.connecting ??= (async () => {
      try {
        const res = await this.request("/api/auth/ws-ticket", { method: "POST" });
        if (!res.ok) throw new LightError(res.status, "ticket refusé");
        const { ticket } = (await res.json()) as { ticket: string };
        const ws = new WebSocket(`${this.url.replace(/^http/, "ws")}/api/ws?ticket=${encodeURIComponent(ticket)}`, "light.control.v1.json");
        this.ws = ws;
        ws.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data)) as { t: string; topic?: string; data?: unknown };
          if (msg.t === "hello") for (const topic of this.handlers.keys()) this.send({ t: "sub", id: Date.now(), topic });
          else if (msg.t === "evt" && msg.topic) for (const h of this.handlers.get(msg.topic) ?? []) h(msg.data);
        };
        ws.onclose = () => {
          this.ws = null;
          if (!this.closed && this.handlers.size) setTimeout(() => void this.connect(), 1500);
        };
      } finally {
        this.connecting = null;
      }
    })());
  }
}
