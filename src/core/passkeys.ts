// Adapted from wing-mcp-server (MIT, https://github.com/bawaaaaah/wing-mcp-server), src/core/passkeys.ts:
// here every passkey belongs to a named user (core/auth.ts), whose role gives its rights.
import express, { type NextFunction, type Request, type Response } from "express";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";
import { signedInView, type AuthService } from "./auth.js";
import type { ConfigStore } from "./config-store.js";
import { bodyField, bodyString } from "./http-body.js";
import { HttpError } from "./http-errors.js";
import { say } from "./lang.js";

// A WebAuthn ceremony is a human-scale round trip (touching a key, a Touch ID prompt): a few
// minutes is plenty, and anything unanswered after that is abandoned.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// Login options are reachable pre-auth, so the pending-challenge map is bounded by size too.
const CHALLENGES_MAX_SIZE = 1000;
const PASSKEY_NAME_MAX_LENGTH = 64;
const RP_NAME = "Light MCP";

const storedPasskeySchema = z.object({
  id: z.string(),
  userId: z.string(),
  publicKey: z.string(),
  counter: z.number(),
  transports: z.array(z.string()).optional(),
  name: z.string(),
  rpId: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
});
type StoredPasskey = z.infer<typeof storedPasskeySchema>;

export interface PasskeySummary {
  id: string;
  userId: string;
  name: string;
  rpId: string;
  createdAt: string;
  lastUsedAt?: string;
}

/** The WebAuthn relying party a request is talking to: its RP ID (a bare hostname) and origin. */
export interface RelyingParty {
  id: string;
  origin: string;
}

/** A ceremony failure caused by the caller (bad/expired/replayed response, unknown passkey…). */
export class PasskeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasskeyError";
  }
}

function summarize(p: StoredPasskey): PasskeySummary {
  return { id: p.id, userId: p.userId, name: p.name, rpId: p.rpId, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt };
}

/**
 * Hardware keys (YubiKey) and platform passkeys for the web UI and the OAuth approval page. A key is
 * registered for a user; signing in with it opens a session of that user (`AuthService.openSession`),
 * never the master token. WebAuthn needs a secure context bound to a hostname: localhost (the stage
 * Mac) or the public HTTPS address behind the reverse proxy — not a LAN IP, where the PIN stays.
 */
export class PasskeyService {
  private readonly passkeys: StoredPasskey[];
  private readonly challenges = new Map<string, { purpose: "register" | "login"; userId?: string; expiresAt: number }>();

  constructor(
    private readonly configStore: ConfigStore | undefined,
    private readonly publicUrl: URL | undefined,
  ) {
    const state = configStore?.getPasskeyState() as { credentials?: unknown } | undefined;
    this.passkeys = [];
    for (const entry of Array.isArray(state?.credentials) ? state.credentials : []) {
      const parsed = storedPasskeySchema.safeParse(entry);
      if (parsed.success) this.passkeys.push(parsed.data);
      else console.error("Ignoring a malformed persisted passkey:", parsed.error.message);
    }
  }

