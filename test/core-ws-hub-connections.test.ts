import { expect } from "chai";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { EventBus } from "../src/core/event-bus.js";
import type { AuthMiddleware } from "../src/core/auth.js";
import type { McpPlugin } from "../src/core/plugin.js";
import { WsHub } from "../src/core/ws-hub.js";

/**
 * The hub's connections as plugins see them (docs/architecture.md, « WebSocket »): each one's id in its « hello », its
 * close said to the plugins, a browser's reconnection that lets its previous connection go at once (the same credential
 * only), and nothing said when the server stops.
 */
describe("WebSocket hub: live connections", () => {
  let server: Server;
  let hub: WsHub;
  const closed: string[] = [];
  /** A ticket is « credential:n »: what it authenticates with. */
  const auth = { consumeStreamTicket: (ticket: string) => ticket.split(":")[0], isValidCredential: () => true } as unknown as AuthMiddleware;
  const plugin = { id: "test", liveTopics: () => ({}), liveConnectionClosed: (id: string) => void closed.push(id) } as unknown as McpPlugin;

  beforeEach(async () => {
    closed.length = 0;
    hub = new WsHub({ plugins: [plugin], eventBus: new EventBus(), auth, heartbeatIntervalMs: 60_000 });
    server = createServer();
    server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  });
  afterEach(async () => {
    await hub.close();
    await new Promise((r) => server.close(r));
  });

  /** Opens a control connection; resolves with its socket and its « hello ». */
  const open = (credential: string, previous?: string) =>
    new Promise<{ ws: WebSocket; hello: { connection: string; resumed?: string } }>((resolve, reject) => {
      const port = (server.address() as AddressInfo).port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?ticket=${credential}:1${previous ? `&previous=${previous}` : ""}`, "light.control.v1.json");
      ws.once("message", (raw: Buffer) => resolve({ ws, hello: JSON.parse(raw.toString()) as { connection: string; resumed?: string } }));
      ws.once("error", reject);
    });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(ok()).to.equal(true);
  };

  it("gives each connection its id, and says when one closes", async () => {
    const a = await open("token-a");
    expect(a.hello.connection).to.match(/^[0-9a-f-]{36}$/);
    a.ws.close();
    await until(() => closed.length === 1);
    expect(closed).to.deep.equal([a.hello.connection]);
  });

  it("a reconnection of the same credential lets its previous connection go at once", async () => {
    const old = await open("token-a");
    const next = await open("token-a", old.hello.connection);
    expect(next.hello.resumed).to.equal(old.hello.connection);
    expect(closed).to.deep.equal([old.hello.connection]); // now, not at the next heartbeat
    next.ws.close();
  });

  it("refuses another credential's previous id: that connection stays", async () => {
    const theirs = await open("token-a");
    const mine = await open("token-b", theirs.hello.connection);
    expect(mine.hello.resumed).to.equal(undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).to.deep.equal([]);
    expect(theirs.ws.readyState).to.equal(WebSocket.OPEN);
    theirs.ws.close();
    mine.ws.close();
  });

  it("says nothing when the server stops: what the connections relayed stays as it is", async () => {
    await open("token-a");
    await open("token-b");
    await hub.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).to.deep.equal([]);
  });
});
