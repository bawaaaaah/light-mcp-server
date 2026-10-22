import { expect } from "chai";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap, type Running } from "../../src/index.js";
import { LightClient, LightError } from "../../src/sdk/index.js";

describe("SDK (TypeScript and Python) and OpenAPI", function () {
  this.timeout(30_000);
  let running: Running;
  let url: string;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "light-sdk-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, server: {}, plugins: { light: { universes: 1, discovery: false, output: { routes: [] }, osc: { enabled: false }, os2l: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } } } }));
    mkdirSync(join(dir, "data", "fixtures"), { recursive: true });
    copyFileSync(new URL("../fixtures/bar4.qxf", import.meta.url), join(dir, "data", "fixtures", "bar4.qxf"));
    running = await bootstrap({ configPath: join(dir, "config.json"), port: 0, host: "127.0.0.1", log: () => undefined, light: { dataRoot: join(dir, "data"), midiNative: null } });
    url = `http://127.0.0.1:${running.gateway!.address!.port}`;
    await running.auth.setPin("regisseur", "1234");
    await running.auth.setPin("benevole", "5678");
  });
  after(async () => running.stop());

  it("logs in, runs commands, reads the state and follows a live topic", async () => {
    const light = await LightClient.login(url, "1234");
    expect(light.role.id).to.equal("regisseur");
    await light.call("import.qxw", { xml: readFileSync(new URL("../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    const looks = await light.call<{ id: string }[]>("look.list");
    expect(looks.map((l) => l.id)).to.include("checker");
    const seen = new Promise<unknown>((resolve) => {
      const stop = light.subscribe("light:state", (s) => {
        if ((s as { blackout?: boolean }).blackout) {
          stop();
          resolve(s);
        }
      });
    });
    await new Promise((r) => setTimeout(r, 300)); // let the live connection open
    await light.call("blackout", { on: true });
    expect(await seen).to.deep.include({ blackout: true });
    expect((await light.state()).blackout).to.equal(true);
    await light.call("blackout", { on: false });
    light.close();
  });

  it("reports refusals with their HTTP status", async () => {
    const volunteer = await LightClient.login(url, "5678");
    const err = await volunteer.call("dmx.set", { universe: 1, channel: 1, value: 1 }).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(LightError);
    expect((err as LightError).status).to.equal(403);
    await LightClient.login(url, "0000").then(
      () => expect.fail("wrong PIN accepted"),
      (e: LightError) => expect(e.status).to.equal(401),
    );
  });

  it("describes every command in OpenAPI", async () => {
    const light = await LightClient.login(url, "1234");
    const res = await fetch(`${url}/api/plugins/light/openapi.json`, { headers: { authorization: `Bearer ${(light as unknown as { token: string }).token}` } });
    const doc = (await res.json()) as { openapi: string; paths: Record<string, { post?: { "x-right"?: string; requestBody?: unknown } }> };
    expect(doc.openapi).to.equal("3.0.3");
    const commands = await light.commands();
    for (const c of commands) expect(doc.paths[`/api/plugins/light/commands/${c.name}`]?.post?.["x-right"], c.name).to.equal(c.right);
  });

  it("drives the server from the Python client (self-test bench)", async function () {
    if (spawnSync("python3", ["--version"]).status !== 0) this.skip();
    const script = fileURLToPath(new URL("../../sdk/python/light_client.py", import.meta.url));
    // asynchronous: the server runs in this very process and must keep answering
    const r = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const p = spawn("python3", [script, url, "1234"]);
      let out = "";
      let err = "";
      p.stdout.on("data", (d: Buffer) => (out += d.toString()));
      p.stderr.on("data", (d: Buffer) => (err += d.toString()));
      p.on("close", (code) => resolve({ code, out, err }));
    });
    expect(r.code, r.err).to.equal(0);
    expect(r.out).to.match(/Mappings : 3\/3/);
  });
});
