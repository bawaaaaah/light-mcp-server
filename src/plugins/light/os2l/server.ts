/**
 * OS2L server (docs/specs/midi.md, « OS2L ») : DJ software (VirtualDJ…) connects over TCP and sends
 * its beats and its pad's buttons. What they do is the plugin's business (`onEvent`); here, the
 * connections, the reading, and the buttons' states sent back to the DJ's pad.
 */
import { createServer, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { encodeFeedback, Os2lReader, type Os2lEvent } from "./codec.js";

export interface Os2lConfig {
  enabled: boolean;
  port: number;
  /** Allowed DJ computers (IPs); empty = any, as for OSC. */
  allow: string[];
}

export interface Os2lClient {
  address: string;
  since: number;
  beats: number;
  bpm?: number;
  lastBeatAt?: number;
}

export class Os2lServer {
  private server: Server | undefined;
  private readonly clients = new Map<Socket, Os2lClient>();
  /** The last events, for the Settings page. */
  readonly log: { at: number; address: string; event: Os2lEvent }[] = [];

  constructor(
    private readonly config: Os2lConfig,
    private readonly onEvent: (event: Os2lEvent, from: string) => void,
  ) {}

  get port(): number | undefined {
    const a = this.server?.address();
    return typeof a === "object" && a ? a.port : undefined;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) return;
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.port, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (err) => console.warn("OS2L :", err.message));
    this.server = server;
  }

  private accept(socket: Socket): void {
    const address = (socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (this.config.allow.length && !this.config.allow.includes(address)) {
      socket.destroy();
      return;
    }
    const client: Os2lClient = { address, since: Date.now(), beats: 0 };
    this.clients.set(socket, client);
    const reader = new Os2lReader();
    socket.setEncoding("utf8");
    socket.setNoDelay(true); // a beat is late by its delay on the wire
    socket.on("data", (chunk: string) => {
      for (const event of reader.push(chunk)) {
        if (event.evt === "beat") {
          client.beats++;
          client.bpm = event.bpm;
          client.lastBeatAt = Date.now();
        } else {
          this.log.push({ at: Date.now(), address, event });
          if (this.log.length > 20) this.log.shift();
        }
        this.onEvent(event, address);
      }
    });
    const forget = () => this.clients.delete(socket);
    socket.on("close", forget);
    socket.on("error", forget);
  }

  /** A button's state on every connected DJ's pad. */
  feedback(name: string, on: boolean, page?: string): void {
    const message = encodeFeedback(name, on, page);
    for (const socket of this.clients.keys()) socket.write(message);
  }

  /** What the DJ software is told to connect to (os2lDirectIp in VirtualDJ): this machine's addresses. */
  status(): { enabled: boolean; port?: number; addresses: string[]; clients: Os2lClient[]; log: Os2lServer["log"] } {
    const addresses = Object.values(networkInterfaces())
      .flatMap((list) => list ?? [])
      .filter((a) => a.family === "IPv4" && !a.internal)
      .map((a) => a.address);
    return { enabled: this.config.enabled, port: this.port, addresses, clients: [...this.clients.values()], log: this.log.slice(-10) };
  }

  async stop(): Promise<void> {
    for (const socket of this.clients.keys()) socket.destroy();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
