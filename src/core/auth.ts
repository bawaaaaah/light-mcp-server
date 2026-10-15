/**
 * Authentication and roles (docs/architecture.md, "Authentification et rôles").
 *
 * - A master token (admin) for MCP clients and the CLI, as in wing-mcp-server.
 * - Roles with a PIN (v1): POST /api/auth/login { pin, role? } opens a session whose bearer token
 *   carries the role. Rights are checked by `can(credential, right)`. Failed PINs are limited per
 *   client address, since a short PIN would otherwise be guessed in seconds once exposed.
 * - Short-lived single-use WebSocket tickets (same contract as wing's AuthMiddleware, so the WS hub
 *   is reused unchanged).
 * Accounts and secret links/QR are planned later.
 */
import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import type { ConfigStore } from "./config-store.js";
import { HttpError } from "./http-errors.js";

export type AuthKind = "static" | "session";

/** A right is "<area>:<action>", e.g. "commands:panic", "dashboards:view", "show:write"; "*" = all. */
export const RoleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  pinHash: z.string().optional(),
  rights: z.array(z.string()).default([]),
  /** Dashboards this role sees; absent = all. */
  dashboards: z.array(z.string()).optional(),
});
export type Role = z.infer<typeof RoleSchema>;

const AuthStateSchema = z.object({ roles: z.array(RoleSchema) });
type AuthState = z.infer<typeof AuthStateSchema>;

