/**
 * Authentication and roles (docs/architecture.md, "Authentification et rôles").
 *
 * - A master token (admin) for MCP clients and the CLI, as in wing-mcp-server.
 * - Roles carry the rights; named users each have a role, a PIN and/or hardware keys (passkeys,
 *   core/passkeys.ts). POST /api/auth/login { pin, user? } opens a session whose bearer token
 *   carries the user, hence the role. Rights are checked by `can(credential, right)`. Failed PINs
 *   are limited per client address, since a short PIN would otherwise be guessed in seconds once
 *   exposed. Users came after per-role PINs: those become one user per role on load.
 * - Tokens from elsewhere (OAuth, core/oauth.ts) resolve through `setTokenResolver`, valid on /mcp only.
 * - Short-lived single-use WebSocket tickets (same contract as wing's AuthMiddleware, so the WS hub
 *   is reused unchanged).
 */
import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import type { ConfigStore } from "./config-store.js";
import { HttpError } from "./http-errors.js";
import { say } from "./lang.js";

export type AuthKind = "static" | "session" | "oauth";

/** A right is "<area>:<action>", e.g. "commands:panic", "dashboards:view", "show:write"; "*" = all. */
export const RoleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  /** Before users existed, a role had its own PIN: read once and moved to a user of that role. */
  pinHash: z.string().optional(),
  rights: z.array(z.string()).default([]),
  /** Dashboards this role sees; absent = all. */
  dashboards: z.array(z.string()).optional(),
});
export type Role = z.infer<typeof RoleSchema>;

export const UserSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().min(1),
  role: z.string(),
  pinHash: z.string().optional(),
  disabled: z.boolean().default(false),
});
export type User = z.infer<typeof UserSchema>;

/** What the UI and the API see of a user: never the PIN hash. */
export interface UserSummary {
  id: string;
  name: string;
  role: string;
  roleName: string;
  hasPin: boolean;
  disabled: boolean;
}

/** What a client sees once signed in: the user's name (the role's for the master token), the role, its rights. */
export function signedInView(role: Role, user?: UserSummary): { id: string; name: string; role: string; rights: string[]; dashboards?: string[]; user?: { id: string; name: string } } {
  return { id: role.id, name: user?.name ?? role.name, role: role.name, rights: role.rights, dashboards: role.dashboards, user: user ? { id: user.id, name: user.name } : undefined };
}

const AuthStateSchema = z.object({ roles: z.array(RoleSchema), users: z.array(UserSchema).default([]) });
type AuthState = z.infer<typeof AuthStateSchema>;

const PIN_RE = /^\d{4,8}$/;

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

/** Rights that come with another: whoever may change the show may propose a change to it. */
const IMPLIED: Record<string, string> = { "show:propose": "show:write" };

export function rightMatches(granted: string, wanted: string): boolean {
  if (granted === "*" || granted === wanted) return true;
  if (granted.endsWith(":*")) return wanted.startsWith(granted.slice(0, -1));
  return IMPLIED[wanted] !== undefined && rightMatches(granted, IMPLIED[wanted]);
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
  /** Who a credential is, as people read it: the user's name, or what kind of key it is. */
  nameOf(credential: string | undefined): string | undefined;
}

const STREAM_TICKET_TTL_MS = 30_000;
/** A session left unused this long ends; one in use is extended (see `sessionOf`). */
const SESSION_TTL_MS = 12 * 3600_000;
const SessionSchema = z.object({ hash: z.string(), userId: z.string(), expiresAt: z.number() });

/** Sessions are kept by hash: the stored copy (config file) holds no usable token. */
const hashToken = (token: string) => crypto.createHash("sha256").update(token, "utf8").digest("hex");
/** Wrong PINs allowed per client address within the window, before logins answer 429. */
const MAX_PIN_FAILURES = 5;
const PIN_FAILURE_WINDOW_MS = 60_000;

