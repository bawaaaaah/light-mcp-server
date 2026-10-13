import { expect } from "chai";
import { createSocket, type Socket } from "node:dgram";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import { bootstrap, type Running } from "../../src/index.js";
import { decodeDmx } from "../../src/plugins/light/output/artnet.js";
import { decodeOsc, encodeOsc } from "../../src/plugins/light/osc/codec.js";
import { RtpMidiSession } from "../../src/plugins/light/midi/rtp/session.js";

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
      JSON.stringify({ version: 1, server: {}, plugins: { light: { universes: 2, discovery: false, output: { routes: [{ universe: 1, artnet: { portAddress: 0, targets: ["127.0.0.2"] } }] }, osc: { port: 0 }, midi: { active: "rtp", profiles: { rtp: { inputs: [], rtp: { enabled: true, port: 15304, name: "e2e" } } } } } } }),
    );
    mkdirSync(join(dir, "data", "fixtures"), { recursive: true });
    copyFileSync(new URL("../fixtures/bar4.qxf", import.meta.url), join(dir, "data", "fixtures", "bar4.qxf"));
    mkdirSync(join(dir, "data", "imports"), { recursive: true });
    copyFileSync(new URL("../fixtures/synthetic.qxw", import.meta.url), join(dir, "data", "imports", "workspace.qxw"));
    mkdirSync(join(dir, "data", "private"), { recursive: true });
    writeFileSync(join(dir, "data", "private", "shell.adg"), gzipSync(readFileSync(new URL("../fixtures/shell-rack.xml", import.meta.url))));
    node = await fakeNode();
    running = await bootstrap({ configPath, port: 0, host: "127.0.0.1", log: () => undefined, light: { dataRoot: join(dir, "data"), midiNative: null } });
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
    const resources = (await client.listResources()).resources.map((r) => r.uri);
    expect(resources).to.include.members(["light://show", "light://live", "light://venue", "light://knowledge"]);
    const live = await client.readResource({ uri: "light://live" });
    expect(String((live.contents[0] as { text: string }).text)).to.match(/Tempo : .* BPM/);
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

  it("runs commands from OSC, and answers /light/help", async () => {
    const port = running.light.osc.port!;
    const sock = createSocket("udp4");
    await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
    const help: string[] = [];
    sock.on("message", (b) => help.push(String(decodeOsc(b)[0]!.args[0])));
    sock.send(encodeOsc({ address: "/light/help", args: [] }), port, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 100));
    expect(help).to.include.members(["/light/panic", "/light/blackout", "/light/tempo/tap", "/light/dmx/set"]);
    const set = node.next((d) => d[4] === 77);
    sock.send(encodeOsc({ address: "/light/dmx/set", args: [1, 5, 77] }), port, "127.0.0.1");
    await set;
    sock.close();
  });

  it("turns MIDI received over RTP-MIDI into commands through a mapping", async () => {
    const token = await login("1234");
    const put = await command(token, "midi.mapping.put", {
      mapping: { id: "blackout-note", input: { type: "note", channel: 1, number: 60 }, mode: "latch", on: { command: "blackout", args: { on: true } }, off: { command: "blackout", args: { on: false } } },
    });
    expect(put.status).to.equal(200);
    const daw = new RtpMidiSession({ name: "DAW", port: 15306, host: "127.0.0.1" });
    await daw.start();
    try {
      await daw.invite("127.0.0.1", 15304);
      const dark = node.next((d) => d[4] === 0 && d[0] === 0);
      daw.send([[0x90, 60, 100]]);
      await dark;
      expect(running.light.engine.isBlackout()).to.equal(true);
      daw.send([[0x90, 60, 100]]); // latch: second press releases
      await new Promise((r) => setTimeout(r, 50));
      expect(running.light.engine.isBlackout()).to.equal(false);
      const status = (await (await command(token, "midi.status", {})).json()) as { result: { inputs: { name: string; lastMessageAt?: number }[] } };
      expect(status.result.inputs.find((i) => i.name === "RTP · DAW")!.lastMessageAt).to.be.a("number");
    } finally {
      daw.stop();
    }
  });

  it("follows tap tempo", async () => {
    const token = await login("1234");
    await command(token, "tempo.tap", {});
    await new Promise((r) => setTimeout(r, 500));
    const res = (await (await command(token, "tempo.tap", {})).json()) as { result: { bpm: number } };
    expect(res.result.bpm).to.be.closeTo(120, 15);
  });

  it("plays a show: patch, canvas, palette, look, panic with and without a safe look", async () => {
    const token = await login("1234");
    const ok = async (name: string, body: unknown) => {
      const res = await command(token, name, body);
      const json = (await res.json()) as { ok: boolean; result: unknown; error?: string };
      expect(res.status, `${name}: ${json.error}`).to.equal(200);
      return json.result;
    };
    await command(token, "dmx.release", {});
    await ok("venue.fixture.put", { fixture: { id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 101 } });
    await ok("venue.canvas.put", { canvas: { id: "mur", name: "Mur", cells: 4, render: [0, 1, 2, 3].map((h) => ({ from: h, to: h, targets: [{ fixture: "bar", head: h }] })) } });
    await ok("palette.put", { palette: { id: "intime", name: "Intime", colors: ["#1e3ce6", "#ff960f"] } });
    await ok("look.put", { look: { id: "refrain", name: "Refrain", canvas: "mur", palette: "intime", technique: { kind: "damier", colors: ["#000000", "#000000"], block: 1 } } });
    await ok("look.put", { look: { id: "secours", name: "Secours", canvas: "mur", technique: { kind: "plat", color: "#ffd8a8" } } });
    const lit = node.next((d) => d[100] === 255 && d[103] === 0x1e && d[105] === 0xe6); // dimmer + head 0 = palette colour 1
    await ok("look.go", { id: "refrain" });
    await lit;
    // Panic without safe look → Blackout
    const dark = node.next((d) => d.every((v) => v === 0));
    expect(await ok("panic", {})).to.deep.equal({ action: "blackout", reason: "aucun look de secours défini" });
    await dark;
    await ok("blackout", { on: false });
    // Panic with a safe look → recalls it
    await ok("show.settings.set", { safeLook: "secours" });
    await ok("look.go", { id: "refrain" });
    const safe = node.next((d) => d[103] === 0xff && d[104] === 0xd8);
    expect(await ok("panic", {})).to.deep.equal({ action: "safe-look", look: "secours" });
    await safe;
    const looks = (await ok("look.list", {})) as { id: string; active: boolean }[];
    expect(looks.filter((l) => l.active).map((l) => l.id)).to.deep.equal(["secours"]);
  });

  it("imports a QLC+ workspace and passes the self-test", async () => {
    const token = await login("1234");
    const call = async (name: string, body: unknown) => {
      const res = await command(token, name, body);
      const json = (await res.json()) as { result: Record<string, unknown>; error?: string };
      expect(res.status, json.error).to.equal(200);
      return json.result;
    };
    const dry = await call("import.qxw", { file: "workspace.qxw" });
    expect(dry.applied).to.equal(false);
    expect(dry.counts).to.deep.equal({ fixtures: 2, cells: 8, looks: 5, groups: 2, mappings: 3 });
    expect(running.light.runtime.looks.get("checker")).to.equal(undefined); // dry run wrote nothing
    const applied = await call("import.qxw", { file: "workspace.qxw", apply: true });
    expect(applied.collisions).to.deep.equal([]);
    expect((await command(token, "import.qxw", { file: "../../etc/passwd" })).status).to.equal(422);
    const result = (await call("selftest.run", {})) as { total: number; passed: number; failed: unknown[]; exclusivity: { ok: boolean }[]; latencyMs: { max: number } };
    expect(result.failed, JSON.stringify(result.failed)).to.deep.equal([]);
    expect(result.passed).to.equal(result.total);
    expect(result.exclusivity.every((e) => e.ok)).to.equal(true);
    expect(result.latencyMs.max).to.be.below(50);
    const table = (await call("export.notes", {})) as unknown as string;
    expect(table).to.contain("| note | 1 | 36 | C1 | Checker | trigger |");
    const rack = await call("export.ableton.rack", {});
    expect(rack.chains).to.equal(3); // notes 36, 37 (imported) and 60 (blackout mapping of an earlier test)
    expect((await command(token, "export.ableton.rack", { shell: "../../x.adg" })).status).to.equal(422);
  });
});
