// Adapted from wing-mcp-server (MIT, https://github.com/bawaaaaah/wing-mcp-server), src/core/oauth.ts:
// here a grant also remembers who approved it (a user's hardware key, or the master token), and its
// tokens carry that user's role (core/auth.ts, setTokenResolver), on /mcp only.
import crypto from "node:crypto";
import type { Response } from "express";
import express from "express";
import { z } from "zod";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { AuthService } from "./auth.js";
import { bodyField, bodyString } from "./http-body.js";
import type { ConfigStore } from "./config-store.js";
import { PasskeyError, type PasskeyService } from "./passkeys.js";

/**
 * What an OAuth client gets is its own pair of opaque tokens — never the master token: a short-lived
 * access token and a refresh token rotated on every use, stored only as SHA-256 hashes, valid on
 * /mcp alone, revocable per client from the AI connection page or through RFC 7009 /revoke.
 */
const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_GRANTS_PER_CLIENT = 10;
const ACCESS_TOKEN_PREFIX = "lmcp_at_";
const REFRESH_TOKEN_PREFIX = "lmcp_rt_";
// /register and /authorize are reachable before signing in: abandoned flows must not grow forever.
const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const CLIENTS_STORE_MAX_SIZE = 1000;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Registered clients, persisted so a restart does not disconnect claude.ai's connector. */
class ClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  constructor(
    private readonly configStore?: ConfigStore,
    private readonly onEvicted?: (clientId: string) => void,
  ) {
    for (const [clientId, client] of Object.entries(configStore?.getOAuthClients() ?? {})) this.clients.set(clientId, client as OAuthClientInformationFull);
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  list(): OAuthClientInformationFull[] {
    return [...this.clients.values()];
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    if (this.clients.size >= CLIENTS_STORE_MAX_SIZE) {
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) {
        this.clients.delete(oldest);
        this.onEvicted?.(oldest);
      }
    }
    this.clients.set(client.client_id, client);
    await this.persist();
    return client;
  }

  async remove(clientId: string): Promise<boolean> {
    if (!this.clients.delete(clientId)) return false;
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    await this.configStore?.setOAuthClients(Object.fromEntries(this.clients));
  }
}

const storedTokenSchema = z.object({
  hash: z.string(),
  kind: z.enum(["access", "refresh"]),
  clientId: z.string(),
  /** Ties an access token to the refresh token of the same grant, so one revocation ends both. */
  grantId: z.string(),
  /** Who approved the grant: a user (their role applies); absent = the master token (administrator). */
  userId: z.string().optional(),
  scopes: z.array(z.string()),
  resource: z.string().optional(),
  createdAt: z.number(),
  expiresAt: z.number(),
});
type StoredToken = z.infer<typeof storedTokenSchema>;

/** Issued tokens, by hash; persisted so a restart neither logs every client out nor resurrects a revoked one. */
class TokenStore {
  private readonly tokens = new Map<string, StoredToken>();

  constructor(private readonly configStore?: ConfigStore) {
    const raw = configStore?.getOAuthTokens();
    if (!Array.isArray(raw)) return;
    const now = Date.now();
    for (const entry of raw) {
      const parsed = storedTokenSchema.safeParse(entry);
      if (!parsed.success) console.error("Ignoring a malformed persisted OAuth token:", parsed.error.message);
      else if (parsed.data.expiresAt > now) this.tokens.set(parsed.data.hash, parsed.data);
    }
  }

