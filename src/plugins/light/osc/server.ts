/**
 * OSC control (docs/specs/midi.md, « Contrôle externe : OSC »). Addresses are generated from the
 * command registry: command "tempo.tap" → /light/tempo/tap. Arguments are either one JSON object
 * string, or positional values mapped onto the command's parameters in declared order.
 * `/light/help` answers one /light/help/route message per address.
 */
import { createSocket, type Socket } from "node:dgram";
import type { z } from "zod";
import type { CommandDef, CommandRegistry } from "../commands/registry.js";
import { decodeOsc, encodeOsc, type OscArg } from "./codec.js";

export interface OscConfig {
  enabled: boolean;
  port: number;
  /** Allowed sender IPs; empty = any. */
  allow: string[];
}

export const oscAddress = (command: string): string => `/light/${command.replace(/\./g, "/")}`;

export interface OscRoute {
  address: string;
  command: string;
  params: string[];
  description: string;
}

export function oscRoutes(registry: CommandRegistry): OscRoute[] {
  return registry.list().map((d: CommandDef) => ({
    address: oscAddress(d.name),
    command: d.name,
    params: Object.keys((d.schema as unknown as z.ZodObject).shape ?? {}),
    description: d.title,
  }));
}

/** Maps OSC args onto a command's parameters. */
export function oscArgsToObject(args: OscArg[], params: string[]): Record<string, unknown> {
  if (args.length === 1 && typeof args[0] === "string" && args[0].trim().startsWith("{")) return JSON.parse(args[0]) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  args.forEach((a, i) => {
    const key = params[i];
    if (key === undefined) return;
    out[key] = typeof a === "object" && a !== null ? a.value : a;
  });
  return out;
}

export class OscServer {
  private socket: Socket | undefined;
  readonly log: { at: number; address: string; ok: boolean; error?: string }[] = [];

  constructor(
    private config: OscConfig,
    private readonly registry: CommandRegistry,
    private readonly invoke: (command: string, args: unknown) => Promise<unknown>,
  ) {}

  get port(): number | undefined {
    return this.socket?.address().port;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) return;
    const sock = createSocket("udp4");
    sock.on("message", (buf, rinfo) => void this.onMessage(buf, rinfo.address, rinfo.port));
    sock.on("error", (err) => console.warn("OSC:", err.message));
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.bind(this.config.port, () => resolve());
    });
    this.socket = sock;
  }

  stop(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  async setConfig(config: OscConfig): Promise<void> {
    this.stop();
    this.config = config;
    await this.start();
  }

  private reply(address: string, args: OscArg[], host: string, port: number): void {
    this.socket?.send(encodeOsc({ address, args }), port, host);
  }

  private async onMessage(buf: Buffer, host: string, port: number): Promise<void> {
    if (this.config.allow.length && !this.config.allow.includes(host)) return;
    let messages;
    try {
      messages = decodeOsc(buf);
    } catch {
      return;
    }
    const routes = oscRoutes(this.registry);
    for (const msg of messages) {
      if (msg.address === "/light/help") {
        for (const r of routes) this.reply("/light/help/route", [r.address, r.params.join(" "), r.description], host, port);
        continue;
      }
      const route = routes.find((r) => r.address === msg.address);
      if (!route) {
        this.log.push({ at: Date.now(), address: msg.address, ok: false, error: "adresse inconnue" });
        continue;
      }
      try {
        await this.invoke(route.command, oscArgsToObject(msg.args, route.params));
        this.log.push({ at: Date.now(), address: msg.address, ok: true });
      } catch (err) {
        this.log.push({ at: Date.now(), address: msg.address, ok: false, error: (err as Error).message });
        this.reply("/light/error", [msg.address, (err as Error).message], host, port);
      }
      if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    }
  }
}