  /**
   * Passkeys are bound to a hostname, so they only work on origins deliberately recognized: localhost
   * on any port, and the configured public URL when it is HTTPS. Anything else is refused.
   */
  resolveRelyingParty(origin: string | undefined): RelyingParty | undefined {
    if (!origin) return undefined;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return undefined;
    }
    if (url.hostname === "localhost" && (url.protocol === "http:" || url.protocol === "https:")) return { id: url.hostname, origin: url.origin };
    if (this.publicUrl && url.origin === this.publicUrl.origin && url.protocol === "https:") return { id: url.hostname, origin: url.origin };
    return undefined;
  }

  /** Ceremonies are POSTs, on which browsers always send Origin — never guessed from Host, which a proxy may rewrite. */
  relyingPartyFor(req: Request): RelyingParty | undefined {
    return this.resolveRelyingParty(req.headers.origin);
  }

  hasPasskeys(rpId?: string): boolean {
    return this.passkeys.some((p) => rpId === undefined || p.rpId === rpId);
  }

  list(userId?: string): PasskeySummary[] {
    return this.passkeys.filter((p) => userId === undefined || p.userId === userId).map(summarize);
  }

  count(userId: string): number {
    return this.passkeys.filter((p) => p.userId === userId).length;
  }

  async registrationOptions(rp: RelyingParty, user: { id: string; name: string }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rp.id,
      userName: user.id,
      userDisplayName: user.name,
      // stable per user, so a key that already holds this user's passkey recognizes the exclude list
      userID: new Uint8Array(Buffer.from(`light-user:${user.id}`, "utf8")),
      attestationType: "none",
      excludeCredentials: this.passkeys.filter((p) => p.rpId === rp.id && p.userId === user.id).map((p) => ({ id: p.id, transports: p.transports as never })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    this.rememberChallenge(options.challenge, "register", user.id);
    return options;
  }

  async register(rp: RelyingParty, userId: string, response: RegistrationResponseJSON, name: string): Promise<PasskeySummary> {
    if (!response || typeof response !== "object") throw new PasskeyError("réponse de la clé absente");
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: this.challengeChecker("register", userId),
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: false,
      });
    } catch (err) {
      throw new PasskeyError(err instanceof Error ? err.message : String(err));
    }
    if (!verification.verified) throw new PasskeyError("la clé n'a pas pu être vérifiée");
    const { credential } = verification.registrationInfo;
    if (this.passkeys.some((p) => p.id === credential.id)) throw new PasskeyError("cette clé est déjà enregistrée");
    const passkey: StoredPasskey = {
      id: credential.id,
      userId,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: credential.transports ?? response.response.transports,
      name: name.trim().slice(0, PASSKEY_NAME_MAX_LENGTH) || "Clé",
      rpId: rp.id,
      createdAt: new Date().toISOString(),
    };
    this.passkeys.push(passkey);
    await this.persist();
    return summarize(passkey);
  }

  async authenticationOptions(rp: RelyingParty): Promise<PublicKeyCredentialRequestOptionsJSON> {
    if (!this.hasPasskeys(rp.id)) throw new PasskeyError(`aucune clé enregistrée pour ${rp.id}`);
    // no allowCredentials: every key here is discoverable, the browser offers the ones it holds
    const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: "preferred" });
    this.rememberChallenge(options.challenge, "login");
    return options;
  }

  /** Verifies a login assertion and returns the passkey it was made with (its counter bumped). */
  async authenticate(rp: RelyingParty, response: AuthenticationResponseJSON): Promise<PasskeySummary> {
    if (!response || typeof response !== "object") throw new PasskeyError("réponse de la clé absente");
    const passkey = this.passkeys.find((p) => p.id === response.id);
    if (!passkey) throw new PasskeyError(say("clé inconnue", "unknown key"));
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: this.challengeChecker("login"),
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        credential: { id: passkey.id, publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")), counter: passkey.counter, transports: passkey.transports as never },
        requireUserVerification: false,
      });
    } catch (err) {
      throw new PasskeyError(err instanceof Error ? err.message : String(err));
    }
    if (!verification.verified) throw new PasskeyError("la clé n'a pas pu être vérifiée");
    passkey.counter = verification.authenticationInfo.newCounter;
    passkey.lastUsedAt = new Date().toISOString();
    await this.persist();
    return summarize(passkey);
  }

  async remove(id: string): Promise<PasskeySummary | undefined> {
    const index = this.passkeys.findIndex((p) => p.id === id);
    if (index === -1) return undefined;
    const [removed] = this.passkeys.splice(index, 1);
    await this.persist();
    return summarize(removed!);
  }

  /** A deleted user takes their keys along. */
  async removeUser(userId: string): Promise<void> {
    const kept = this.passkeys.filter((p) => p.userId !== userId);
    if (kept.length === this.passkeys.length) return;
    this.passkeys.splice(0, this.passkeys.length, ...kept);
    await this.persist();
  }

  private rememberChallenge(challenge: string, purpose: "register" | "login", userId?: string): void {
    const now = Date.now();
    for (const [key, entry] of this.challenges) if (now > entry.expiresAt) this.challenges.delete(key);
    if (this.challenges.size >= CHALLENGES_MAX_SIZE) {
      const oldest = this.challenges.keys().next().value;
      if (oldest !== undefined) this.challenges.delete(oldest);
    }
    this.challenges.set(challenge, { purpose, userId, expiresAt: now + CHALLENGE_TTL_MS });
  }

  // Single-use: consumed on the first verification attempt whatever its outcome, so a captured
  // response is never replayed, and a registration challenge only registers for its own user.
  private challengeChecker(purpose: "register" | "login", userId?: string): (challenge: string) => boolean {
    return (challenge: string) => {
      const entry = this.challenges.get(challenge);
      this.challenges.delete(challenge);
      return entry !== undefined && entry.purpose === purpose && entry.userId === userId && Date.now() <= entry.expiresAt;
    };
  }

  private async persist(): Promise<void> {
    await this.configStore?.setPasskeyState({ credentials: this.passkeys });
  }
}