  async issue(clientId: string, userId: string | undefined, scopes: string[], resource: string | undefined): Promise<OAuthTokens> {
    this.sweep();
    this.enforceGrantLimit(clientId);
    const grantId = crypto.randomUUID();
    const now = Date.now();
    const accessToken = ACCESS_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
    const refreshToken = REFRESH_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
    const common = { clientId, grantId, ...(userId ? { userId } : {}), scopes, ...(resource ? { resource } : {}), createdAt: now };
    this.tokens.set(hashToken(accessToken), { ...common, hash: hashToken(accessToken), kind: "access", expiresAt: now + ACCESS_TOKEN_TTL_MS });
    this.tokens.set(hashToken(refreshToken), { ...common, hash: hashToken(refreshToken), kind: "refresh", expiresAt: now + REFRESH_TOKEN_TTL_MS });
    await this.persist();
    return { access_token: accessToken, token_type: "bearer", expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), refresh_token: refreshToken, scope: scopes.join(" ") };
  }

  /** Synchronous: runs on every /mcp request. */
  findValid(token: string, kind: StoredToken["kind"]): StoredToken | undefined {
    const stored = this.tokens.get(hashToken(token));
    return stored && stored.kind === kind && Date.now() <= stored.expiresAt ? stored : undefined;
  }

  async revokeGrant(grantId: string): Promise<void> {
    let changed = false;
    for (const [hash, stored] of this.tokens) {
      if (stored.grantId === grantId) {
        this.tokens.delete(hash);
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  async revokeClient(clientId: string): Promise<number> {
    let removed = 0;
    for (const [hash, stored] of this.tokens) {
      if (stored.clientId === clientId) {
        this.tokens.delete(hash);
        removed += 1;
      }
    }
    if (removed > 0) await this.persist();
    return removed;
  }

  summarize(clientId: string): { activeGrants: number; lastIssuedAt: number | null; users: string[] } {
    const grants = new Set<string>();
    const users = new Set<string>();
    let lastIssuedAt: number | null = null;
    const now = Date.now();
    for (const stored of this.tokens.values()) {
      if (stored.clientId !== clientId || now > stored.expiresAt) continue;
      grants.add(stored.grantId);
      users.add(stored.userId ?? "");
      lastIssuedAt = Math.max(lastIssuedAt ?? 0, stored.createdAt);
    }
    return { activeGrants: grants.size, lastIssuedAt, users: [...users] };
  }

  sweep(): void {
    const now = Date.now();
    for (const [hash, stored] of this.tokens) if (now > stored.expiresAt) this.tokens.delete(hash);
  }

  private enforceGrantLimit(clientId: string): void {
    const grants = new Map<string, number>();
    for (const stored of this.tokens.values()) if (stored.clientId === clientId) grants.set(stored.grantId, stored.createdAt);
    const oldestFirst = [...grants.entries()].sort((a, b) => a[1] - b[1]);
    for (const [grantId] of oldestFirst.slice(0, Math.max(0, oldestFirst.length - MAX_GRANTS_PER_CLIENT + 1))) {
      for (const [hash, stored] of this.tokens) if (stored.grantId === grantId) this.tokens.delete(hash);
    }
  }

  private async persist(): Promise<void> {
    await this.configStore?.setOAuthTokens([...this.tokens.values()]);
  }
}

interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
}

interface IssuedCode {
  clientId: string;
  userId?: string;
  params: AuthorizationParams;
  createdAt: number;
}

/** What the AI connection page shows of a registered client. Never a secret or a token. */
export interface OAuthClientSummary {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  registeredAt: string | null;
  activeGrants: number;
  lastTokenIssuedAt: string | null;
  /** Users who approved its grants ("" = the master token). */
  approvedBy: string[];
}

/**
 * A minimal OAuth 2.1 authorization server in front of /mcp, for the clients (claude.ai's remote
 * connectors) that require an OAuth flow and refuse a pasted token. The user approves a client once,
 * with the master token or a hardware key, on the approval page below; the client then holds
 * tokens of its own, good for /mcp only, with the rights of whoever approved.
 */
export class LightOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: ClientsStore;
  private readonly tokens: TokenStore;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, IssuedCode>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    /** The master token, read when needed: it can be renewed while the server runs. */
    private readonly isMasterToken: (token: string) => boolean,
    configStore?: ConfigStore,
  ) {
    this.tokens = new TokenStore(configStore);
    this.clientsStore = new ClientsStore(configStore, (clientId) => {
      void this.tokens.revokeClient(clientId).catch((err: unknown) => console.error("Failed to revoke the tokens of an evicted OAuth client:", err));
    });
    this.sweepTimer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  close(): void {
    clearInterval(this.sweepTimer);
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) if (now - entry.createdAt > PENDING_TTL_MS) this.pending.delete(id);
    for (const [code, entry] of this.codes) if (now - entry.createdAt > CODE_TTL_MS) this.codes.delete(code);
    this.tokens.sweep();
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const requestId = crypto.randomUUID();
    this.pending.set(requestId, { client, params, createdAt: Date.now() });
    res.redirect(302, "/oauth/approve?request_id=" + encodeURIComponent(requestId));
  }

  private findCode(client: OAuthClientInformationFull, authorizationCode: string): IssuedCode {
    const issued = this.codes.get(authorizationCode);
    if (!issued || issued.clientId !== client.client_id || Date.now() - issued.createdAt > CODE_TTL_MS) throw new InvalidGrantError("Invalid authorization code");
    return issued;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.findCode(client, authorizationCode).params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const issued = this.findCode(client, authorizationCode);
    // RFC 6749 §4.1.3: a redirect_uri sent to /token must be the one the code was issued for.
    if (redirectUri !== undefined && redirectUri !== issued.params.redirectUri) throw new InvalidGrantError("redirect_uri does not match the one this code was issued for");
    this.codes.delete(authorizationCode);
    return this.tokens.issue(client.client_id, issued.userId, issued.params.scopes ?? [], issued.params.resource?.href);
  }

  /** Rotating: the refresh token presented is spent, and the whole grant is replaced. */
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const stored = this.tokens.findValid(refreshToken, "refresh");
    if (!stored || stored.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    const granted = scopes?.length ? scopes.filter((s) => stored.scopes.includes(s)) : stored.scopes;
    await this.tokens.revokeGrant(stored.grantId);
    return this.tokens.issue(client.client_id, stored.userId, granted, stored.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.isMasterToken(token)) return { token, clientId: "static-token", scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    const stored = this.grantOf(token);
    if (!stored) throw new InvalidTokenError("Invalid token");
    return { token, clientId: stored.clientId, scopes: stored.scopes, expiresAt: Math.floor(stored.expiresAt / 1000), ...(stored.resource ? { resource: new URL(stored.resource) } : {}) };
  }

  /** A valid access token of a still registered client: its grant (and who approved it). */
  grantOf(token: string): { clientId: string; userId?: string; scopes: string[]; expiresAt: number; resource?: string } | undefined {
    const stored = this.tokens.findValid(token, "access");
    return stored && this.clientsStore.getClient(stored.clientId) ? stored : undefined;
  }

  /** RFC 7009. Unknown or foreign tokens are ignored, as the RFC requires. */
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const stored = this.tokens.findValid(request.token, "access") ?? this.tokens.findValid(request.token, "refresh");
    if (stored && stored.clientId === client.client_id) await this.tokens.revokeGrant(stored.grantId);
  }

  listClients(): OAuthClientSummary[] {
    return this.clientsStore.list().map((client) => {
      const { activeGrants, lastIssuedAt, users } = this.tokens.summarize(client.client_id);
      return {
        clientId: client.client_id,
        clientName: client.client_name,
        redirectUris: client.redirect_uris.map(String),
        registeredAt: client.client_id_issued_at ? new Date(client.client_id_issued_at * 1000).toISOString() : null,
        activeGrants,
        lastTokenIssuedAt: lastIssuedAt === null ? null : new Date(lastIssuedAt).toISOString(),
        approvedBy: users,
      };
    });
  }

  /** Forgets the client and every token it holds; it has to register and be approved again. */
  async revokeClient(clientId: string): Promise<boolean> {
    for (const [code, issued] of this.codes) if (issued.clientId === clientId) this.codes.delete(code);
    for (const [id, pending] of this.pending) if (pending.client.client_id === clientId) this.pending.delete(id);
    await this.tokens.revokeClient(clientId);
    return this.clientsStore.remove(clientId);
  }

  resolvePending(requestId: string): PendingAuthorization | undefined {
    const pending = this.pending.get(requestId);
    return pending && Date.now() - pending.createdAt <= PENDING_TTL_MS ? pending : undefined;
  }

  /** Turns a pending authorization into a one-time code; returns the client's redirect target. */
  approve(requestId: string, userId?: string): string | undefined {
    const pending = this.resolvePending(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    const code = crypto.randomUUID();
    this.codes.set(code, { clientId: pending.client.client_id, userId, params: pending.params, createdAt: Date.now() });
    const target = new URL(pending.params.redirectUri);
    target.searchParams.set("code", code);
    if (pending.params.state !== undefined) target.searchParams.set("state", pending.params.state);
    return target.href;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? "&#39;");
}

