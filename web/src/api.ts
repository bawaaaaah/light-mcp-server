/** HTTP client: login and the command layer (POST /api/plugins/light/commands/:name). */
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";

export interface Role {
  id: string;
  /** The signed-in user's name (the role's for the master token). */
  name: string;
  /** The role's name. */
  role?: string;
  user?: { id: string; name: string };
  rights: string[];
  /** Dashboards this role sees; absent = all. */
  dashboards?: string[];
  /** "static": signed in with the master token (server.authToken); "session": with a PIN. */
  kind?: "static" | "session";
}

/** Same rule as the server's rightMatches (src/core/auth.ts): "*" and "area:*" grant wholesale. */
export function can(role: Role, right: string): boolean {
  return role.rights.some((g) => g === "*" || g === right || (g.endsWith(":*") && right.startsWith(g.slice(0, -1))));
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let token: string | null = null;
try {
  token = sessionStorage.getItem("token");
} catch {
  token = null;
}
/**
 * Links that sign in: `#token=<authToken>` (menu bar app) with the master token, and
 * `#user=<role>&pin=<PIN>` (share link, Settings) with a PIN. Read once, then wiped from the
 * address bar and its history entry. A fragment never reaches the server or its logs.
 */
const link = /^#(token|user|pin)=/.test(location.hash) ? new URLSearchParams(location.hash.slice(1)) : null;
if (link) history.replaceState(null, "", location.pathname + location.search);
const linkToken = link?.get("token");
const linkPin = link?.get("pin") ? { pin: link.get("pin")!, user: link.get("user") ?? undefined } : null;
if (linkToken) setToken(linkToken);
// Pasted into a tab already on the app, a link only changes the fragment: reload to read it.
window.addEventListener("hashchange", () => {
  if (/^#(token|user|pin)=/.test(location.hash)) location.reload();
});

/** A sign-in link for a user: anyone who opens it enters with that role (until the PIN changes). */
export function shareLink(base: string, user: string, pin: string): string {
  return `${base.replace(/\/$/, "")}/#${new URLSearchParams({ user, pin }).toString()}`;
}

export function getToken(): string | null {
  return token;
}

function setToken(t: string | null): void {
  token = t;
  try {
    if (t) sessionStorage.setItem("token", t);
    else sessionStorage.removeItem("token");
  } catch {
    /* storage unavailable: keep it in memory */
  }
}

const signedOutListeners = new Set<() => void>();
// The page's calls that ignore their errors would each report a refused session: it is handled
// once, by going back to the sign-in page (onSignedOut).
window.addEventListener("unhandledrejection", (e) => {
  if (e.reason instanceof ApiError && e.reason.status === 401) e.preventDefault();
});
/** Called when the server refuses this browser's session (revoked, expired, user disabled). */
export function onSignedOut(fn: () => void): () => void {
  signedOutListeners.add(fn);
  return () => signedOutListeners.delete(fn);
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  // A 401 on a signed-in call means the session is gone: back to the sign-in page, rather than
  // buttons that silently fail (a wrong PIN is a 401 too, but on the sign-in routes).
  if (res.status === 401 && token && !/\/api\/auth\/(login|passkeys\/login)/.test(res.url)) {
    setToken(null);
    for (const l of signedOutListeners) l();
  }
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

export async function login(pin: string, user?: string): Promise<Role> {
  const r = await json<{ token: string; role: Role }>(await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin, user }) }));
  setToken(r.token);
  return r.role;
}

/**
 * Hardware keys (YubiKey) and passkeys run only in a secure context bound to a hostname: localhost
 * or the public HTTPS address, never a LAN IP (where the PIN stays).
 */
export function keysUsableHere(): boolean {
  const host = location.hostname;
  return window.isSecureContext && !/^[\d.]+$/.test(host) && !host.startsWith("[") && browserSupportsWebAuthn();
}