export const DEFAULT_ROLES: Role[] = [
  { id: "admin", name: "Administrateur du lieu", rights: ["*"] },
  { id: "regisseur", name: "Régisseur", rights: ["commands:*", "show:write", "dashboards:*", "midi:*", "mcp:use"] },
  { id: "benevole", name: "Bénévole", rights: ["commands:trigger", "commands:panic", "commands:blackout", "dashboards:view"] },
  { id: "lecture", name: "Lecture seule", rights: ["dashboards:view"] },
];

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pin, salt, 32);
  return `scrypt:${salt.toString("base64url")}:${key.toString("base64url")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [scheme, salt, key] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = crypto.scryptSync(pin, Buffer.from(salt, "base64url"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function rightMatches(granted: string, wanted: string): boolean {
  if (granted === "*" || granted === wanted) return true;
  if (granted.endsWith(":*")) return wanted.startsWith(granted.slice(0, -1));
  return false;
}

export function tokensMatch(candidate: string | undefined, token: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Resolves (and persists) the master token: persisted, then MCP_AUTH_TOKEN, then generated. */
export async function resolveAuthToken(configStore: ConfigStore): Promise<string> {
  const existing = configStore.getServerAuthToken();
  if (existing) return existing;
  const token = process.env.MCP_AUTH_TOKEN || crypto.randomBytes(24).toString("base64url");
  await configStore.setServerAuthToken(token);
  return token;
}

/** Same contract as wing-mcp-server's AuthMiddleware (the WS hub depends on it), plus roles. */
export interface AuthMiddleware {
  requireAuth(): RequestHandler;
  requireRight(right: string): RequestHandler;
  isAuthorized(req: Request): boolean;
  authKind(req: Request): AuthKind | undefined;
  issueStreamTicket(credential: string): string;
  consumeStreamTicket(ticket: string): string | undefined;
  bearerOf(req: Pick<Request, "headers">): string | undefined;
  isValidCredential(candidate: string): boolean;
  roleOf(credential: string | undefined): Role | undefined;
  can(credential: string | undefined, right: string): boolean;
}

const STREAM_TICKET_TTL_MS = 30_000;
const SESSION_TTL_MS = 12 * 3600_000;
/** Wrong PINs allowed per client address within the window, before logins answer 429. */
const MAX_PIN_FAILURES = 5;
const PIN_FAILURE_WINDOW_MS = 60_000;

export class AuthService implements AuthMiddleware {
  private state: AuthState = { roles: DEFAULT_ROLES };
  private readonly sessions = new Map<string, { roleId: string; expiresAt: number }>();
  private readonly tickets = new Map<string, { credential: string; expiresAt: number }>();
  private readonly pinFailures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly masterToken: string,
    private readonly configStore?: ConfigStore,
    private readonly now: () => number = Date.now,
  ) {
    const parsed = AuthStateSchema.safeParse(configStore?.getAuthState());
    if (parsed.success) this.state = parsed.data;
  }

  roles(): Role[] {
    return this.state.roles.map(({ pinHash, ...r }) => ({ ...r, pinHash: pinHash ? "set" : undefined }));
  }

  async setPin(roleId: string, pin: string): Promise<void> {
    if (!/^\d{4,8}$/.test(pin)) throw new HttpError(400, "PIN: 4 à 8 chiffres");
    const role = this.state.roles.find((r) => r.id === roleId);
    if (!role) throw new HttpError(404, `rôle inconnu : ${roleId}`);
    if (this.state.roles.some((r) => r.id !== roleId && r.pinHash && verifyPin(pin, r.pinHash))) {
      throw new HttpError(409, "ce PIN est déjà utilisé par un autre rôle");
    }
    role.pinHash = hashPin(pin);
    await this.configStore?.setAuthState(this.state);
  }

  /** Roles that can log in with a PIN, for the login screen (no rights, no hash). */
  loginRoles(): { id: string; name: string }[] {
    return this.state.roles.filter((r) => r.pinHash).map((r) => ({ id: r.id, name: r.name }));
  }

  /**
   * Opens a session for the role whose PIN matches; with `roleId`, only that role is tried.
   * `client` (the caller's address) counts the wrong PINs: past MAX_PIN_FAILURES, 429 until the
   * window ends, even for the right PIN.
   */
  login(pin: string, roleId?: string, client = ""): { token: string; role: Role } {
    const now = this.now();
    for (const [c, e] of this.pinFailures) if (e.resetAt <= now) this.pinFailures.delete(c);
    const failures = this.pinFailures.get(client);
    if (failures && failures.count >= MAX_PIN_FAILURES) {
      throw new HttpError(429, `trop d'essais : réessayer dans ${Math.ceil((failures.resetAt - now) / 1000)} s`);
    }
    const role = this.state.roles.find((r) => (!roleId || r.id === roleId) && r.pinHash && verifyPin(pin, r.pinHash));
    if (!role) {
      const entry = this.pinFailures.get(client) ?? { count: 0, resetAt: now + PIN_FAILURE_WINDOW_MS };
      entry.count++;
      this.pinFailures.set(client, entry);
      throw new HttpError(401, "PIN incorrect");
    }
    this.pinFailures.delete(client);
    const token = crypto.randomBytes(24).toString("base64url");
    this.sessions.set(token, { roleId: role.id, expiresAt: this.now() + SESSION_TTL_MS });
    return { token, role };
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }

  bearerOf(req: Pick<Request, "headers">): string | undefined {
    const header = req.headers.authorization;
    return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  }

  roleOf(credential: string | undefined): Role | undefined {
    if (!credential) return undefined;
    if (tokensMatch(credential, this.masterToken)) return this.state.roles.find((r) => r.id === "admin") ?? DEFAULT_ROLES[0];
    const session = this.sessions.get(credential);
    if (!session) return undefined;
    if (session.expiresAt < this.now()) {
      this.sessions.delete(credential);
      return undefined;
    }
    return this.state.roles.find((r) => r.id === session.roleId);
  }

  can(credential: string | undefined, right: string): boolean {
    return this.roleOf(credential)?.rights.some((g) => rightMatches(g, right)) ?? false;
  }

  isValidCredential(candidate: string): boolean {
    return this.roleOf(candidate) !== undefined;
  }

  authKind(req: Request): AuthKind | undefined {
    const c = this.bearerOf(req);
    if (!c) return undefined;
    if (tokensMatch(c, this.masterToken)) return "static";
    return this.roleOf(c) ? "session" : undefined;
  }

  isAuthorized(req: Request): boolean {
    return this.authKind(req) !== undefined;
  }

  requireAuth(): RequestHandler {
    return (req: Request, _res: Response, next: NextFunction) => {
      if (!this.isAuthorized(req)) return next(new HttpError(401, "Unauthorized"));
      next();
    };
  }

  requireRight(right: string): RequestHandler {
    return (req: Request, _res: Response, next: NextFunction) => {
      const credential = this.bearerOf(req);
      if (!this.isValidCredential(credential ?? "")) return next(new HttpError(401, "Unauthorized"));
      if (!this.can(credential, right)) return next(new HttpError(403, `droit requis : ${right}`));
      next();
    };
  }

  issueStreamTicket(credential: string): string {
    const now = this.now();
    for (const [t, e] of this.tickets) if (e.expiresAt < now) this.tickets.delete(t);
    const ticket = crypto.randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { credential, expiresAt: now + STREAM_TICKET_TTL_MS });
    return ticket;
  }

  consumeStreamTicket(ticket: string): string | undefined {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return entry && entry.expiresAt >= this.now() ? entry.credential : undefined;
  }
}