// Inline rather than bundled: this page is served by the server itself, outside the web app. It turns
// the JSON options of /api/auth/passkeys/login/options into what navigator.credentials.get() takes.
const PASSKEY_APPROVAL_SCRIPT = `(() => {
  const section = document.getElementById("passkey");
  if (!section || !window.PublicKeyCredential) return;
  section.hidden = false;
  const button = document.getElementById("passkey-button");
  const errorEl = document.getElementById("passkey-error");
  const toBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer;
  const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  const readError = async (res, fallback) => { try { return (await res.json()).error || fallback; } catch { return fallback; } };
  button.addEventListener("click", async () => {
    button.disabled = true;
    errorEl.textContent = "";
    try {
      const optionsRes = await fetch("/api/auth/passkeys/login/options", { method: "POST" });
      if (!optionsRes.ok) throw new Error(await readError(optionsRes, "Clé indisponible."));
      const options = await optionsRes.json();
      const credential = await navigator.credentials.get({ publicKey: { challenge: toBuf(options.challenge), rpId: options.rpId, timeout: options.timeout, userVerification: options.userVerification, allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })) } });
      const r = credential.response;
      const verifyRes = await fetch("/oauth/approve/passkey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: section.dataset.requestId, response: { id: credential.id, rawId: toB64u(credential.rawId), type: credential.type, clientExtensionResults: credential.getClientExtensionResults(), authenticatorAttachment: credential.authenticatorAttachment || undefined, response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature), userHandle: r.userHandle ? toB64u(r.userHandle) : undefined } } }),
      });
      if (!verifyRes.ok) throw new Error(await readError(verifyRes, "Clé refusée."));
      window.location.href = (await verifyRes.json()).redirectTo;
    } catch (err) {
      errorEl.textContent = err && err.name === "NotAllowedError" ? "Clé annulée ou refusée." : String((err && err.message) || err);
      button.disabled = false;
    }
  });
})();`;