function requireRelyingParty(passkeys: PasskeyService, req: Request): RelyingParty {
  const rp = passkeys.relyingPartyFor(req);
  if (!rp) throw new HttpError(400, say("clés indisponibles depuis cette adresse : passer par localhost ou par l'adresse publique HTTPS (server.publicUrl)", "security keys are not available from this address: use localhost or the public HTTPS address (server.publicUrl)"));
  return rp;
}

// Express 5 forwards a rejected promise to the error handler, but PasskeyError needs a 400 first.
function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err instanceof PasskeyError ? new HttpError(400, err.message) : err);
    }
  };
}

/**
 * /api/auth/passkeys/* — signing in is public (it is how one gets in); listing, adding and removing
 * keys needs a signed-in user, for their own keys, or the administrator (`auth:admin`) for anyone's.
 */
export function createPasskeyRouter(passkeys: PasskeyService, auth: AuthService): express.Router {
  const router = express.Router();
  const requireAuth = auth.requireAuth();
  /** Whose keys a request acts on: the signed-in user, or `user` when the caller administers users. */
  const target = (req: Request, wanted: string | undefined): { id: string; name: string } => {
    const credential = auth.bearerOf(req);
    const self = auth.userOf(credential);
    const id = wanted ?? self?.id;
    if (!id) throw new HttpError(400, say("choisir l'utilisateur de la clé", "choose the user of the key"));
    if (id !== self?.id && !auth.can(credential, "auth:admin")) throw new HttpError(403, say("droit requis : auth:admin", "right required: auth:admin"));
    const user = auth.userById(id);
    if (!user) throw new HttpError(404, say(`utilisateur inconnu : ${id}`, `unknown user: ${id}`));
    return user;
  };

  router.get("/api/auth/passkeys/status", (_req, res) => {
    res.json({ available: passkeys.hasPasskeys() });
  });

  router.post(
    "/api/auth/passkeys/login/options",
    handle(async (req, res) => {
      res.json(await passkeys.authenticationOptions(requireRelyingParty(passkeys, req)));
    }),
  );

  router.post(
    "/api/auth/passkeys/login/verify",
    express.json(),
    handle(async (req, res) => {
      const key = await passkeys.authenticate(requireRelyingParty(passkeys, req), bodyField(req.body, "response") as AuthenticationResponseJSON);
      const { token, user, role } = auth.openSession(key.userId);
      res.json({ token, role: signedInView(role, user) });
    }),
  );

  router.get("/api/auth/passkeys", requireAuth, (req, res) => {
    const credential = auth.bearerOf(req);
    res.json(auth.can(credential, "auth:admin") ? passkeys.list() : passkeys.list(auth.userOf(credential)?.id ?? "\0"));
  });

  router.post(
    "/api/auth/passkeys/register/options",
    requireAuth,
    express.json(),
    handle(async (req, res) => {
      res.json(await passkeys.registrationOptions(requireRelyingParty(passkeys, req), target(req, bodyString(req.body, "user"))));
    }),
  );

  router.post(
    "/api/auth/passkeys/register/verify",
    requireAuth,
    express.json(),
    handle(async (req, res) => {
      const user = target(req, bodyString(req.body, "user"));
      const key = await passkeys.register(requireRelyingParty(passkeys, req), user.id, bodyField(req.body, "response") as RegistrationResponseJSON, bodyString(req.body, "name") ?? "");
      res.status(201).json(key);
    }),
  );

  router.delete(
    "/api/auth/passkeys/:id",
    requireAuth,
    handle(async (req, res) => {
      const id = String(req.params.id);
      const key = passkeys.list().find((p) => p.id === id);
      if (!key) throw new HttpError(404, say("clé inconnue", "unknown key"));
      target(req, key.userId); // its own user, or an administrator
      await passkeys.remove(id);
      res.status(204).end();
    }),
  );

  return router;
}
