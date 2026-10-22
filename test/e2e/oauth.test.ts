import { expect } from "chai";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, type Running } from "../../src/index.js";

/** A free port, so the public URL (the OAuth issuer) is known before the server starts. */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe("behind a reverse proxy: OAuth in front of /mcp (claude.ai connectors), PIN limit per client", function () {
  this.timeout(15000);
  let running: Running;
  let base: string;

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    const dir = mkdtempSync(join(tmpdir(), "light-oauth-"));
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ version: 1, server: { authToken: "master-token", publicUrl: base, trustProxy: 1 }, plugins: { light: { universes: 1, discovery: false, output: { routes: [] }, osc: { enabled: false }, os2l: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } } } }),
    );
    running = await bootstrap({ configPath: join(dir, "config.json"), port, host: "127.0.0.1", log: () => undefined, light: { dataRoot: join(dir, "data"), midiNative: null } });
    await running.auth.setPin("regisseur", "1234");
  });

  after(async () => {
    await running.stop();
  });

  const initialize = (token?: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
    });

  it("registers a client, approves it with the master token, and its own token opens /mcp only", async () => {
    const anonymous = await initialize();
    expect(anonymous.status).to.equal(401);
    expect(anonymous.headers.get("www-authenticate")).to.match(/resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/);

    const registered = (await (
      await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test AI", redirect_uris: ["http://localhost/callback"], token_endpoint_auth_method: "none" }) })
    ).json()) as { client_id: string };
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const authorize = await fetch(
      `${base}/authorize?${new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: "http://localhost/callback", code_challenge: challenge, code_challenge_method: "S256", state: "s1" })}`,
      { redirect: "manual" },
    );
    expect(authorize.status).to.equal(302);
    const requestId = new URL(authorize.headers.get("location")!, base).searchParams.get("request_id")!;
    const page = await (await fetch(`${base}/oauth/approve?request_id=${requestId}`)).text();
    expect(page).to.include("Test AI").and.include("http://localhost/callback");

    const wrong = await fetch(`${base}/oauth/approve`, { method: "POST", body: new URLSearchParams({ request_id: requestId, token: "nope" }), redirect: "manual" });
    expect(wrong.status).to.equal(401);
    const approved = await fetch(`${base}/oauth/approve`, { method: "POST", body: new URLSearchParams({ request_id: requestId, token: "master-token" }), redirect: "manual" });
    expect(approved.status).to.equal(302);
    const back = new URL(approved.headers.get("location")!);
    expect(back.searchParams.get("state")).to.equal("s1");

    const tokens = (await (
      await fetch(`${base}/token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: registered.client_id, redirect_uri: "http://localhost/callback" }),
      })
    ).json()) as { access_token: string; refresh_token: string };
    expect(tokens.access_token).to.match(/^lmcp_at_/);
    expect((await initialize(tokens.access_token)).status).to.equal(200);
    // good for /mcp only: not the web UI's API
    expect((await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).to.equal(401);

    // the administrator sees the client and can cut it off
    const clients = (await (await fetch(`${base}/api/auth/oauth/clients`, { headers: { authorization: "Bearer master-token" } })).json()) as { clientId: string; activeGrants: number; approvedBy: string[] }[];
    expect(clients).to.have.length(1);
    expect(clients[0]).to.deep.include({ activeGrants: 1, approvedBy: [""] });
    expect((await fetch(`${base}/api/auth/oauth/clients/${registered.client_id}`, { method: "DELETE", headers: { authorization: "Bearer master-token" } })).status).to.equal(204);
    expect((await initialize(tokens.access_token)).status).to.equal(401);
  });

  it("limits wrong PINs per client behind the proxy (X-Forwarded-For), not for everyone at once", async () => {
    const tryPin = (pin: string, client: string) =>
      fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": client }, body: JSON.stringify({ pin }) });
    for (let i = 0; i < 5; i++) expect((await tryPin("0000", "203.0.113.7")).status).to.equal(401);
    expect((await tryPin("1234", "203.0.113.7")).status).to.equal(429);
    expect((await tryPin("1234", "198.51.100.2")).status).to.equal(200); // another client is not locked out
  });
});