export class AuthService implements AuthMiddleware {
  // a copy: the state is edited in place, the built-in roles must stay as they are
  private state: AuthState = { roles: DEFAULT_ROLES.map((r) => ({ ...r, rights: [...r.rights] })), users: [] };
  /** By token hash; persisted, so a server restart signs no tablet out in the middle of a service. */
  private readonly sessions = new Map<string, { userId: string; expiresAt: number }>();
  private resolveToken: ((token: string) => { userId?: string } | undefined) | undefined;
  private readonly tickets = new Map<string, { credential: string; expiresAt: number }>();
  private readonly pinFailures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly masterToken: string,
    private readonly configStore?: ConfigStore,
    private readonly now: () => number = Date.now,
  ) {
    const parsed = AuthStateSchema.safeParse(configStore?.getAuthState());
    if (parsed.success) this.state = parsed.data;
    // The built-in roles are always there (a stored list once came back empty, leaving no role to
    // give a user), and the administrator keeps every right whatever was stored.
    for (const role of DEFAULT_ROLES) if (!this.state.roles.some((r) => r.id === role.id)) this.state.roles.push({ ...role, rights: [...role.rights] });
    const admin = this.state.roles.find((r) => r.id === "admin")!;
    if (!admin.rights.includes("*")) admin.rights = ["*"];
    const stored = configStore?.getAuthSessions();
    for (const entry of Array.isArray(stored) ? stored : []) {
      const parsed = SessionSchema.safeParse(entry);
      if (parsed.success && parsed.data.expiresAt > this.now()) this.sessions.set(parsed.data.hash, { userId: parsed.data.userId, expiresAt: parsed.data.expiresAt });
    }
    // per-role PINs (before users): one user per role, same id, name and PIN
    for (const role of this.state.roles) {
      if (!role.pinHash) continue;
      if (!this.state.users.some((u) => u.id === role.id)) this.state.users.push({ id: role.id, name: role.name, role: role.id, pinHash: role.pinHash, disabled: false });
      delete role.pinHash;
    }
  }

  roles(): Role[] {
    return this.state.roles.map(({ pinHash: _, ...r }) => r);
  }

  /** A right: "*", "<area>:*" or "<area>:<action>". */
  private checkRights(rights: string[]): string[] {
    const bad = rights.find((r) => !/^(\*|[a-z]+:(\*|[a-z-]+))$/.test(r));
    if (bad) throw new HttpError(400, say(`droit invalide : ${bad}`, `invalid right: ${bad}`));
    return [...new Set(rights)];
  }

  async addRole(input: { name: string; rights: string[]; dashboards?: string[] }): Promise<Role> {
    if (!input.name.trim()) throw new HttpError(400, say("nom requis", "name required"));
    const base = input.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "role";
    let id = base;
    for (let i = 2; this.state.roles.some((r) => r.id === id); i++) id = `${base}-${i}`;
    const role: Role = { id, name: input.name.trim(), rights: this.checkRights(input.rights), dashboards: input.dashboards?.length ? input.dashboards : undefined };
    this.state.roles.push(role);
    await this.save();
    return role;
  }

  /** The administrator keeps every right: only its name changes. */
  async updateRole(id: string, patch: { name?: string; rights?: string[]; dashboards?: string[] | null }): Promise<Role> {
    const role = this.role(id);
    if (patch.name !== undefined && patch.name.trim()) role.name = patch.name.trim();
    if (patch.rights !== undefined && role.id !== "admin") role.rights = this.checkRights(patch.rights);
    if (patch.dashboards !== undefined) role.dashboards = patch.dashboards?.length ? patch.dashboards : undefined;
    await this.save();
    return role;
  }

  /** Built-in roles stay; a role still given to a user cannot go. */
  async deleteRole(id: string): Promise<void> {
    this.role(id);
    if (DEFAULT_ROLES.some((r) => r.id === id)) throw new HttpError(400, say("un rôle de base ne se supprime pas", "a built-in role cannot be deleted"));
    const users = this.state.users.filter((u) => u.role === id).map((u) => u.name);
    if (users.length) throw new HttpError(409, say(`rôle encore donné à : ${users.join(", ")}`, `role still given to: ${users.join(", ")}`));
    this.state.roles = this.state.roles.filter((r) => r.id !== id);
    await this.save();
  }

  /** OAuth (or any other issuer) tokens: resolved to a user (or to the administrator), on /mcp only. */
  setTokenResolver(fn: (token: string) => { userId?: string } | undefined): void {
    this.resolveToken = fn;
  }

  private role(id: string): Role {
    const role = this.state.roles.find((r) => r.id === id);
    if (!role) throw new HttpError(400, say(`rôle inconnu : ${id}`, `unknown role: ${id}`));
    return role;
  }

  private user(id: string): User {
    const user = this.state.users.find((u) => u.id === id);
    if (!user) throw new HttpError(404, say(`utilisateur inconnu : ${id}`, `unknown user: ${id}`));
    return user;
  }

  private summary(u: User): UserSummary {
    return { id: u.id, name: u.name, role: u.role, roleName: this.state.roles.find((r) => r.id === u.role)?.name ?? u.role, hasPin: Boolean(u.pinHash), disabled: u.disabled };
  }

  private save(): Promise<void> {
    return this.configStore?.setAuthState(this.state) ?? Promise.resolve();
  }

  users(): UserSummary[] {
    return this.state.users.map((u) => this.summary(u));
  }

  userById(id: string): UserSummary | undefined {
    const u = this.state.users.find((x) => x.id === id);
    return u && this.summary(u);
  }

  /** A PIN is unique among users, so a PIN alone (no user picked) still finds its user. */
  private checkPin(pin: string, exceptUser: string): string {
    if (!PIN_RE.test(pin)) throw new HttpError(400, say("PIN : 4 à 8 chiffres", "PIN: 4 to 8 digits"));
    if (this.state.users.some((u) => u.id !== exceptUser && u.pinHash && verifyPin(pin, u.pinHash))) {
      throw new HttpError(409, say("ce PIN est déjà celui d'un autre utilisateur", "this PIN already belongs to another user"));
    }
    return hashPin(pin);
  }

  async addUser(input: { name: string; role: string; pin?: string; id?: string }): Promise<UserSummary> {
    this.role(input.role);
    const base = (input.id ?? input.name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "utilisateur";
    let id = base;
    for (let i = 2; this.state.users.some((u) => u.id === id); i++) id = `${base}-${i}`;
    const user: User = UserSchema.parse({ id, name: input.name.trim(), role: input.role });
    if (input.pin) user.pinHash = this.checkPin(input.pin, id);
    this.state.users.push(user);
    await this.save();
    return this.summary(user);
  }

  async updateUser(id: string, patch: { name?: string; role?: string; disabled?: boolean }): Promise<UserSummary> {
    const user = this.user(id);
    if (patch.role !== undefined) user.role = this.role(patch.role).id;
    if (patch.name !== undefined && patch.name.trim()) user.name = patch.name.trim();
    if (patch.disabled !== undefined) user.disabled = patch.disabled;
    if (user.disabled) this.closeSessions(id);
    await this.save();
    return this.summary(user);
  }

  async deleteUser(id: string): Promise<void> {
    this.user(id);
    this.state.users = this.state.users.filter((u) => u.id !== id);
    this.closeSessions(id);
    await this.save();
  }

  /** Sets (or with null removes) a user's PIN. For a role id without its user yet, creates that user (CLI `light pin`). */
  async setPin(userId: string, pin: string | null): Promise<void> {
    let user = this.state.users.find((u) => u.id === userId);
    if (!user) {
      const role = this.role(userId);
      user = { id: role.id, name: role.name, role: role.id, disabled: false };
      this.state.users.push(user);
    }
    if (pin === null) delete user.pinHash;
    else user.pinHash = this.checkPin(pin, user.id);
    await this.save();
  }

  /** Users who can sign in with a PIN, for the login screen (no rights, no hash). */
  loginUsers(): { id: string; name: string }[] {
    return this.state.users.filter((u) => u.pinHash && !u.disabled).map((u) => ({ id: u.id, name: u.name }));
  }

  /** Whether a user (enabled) has a right through their role. */
  userCan(userId: string, right: string): boolean {
    const user = this.state.users.find((u) => u.id === userId);
    const role = user && !user.disabled ? this.state.roles.find((r) => r.id === user.role) : undefined;
    return role?.rights.some((g) => rightMatches(g, right)) ?? false;
  }

  /** A session for a user who proved who they are some other way (a hardware key). */
  openSession(userId: string): { token: string; user: UserSummary; role: Role } {
    const user = this.user(userId);
    if (user.disabled) throw new HttpError(403, say("utilisateur désactivé", "user disabled"));
    const token = crypto.randomBytes(24).toString("base64url");
    this.sessions.set(hashToken(token), { userId: user.id, expiresAt: this.now() + SESSION_TTL_MS });
    this.saveSessions();
    return { token, user: this.summary(user), role: this.role(user.role) };
  }

  private closeSessions(userId: string): void {
    for (const [hash, s] of this.sessions) if (s.userId === userId) this.sessions.delete(hash);
    this.saveSessions();
  }

  /**
   * The live session behind a token. One in use is extended once half its time has gone (so a
   * whole day of service never ends on an expired tablet, and the file is written rarely); an
   * expired one is dropped.
   */
  private sessionOf(credential: string): { userId: string; expiresAt: number } | undefined {
    const hash = hashToken(credential);
    const session = this.sessions.get(hash);
    if (!session) return undefined;
    const now = this.now();
    if (session.expiresAt < now) {
      this.sessions.delete(hash);
      this.saveSessions();
      return undefined;
    }
    if (session.expiresAt - now < SESSION_TTL_MS / 2) {
      session.expiresAt = now + SESSION_TTL_MS;
      this.saveSessions();
    }
    return session;
  }

  /** Expired sessions are dropped on the way; a failed write only costs the sign-ins of a restart. */
  private saveSessions(): void {
    if (!this.configStore) return;
    const now = this.now();
    for (const [hash, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(hash);
    const entries = [...this.sessions].map(([hash, s]) => ({ hash, ...s }));
    void this.configStore.setAuthSessions(entries).catch((e: Error) => console.error("Could not save the sessions:", e.message));
  }

  /**
   * Opens a session for the user whose PIN matches; with `userId`, only that user is tried.
   * `client` (the caller's address) counts the wrong PINs: past MAX_PIN_FAILURES, 429 until the
   * window ends, even for the right PIN.
   */
  login(pin: string, userId?: string, client = ""): { token: string; user: UserSummary; role: Role } {
    const now = this.now();
    for (const [c, e] of this.pinFailures) if (e.resetAt <= now) this.pinFailures.delete(c);
    const failures = this.pinFailures.get(client);
    if (failures && failures.count >= MAX_PIN_FAILURES) {
      throw new HttpError(429, say(`trop d'essais : réessayer dans ${Math.ceil((failures.resetAt - now) / 1000)} s`, `too many attempts: try again in ${Math.ceil((failures.resetAt - now) / 1000)} s`));
    }
    const user = this.state.users.find((u) => (!userId || u.id === userId) && !u.disabled && u.pinHash && verifyPin(pin, u.pinHash));
    if (!user) {
      const entry = this.pinFailures.get(client) ?? { count: 0, resetAt: now + PIN_FAILURE_WINDOW_MS };
      entry.count++;
      this.pinFailures.set(client, entry);
      throw new HttpError(401, say("PIN incorrect", "wrong PIN"));
    }
    this.pinFailures.delete(client);
    return this.openSession(user.id);
  }

  logout(token: string): void {
    if (this.sessions.delete(hashToken(token))) this.saveSessions();
  }

  bearerOf(req: Pick<Request, "headers">): string | undefined {
    const header = req.headers.authorization;
    return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  }

  /** The user behind a credential: none for the master token (the administrator itself). */
  userOf(credential: string | undefined): UserSummary | undefined {
    if (!credential || tokensMatch(credential, this.masterToken)) return undefined;
    const session = this.sessionOf(credential);
    if (session) return this.userById(session.userId);
    const resolved = this.resolveToken?.(credential);
    return resolved?.userId ? this.userById(resolved.userId) : undefined;
  }

  roleOf(credential: string | undefined): Role | undefined {
    if (!credential) return undefined;
    const admin = () => this.state.roles.find((r) => r.id === "admin") ?? DEFAULT_ROLES[0];
    if (tokensMatch(credential, this.masterToken)) return admin();
    let userId: string;
    const session = this.sessionOf(credential);
    if (session) {
      userId = session.userId;
    } else {
      const resolved = this.resolveToken?.(credential);
      if (!resolved) return undefined;
      if (!resolved.userId) return admin(); // an OAuth grant approved with the master token
      userId = resolved.userId;
    }
    const user = this.state.users.find((u) => u.id === userId);
    return user && !user.disabled ? this.state.roles.find((r) => r.id === user.role) : undefined;
  }

  nameOf(credential: string | undefined): string | undefined {
    if (!credential) return undefined;
    if (tokensMatch(credential, this.masterToken)) return "jeton maître";
    const user = this.userOf(credential);
    if (user) return user.name;
    return this.roleOf(credential) ? "client IA (jeton maître)" : undefined; // an OAuth grant approved with the master token
  }

  can(credential: string | undefined, right: string): boolean {
    return this.roleOf(credential)?.rights.some((g) => rightMatches(g, right)) ?? false;
  }

  isValidCredential(candidate: string): boolean {
    return this.roleOf(candidate) !== undefined;
  }

  authKind(req: Pick<Request, "headers">): AuthKind | undefined {
    const c = this.bearerOf(req);
    if (!c || !this.roleOf(c)) return undefined;
    if (tokensMatch(c, this.masterToken)) return "static";
    return this.sessions.has(hashToken(c)) ? "session" : "oauth";
  }

  /** The web UI and its API: the master token or a session; an OAuth token is good for /mcp only. */
  isAuthorized(req: Request): boolean {
    const kind = this.authKind(req);
    return kind === "static" || kind === "session";
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
      if (!this.isAuthorized(req)) return next(new HttpError(401, "Unauthorized"));
      if (!this.can(credential, right)) return next(new HttpError(403, say(`droit requis : ${right}`, `right required: ${right}`)));
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
