import { expect } from "chai";
import { createSocket, type Socket } from "node:dgram";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import { bootstrap, type Running } from "../../src/index.js";
import { decodeDmx } from "../../src/plugins/light/output/artnet.js";

/** Fake Art-Net node on its own loopback address (127.0.0.2:6454). */
async function fakeNode(): Promise<{ sock: Socket; next: (pred: (d: Uint8Array) => boolean, ms?: number) => Promise<Uint8Array> }> {
  const sock = createSocket({ type: "udp4", reuseAddr: true });
  const waiters: { pred: (d: Uint8Array) => boolean; resolve: (d: Uint8Array) => void }[] = [];
  sock.on("message", (msg) => {
    const dmx = decodeDmx(msg);
    if (!dmx) return;
    for (const w of [...waiters]) if (w.pred(dmx.data)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(dmx.data);
    }
  });
  await new Promise<void>((r) => sock.bind(6454, "127.0.0.2", r));
  return {
    sock,
    next: (pred, ms = 1000) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("no matching ArtDmx")), ms);
        waiters.push({ pred, resolve: (d) => (clearTimeout(t), resolve(d)) });
      }),
  };
}

describe("server end to end", function () {
  this.timeout(15000);
  let running: Running;
  let base: string;
  let node: Awaited<ReturnType<typeof fakeNode>>;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "light-e2e-"));
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ version: 1, server: {}, plugins: { light: { universes: 2, discovery: false, output: { routes: [{ universe: 1, artnet: { portAddress: 0, targets: ["127.0.0.2"] } }] } } } }),
    );
    node = await fakeNode();
    running = await bootstrap({ configPath, port: 0, host: "127.0.0.1", log: () => undefined });
    base = `http://127.0.0.1:${running.gateway!.address!.port}`;
    await running.auth.setPin("regisseur", "1234");
    await running.auth.setPin("benevole", "5678");
  });

  after(async () => {
    await running.stop();
    node.sock.close();
  });

  const login = async (pin: string) => {
    const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) });
    expect(res.status).to.equal(200);
    return ((await res.json()) as { token: string }).token;
  };
  const command = (token: string, name: string, body: unknown) =>
    fetch(`${base}/api/plugins/light/commands/${name}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("reports health", async () => {
    const h = (await (await fetch(`${base}/health`)).json()) as { status: string };
    expect(h.status).to.equal("HEALTHY");
  });

  it("refuses a wrong PIN", async () => {
    const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "0000" }) });
    expect(res.status).to.equal(401);
  });

  it("parks a channel from HTTP and the Art-Net node receives it quickly", async () => {
    const token = await login("1234");
    const t0 = performance.now();
    const received = node.next((d) => d[0] === 200);
    const res = await command(token, "dmx.set", { universe: 1, channel: 1, value: 200 });
    expect(res.status).to.equal(200);
    await received;
    expect(performance.now() - t0).to.be.below(50);
  });

  it("enforces role rights", async () => {
    const token = await login("5678");
    const res = await command(token, "dmx.set", { universe: 1, channel: 2, value: 10 });
    expect(res.status).to.equal(403);
    expect((await command(token, "dmx.get", { universe: 1 })).status).to.equal(200); // reading is allowed (dashboards:view)
    expect((await command(token, "panic", {})).status).to.equal(200); // panic is always allowed to a volunteer
    await command(token, "blackout", { on: false });
  });

  it("validates arguments", async () => {
    const token = await login("1234");
    const res = await command(token, "dmx.set", { universe: 1, channel: 999, value: 1 });
    expect(res.status).to.equal(400);
  });

  it("exposes the commands as MCP tools", async () => {
    const client = new Client({ name: "e2e", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${running.masterToken}` } } });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).to.include.members(["light_dmx_set", "light_blackout", "light_panic", "light_nodes_list"]);
    const zero = node.next((d) => d[0] === 0);
    const result = await client.callTool({ name: "light_blackout", arguments: { on: true } });
    expect(result.isError).to.not.equal(true);
    await zero;
    await client.callTool({ name: "light_blackout", arguments: { on: false } });
    await client.close();
  });

  it("streams DMX frames over WebSocket", async () => {
    const token = await login("1234");
    const { ticket } = (await (await fetch(`${base}/api/auth/ws-ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json()) as { ticket: string };
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/ws?ticket=${ticket}`, "light.stream.v1.json");
    const frame = await new Promise<{ topic: string; data: { universes: [number, { $b64: string }][] } }>((resolve, reject) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { t: string; topic: string; data: { universes: [number, { $b64: string }][] } };
        if (msg.t === "hello") ws.send(JSON.stringify({ t: "sub", id: 1, topic: "light:dmx", params: { universes: [1] } }));
        if (msg.t === "evt") resolve(msg);
        if (msg.t === "err") reject(new Error(JSON.stringify(msg)));
      });
      ws.on("error", reject);
    });
    expect(frame.topic).to.equal("light:dmx");
    const [u, bytes] = frame.data.universes[0]!;
    expect(u).to.equal(1);
    expect(Buffer.from(bytes.$b64, "base64").length).to.equal(512);
    ws.close();
  });
});