function renderApprovalPage(opts: { requestId: string; clientName: string; redirectUri: string; error?: string; passkeysAvailable?: boolean }): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autoriser l'accès</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 10vh auto; padding: 0 1.5rem; color: #1a1a1a; }
  input { width: 100%; padding: .6rem; font-size: 1rem; box-sizing: border-box; margin: .5rem 0; }
  button { width: 100%; padding: .6rem; font-size: 1rem; background: #111; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .error { color: #b00020; font-size: .9rem; }
  .separator { text-align: center; color: #666; font-size: .9rem; margin: 1.25rem 0 .5rem; }
  .target { background: #f4f4f5; border: 1px solid #e0e0e2; border-radius: 4px; padding: .6rem .75rem; margin: 1rem 0; }
  .target dt { color: #666; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  .target dd { margin: .15rem 0 0; font-family: ui-monospace, monospace; font-size: .9rem; word-break: break-all; }
</style>
</head>
<body>
  <h2>Autoriser l'accès</h2>
  <p><strong>${escapeHtml(opts.clientName)}</strong> demande à piloter la lumière par ce serveur Light MCP.</p>
  <!-- The name above is whatever the client called itself at registration: it identifies nothing.
       The redirect target says where the access is really going, so it is shown. -->
  <dl class="target">
    <dt>L'autorisation sera envoyée à</dt>
    <dd>${escapeHtml(opts.redirectUri)}</dd>
  </dl>
  <p>N'autoriser que si c'est bien l'adresse du client que vous connectez en ce moment. Il recevra ses propres jetons pour le MCP, avec les droits de qui l'autorise, révocables depuis la page « Connexion IA ».</p>
  ${opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ""}
  ${
    opts.passkeysAvailable
      ? `<div id="passkey" data-request-id="${escapeHtml(opts.requestId)}" hidden>
    <button type="button" id="passkey-button">Autoriser avec une clé de sécurité</button>
    <p class="error" id="passkey-error" role="alert"></p>
    <p class="separator">ou avec le jeton d'authentification du serveur</p>
  </div>`
      : ""
  }
  <form method="POST" action="/oauth/approve">
    <input type="hidden" name="request_id" value="${escapeHtml(opts.requestId)}">
    <input type="password" name="token" placeholder="Jeton d'authentification" autofocus required>
    <button type="submit">Autoriser</button>
  </form>
  ${opts.passkeysAvailable ? `<script>${PASSKEY_APPROVAL_SCRIPT}</script>` : ""}
</body>
</html>`;
}

export interface OAuthIntegration {
  provider: LightOAuthProvider;
  router: express.Router;
  /** For the WWW-Authenticate: Bearer resource_metadata="…" header on 401s from /mcp (discovery). */
  resourceMetadataUrl: string;
}

/**
 * The OAuth server in front of /mcp, next to the master token and sessions sent as Bearer. Needs the
 * public address (server.publicUrl, HTTPS except on localhost). Its tokens resolve through the auth
 * service to the role of whoever approved; a hardware key approves only for a user with `mcp:use`.
 */
export function createOAuthIntegration(publicUrl: URL, auth: AuthService, configStore?: ConfigStore, passkeys?: PasskeyService): OAuthIntegration {
  const provider = new LightOAuthProvider((token) => auth.isMasterToken(token), configStore);
  auth.setTokenResolver((token) => {
    const grant = provider.grantOf(token);
    return grant ? { userId: grant.userId } : undefined;
  });
  const resourceServerUrl = new URL("/mcp", publicUrl);
  const router = express.Router();
  router.use(mcpAuthRouter({ provider, issuerUrl: new URL(publicUrl.origin), resourceServerUrl, resourceName: "Light MCP" }));
  const passkeysAvailable = (): boolean => passkeys?.hasPasskeys() ?? false;
  const page = (requestId: string, pending: PendingAuthorization, error?: string) =>
    renderApprovalPage({ requestId, clientName: pending.client.client_name ?? pending.client.client_id, redirectUri: pending.params.redirectUri, error, passkeysAvailable: passkeysAvailable() });

  router.get("/oauth/approve", (req, res) => {
    const requestId = typeof req.query.request_id === "string" ? req.query.request_id : undefined;
    const pending = requestId ? provider.resolvePending(requestId) : undefined;
    if (!requestId || !pending) {
      res.status(400).send("Demande d'autorisation invalide ou expirée.");
      return;
    }
    res.status(200).type("html").send(page(requestId, pending));
  });

  // The hardware-key counterpart of the token form below; JSON, since the page's script calls it.
  router.post("/oauth/approve/passkey", express.json(), async (req, res, next) => {
    const requestId = bodyString(req.body, "request_id");
    if (!requestId || !provider.resolvePending(requestId)) {
      res.status(400).json({ error: "Demande d'autorisation invalide ou expirée." });
      return;
    }
    const rp = passkeys?.relyingPartyFor(req);
    if (!passkeys || !rp) {
      res.status(400).json({ error: "Clés indisponibles depuis cette adresse." });
      return;
    }
    let userId: string;
    try {
      userId = (await passkeys.authenticate(rp, bodyField(req.body, "response") as AuthenticationResponseJSON)).userId;
    } catch (err) {
      if (err instanceof PasskeyError) {
        res.status(401).json({ error: "Clé refusée : " + err.message });
        return;
      }
      next(err);
      return;
    }
    if (!auth.userCan(userId, "mcp:use")) {
      res.status(403).json({ error: "Cet utilisateur n'a pas accès au MCP (droit mcp:use)." });
      return;
    }
    const redirectTo = provider.approve(requestId, userId);
    if (!redirectTo) {
      res.status(400).json({ error: "Demande d'autorisation invalide ou expirée." });
      return;
    }
    res.json({ redirectTo });
  });

  router.post("/oauth/approve", express.urlencoded({ extended: false }), (req, res) => {
    const requestId = bodyString(req.body, "request_id");
    const pending = requestId ? provider.resolvePending(requestId) : undefined;
    if (!requestId || !pending) {
      res.status(400).send("Demande d'autorisation invalide ou expirée.");
      return;
    }
    if (!auth.isMasterToken(bodyString(req.body, "token"))) {
      res.status(401).type("html").send(page(requestId, pending, "Jeton incorrect."));
      return;
    }
    const redirectTo = provider.approve(requestId);
    if (!redirectTo) {
      res.status(400).send("Demande d'autorisation invalide ou expirée.");
      return;
    }
    res.redirect(302, redirectTo);
  });

  return { provider, router, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl) };
}