/** Signs in with a hardware key: the browser offers the keys it holds for this address. */
export async function loginWithKey(): Promise<Role> {
  const optionsJSON = await json<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(await fetch("/api/auth/passkeys/login/options", { method: "POST" }));
  const response = await startAuthentication({ optionsJSON });
  const r = await json<{ token: string; role: Role }>(await fetch("/api/auth/passkeys/login/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response }) }));
  setToken(r.token);
  return r.role;
}

/** Logs in with the master token (server.authToken); resolves to null when it is refused. */
export async function loginWithToken(t: string): Promise<Role | null> {
  setToken(t);
  return me();
}

/** Who can sign in with a PIN, and whether hardware keys are registered at all. */
export async function loginUsers(): Promise<{ users: { id: string; name: string }[]; keys: boolean }> {
  return json(await fetch("/api/auth/login-users"));
}

/** Authenticated JSON call to the core API (users, keys, OAuth clients). */
export async function api<T = unknown>(route: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(route, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  return json<T>(res);
}

export interface UserRow {
  id: string;
  name: string;
  role: string;
  roleName: string;
  hasPin: boolean;
  disabled: boolean;
  keys: number;
}

export interface KeyRow {
  id: string;
  userId: string;
  name: string;
  rpId: string;
  createdAt: string;
  lastUsedAt?: string;
}

/** Registers a hardware key in this browser for a user (yourself, or anyone as administrator). */
export async function registerKey(user: string | undefined, name: string): Promise<KeyRow> {
  const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/passkeys/register/options", "POST", { user });
  const response = await startRegistration({ optionsJSON });
  return api<KeyRow>("/api/auth/passkeys/register/verify", "POST", { user, name, response });
}

/** On load: the PIN of a share link, else the stored session. Throws when the link's PIN is refused. */
export async function restoreSession(): Promise<Role | null> {
  if (linkPin) return login(linkPin.pin, linkPin.user);
  return me();
}

export async function serverInfo(): Promise<{ version: string; publicUrl: string | null; oauth?: boolean }> {
  return json(await fetch("/api/server", { headers: { authorization: `Bearer ${token}` } }));
}

export async function me(): Promise<Role | null> {
  if (!token) return null;
  try {
    return await json<Role>(await fetch("/api/auth/me", { headers: { authorization: `Bearer ${token}` } }));
  } catch {
    setToken(null);
    return null;
  }
}

/** Forgets the token here first, so leaving the page right away cannot sign back in. */
export async function logout(): Promise<void> {
  const old = token;
  setToken(null);
  if (old) await fetch("/api/auth/logout", { method: "POST", headers: { authorization: `Bearer ${old}` } }).catch(() => undefined);
}

export async function wsTicket(): Promise<string> {
  return (await json<{ ticket: string }>(await fetch("/api/auth/ws-ticket", { method: "POST", headers: { authorization: `Bearer ${token}` } }))).ticket;
}

export async function cmd<T = unknown>(name: string, args: unknown = {}): Promise<T> {
  const r = await json<{ ok: boolean; result: T }>(
    await fetch(`/api/plugins/light/commands/${name}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args) }),
  );
  return r.result;
}

export async function lightState(): Promise<{
  show?: { id: string; name: string };
  blackout: boolean;
  universes: number;
  discovery: string;
  standby?: boolean;
  foreignSources?: string[];
  /** Those of foreignSources on this very computer (another instance, QLC+). */
  foreignLocal?: string[];
  program?: string | null;
}> {
  return json(await fetch("/api/plugins/light/state", { headers: { authorization: `Bearer ${token}` } }));
}

/** Saves an authenticated download under the name the server gives (or `fallback`). */
async function saveDownload(route: string, fallback: string): Promise<void> {
  const res = await fetch(route, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({ error: res.statusText }))).error);
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallback;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadArchive(withVenue: boolean): Promise<void> {
  return saveDownload(`/api/plugins/light/archive?venue=${withVenue ? 1 : 0}`, "show.lightshow");
}

/** A backup kept on the server (data/backups). */
export function downloadBackup(file: string): Promise<void> {
  return saveDownload(`/api/plugins/light/backups/${encodeURIComponent(file)}`, file);
}

export interface FolderDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
}

/** What restoring this backup would change; nothing is written. */
export async function previewArchive(file: File): Promise<{ manifest: { show?: string; venue?: string; createdAt: string }; show: FolderDiff | null; venue: FolderDiff | null }> {
  return json(await fetch("/api/plugins/light/archive?dryRun=1", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: file }));
}

export async function restoreArchive(file: File): Promise<{ files: { show: number; venue: number }; backup: string }> {
  return json(await fetch("/api/plugins/light/archive", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: file }));
}
