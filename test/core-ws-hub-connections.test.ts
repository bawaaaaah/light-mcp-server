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
  const dropped: string[] = [];
  const handled: unknown[] = [];
  const plugin = {
    id: "test",
    liveTopics: () => ({}),
    liveConnectionClosed: (id: string) => void closed.push(id),
    liveLossyRoutes: () => ["commands/midi.in"],
    liveRequestDropped: (route: string) => void dropped.push(route),
  } as unknown as McpPlugin;

  beforeEach(async () => {
    closed.length = 0;
    dropped.length = 0;
    handled.length = 0;
    hub = new WsHub({ plugins: [plugin], eventBus: new EventBus(), auth, heartbeatIntervalMs: 60_000, handleRequest: async (req) => (handled.push(req.body), { status: 200, body: { ok: true } }) });
    server = createServer();
    server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  });
  afterEach(async () => {
    await hub.close();
    await new Promise((r) => server.close(r));
  });

  /** Opens a control connection; resolves with its socket and its « hello ». */
  const open = (credential: string, previous?: string, channel = "control") =>
    new Promise<{ ws: WebSocket; hello: { connection: string; resumed?: string } }>((resolve, reject) => {
      const port = (server.address() as AddressInfo).port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?ticket=${credential}:1${previous ? `&previous=${previous}` : ""}`, `light.${channel}.v1.json`);
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

  it("refuses a previous id from another channel of the same credential", async () => {
    const stream = await open("token-a", undefined, "stream");
    const control = await open("token-a", stream.hello.connection);
    expect(control.hello.resumed).to.equal(undefined);
    expect(stream.ws.readyState).to.equal(WebSocket.OPEN);
    stream.ws.close();
    control.ws.close();
  });

  /** Sends n midi.in requests over `ws`, `gapMs` apart; resolves with the statuses answered. */
  const flood = (ws: WebSocket, n: number, gapMs: number) =>
    new Promise<number[]>((resolve) => {
      const statuses: number[] = [];
      ws.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as { t: string; status?: number };
        if (msg.t === "res") statuses.push(msg.status!);
        if (statuses.length === n) resolve(statuses);
      });
      let i = 0;
      const next = () => {
        ws.send(JSON.stringify({ t: "req", id: i + 1, method: "POST", path: "/api/plugins/test/commands/midi.in", body: { value: i === n - 1 ? "rest" : i } }));
        if (++i < n) setTimeout(next, gapMs);
      };
      next();
    });

  it("a sustained Web MIDI flow (200/s for 5 s) closes nothing, and its last value arrives", async function () {
    this.timeout(15_000);
    const tab = await open("token-a");
    const statuses = await flood(tab.ws, 1000, 5);
    expect(tab.ws.readyState).to.equal(WebSocket.OPEN);
    expect(statuses.every((s) => s === 200)).to.equal(true);
    expect(handled.at(-1)).to.deep.equal({ value: "rest" });
    tab.ws.close();
  });

  it("past its own rate a Web MIDI message is dropped (429) and said, the connection kept; the common rate untouched", async () => {
    const tab = await open("token-a");
    const statuses = await flood(tab.ws, 2000, 0);
    expect(statuses.filter((s) => s === 429).length).to.be.greaterThan(0);
    expect(dropped.length).to.equal(statuses.filter((s) => s === 429).length);
    expect(dropped[0]).to.equal("commands/midi.in");
    expect(tab.ws.readyState).to.equal(WebSocket.OPEN);
    // another request still answers: the flood spent nothing of the common bucket
    const answered = new Promise<number>((ok) => tab.ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as { t: string; id?: number; status?: number };
      if (msg.t === "res" && msg.id === 99999) ok(msg.status!);
    }));
    tab.ws.send(JSON.stringify({ t: "req", id: 99999, method: "POST", path: "/api/plugins/test/commands/other", body: {} }));
    expect(await answered).to.equal(200);
    tab.ws.close();
  });

  /** Sends `n` frames at once; resolves with the close code once the hub closes the socket (or undefined after 1 s). */
  const closeCodeAfter = (ws: WebSocket, frame: (i: number) => string, n: number) =>
    new Promise<number | undefined>((resolve) => {
      ws.on("close", (code: number) => resolve(code));
      for (let i = 0; i < n; i++) ws.send(frame(i));
      setTimeout(() => resolve(undefined), 1000);
    });

  it("any other request past the common rate closes the connection (4429)", async () => {
    const tab = await open("token-a");
    const code = await closeCodeAfter(tab.ws, (i) => JSON.stringify({ t: "req", id: i + 1, method: "POST", path: "/api/plugins/test/commands/other", body: {} }), 400);
    expect(code).to.equal(4429);
  });

  it("invalid messages spend the common rate too: a flood of them closes (4429)", async () => {
    const tab = await open("token-a");
    const code = await closeCodeAfter(tab.ws, () => JSON.stringify({ t: "nonsense" }), 400);
    expect(code).to.equal(4429);
  });

  it("the lossy rate is the control channel's only: a stream connection flooding that path is closed (4429)", async () => {
    const stream = await open("token-a", undefined, "stream");
    const code = await closeCodeAfter(stream.ws, (i) => JSON.stringify({ t: "req", id: i + 1, method: "POST", path: "/api/plugins/test/commands/midi.in", body: {} }), 200);
    expect(code).to.equal(4429);
    expect(dropped).to.deep.equal([]);
  });
});
