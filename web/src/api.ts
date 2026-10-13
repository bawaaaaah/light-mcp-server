/** HTTP client: login and the command layer (POST /api/plugins/light/commands/:name). */

export interface Role {
  id: string;
  name: string;
  rights: string[];
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

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

export async function login(pin: string): Promise<Role> {
  const r = await json<{ token: string; role: Role }>(await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) }));
  setToken(r.token);
  return r.role;
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

export async function logout(): Promise<void> {
  if (token) await fetch("/api/auth/logout", { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
  setToken(null);
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

export async function lightState(): Promise<{ blackout: boolean; universes: number; discovery: string }> {
  return json(await fetch("/api/plugins/light/state", { headers: { authorization: `Bearer ${token}` } }));
}
