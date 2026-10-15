import { expect } from "chai";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/core/config-store.js";
import { AuthService } from "../src/core/auth.js";
import { HttpError } from "../src/core/http-errors.js";
import { localBaseUrl, resolveListen } from "../src/core/env.js";
import { hashPin } from "../src/core/auth.js";
import { PasskeyService } from "../src/core/passkeys.js";

const status = (fn: () => unknown): number | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as HttpError).status;
  }
};

describe("PIN login", () => {
  let now = 0;
  let auth: AuthService;
  beforeEach(async () => {
    now = 1_000_000;
    auth = new AuthService("master", undefined, () => now);
    await auth.setPin("regisseur", "1234");
    await auth.setPin("benevole", "5678");
  });

  it("lists only the users that have a PIN, without their rights", () => {
    expect(auth.loginUsers()).to.deep.equal([
      { id: "regisseur", name: "Régisseur" },
      { id: "benevole", name: "Bénévole" },
    ]);
  });

  it("only tries the role picked", () => {
    expect(status(() => auth.login("1234", "benevole"))).to.equal(401);
    expect(auth.login("1234", "regisseur").role.id).to.equal("regisseur");
    expect(auth.login("5678").role.id).to.equal("benevole");
  });

  it("answers 429 after 5 wrong PINs from one address, even for the right one, until the minute ends", () => {
    for (let i = 0; i < 5; i++) expect(status(() => auth.login("0000", undefined, "client-a"))).to.equal(401);
    expect(status(() => auth.login("1234", undefined, "client-a"))).to.equal(429);
    expect(auth.login("1234", undefined, "client-b").role.id).to.equal("regisseur");
    now += 60_000;
    expect(auth.login("1234", undefined, "client-a").role.id).to.equal("regisseur");
  });

  it("forgets the wrong PINs of an address once it gets one right", () => {
    for (let i = 0; i < 4; i++) expect(status(() => auth.login("0000", undefined, "a"))).to.equal(401);
    auth.login("1234", undefined, "a");
    for (let i = 0; i < 4; i++) expect(status(() => auth.login("0000", undefined, "a"))).to.equal(401);
    expect(auth.login("1234", undefined, "a").role.id).to.equal("regisseur");
  });
});

describe("named users", () => {
  const store = async (auth: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "light-users-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, server: { authToken: "master", auth }, plugins: {} }));
    const s = new ConfigStore({ filePath: join(dir, "config.json") });
    await s.load();
    return s;
  };

  it("turns the PINs of the roles (before users) into one user per role, same PIN", async () => {
    const roles = [
      { id: "admin", name: "Administrateur du lieu", rights: ["*"] },
      { id: "regisseur", name: "Régisseur", rights: ["commands:*"], pinHash: hashPin("1234") },
    ];
    const auth = new AuthService("master", await store({ roles }));
    expect(auth.users()).to.deep.equal([{ id: "regisseur", name: "Régisseur", role: "regisseur", roleName: "Régisseur", hasPin: true, disabled: false }]);
    expect(auth.roles().every((r) => !("pinHash" in r))).to.equal(true);
    const { token, user } = auth.login("1234");
    expect(user.id).to.equal("regisseur");
    expect(auth.roleOf(token)?.id).to.equal("regisseur");
  });

  it("adds, renames, disables and deletes users; a PIN belongs to one user only", async () => {
    const auth = new AuthService("master", await store(undefined));
    const marie = await auth.addUser({ name: "Régie Jardin", role: "regisseur", pin: "4321" });
    expect(marie).to.deep.include({ id: "regie-jardin", role: "regisseur", hasPin: true });
    const again = await auth.addUser({ name: "Régie Jardin", role: "benevole" });
    expect(again.id).to.equal("regie-jardin-2");
    let bad = 0;
    await auth.addUser({ name: "X", role: "inconnu" }).catch((e: HttpError) => (bad = e.status));
    expect(bad).to.equal(400);
    let dup = 0;
    await auth.setPin(again.id, "4321").catch((e: HttpError) => (dup = e.status));
    expect(dup).to.equal(409);
    const { token } = auth.login("4321", "regie-jardin");
    expect(auth.userOf(token)?.name).to.equal("Régie Jardin");
    await auth.updateUser("regie-jardin", { name: "Régie cour", role: "benevole" });
    expect(auth.roleOf(token)?.id).to.equal("benevole");
    await auth.updateUser("regie-jardin", { disabled: true });
    expect(auth.roleOf(token)).to.equal(undefined); // its sessions are closed
    expect(status(() => auth.login("4321"))).to.equal(401);
    await auth.deleteUser("regie-jardin");
    expect(auth.users().map((u) => u.id)).to.deep.equal(["regie-jardin-2"]);
  });

  it("resolves outside tokens (OAuth) to a user, or to the administrator when the master token approved them", () => {
    const auth = new AuthService("master");
    auth.setTokenResolver((t) => (t === "grant-admin" ? {} : t === "grant-x" ? { userId: "nobody" } : undefined));
    expect(auth.roleOf("grant-admin")?.id).to.equal("admin");
    expect(auth.roleOf("grant-x")).to.equal(undefined);
    expect(auth.roleOf("other")).to.equal(undefined);
  });

  it("only offers hardware keys on localhost and on the public HTTPS address", () => {
    const keys = new PasskeyService(undefined, new URL("https://lumiere.example.com"));
    expect(keys.resolveRelyingParty("http://localhost:8790")).to.deep.equal({ id: "localhost", origin: "http://localhost:8790" });
    expect(keys.resolveRelyingParty("https://lumiere.example.com")).to.deep.equal({ id: "lumiere.example.com", origin: "https://lumiere.example.com" });
    expect(keys.resolveRelyingParty("http://lumiere.example.com")).to.equal(undefined);
    expect(keys.resolveRelyingParty("http://lan-host:8790")).to.equal(undefined);
    expect(new PasskeyService(undefined, undefined).resolveRelyingParty("https://lumiere.example.com")).to.equal(undefined);
  });
});

describe("where the gateway listens", () => {
  const saved = process.env.PORT;
  afterEach(() => {
    if (saved === undefined) delete process.env.PORT;
    else process.env.PORT = saved;
  });

  it("takes the flag, then PORT, then the config file, then 8790 on every interface", () => {
    delete process.env.PORT;
    expect(resolveListen({})).to.deep.equal({ port: 8790, host: "0.0.0.0" });
    expect(resolveListen({ port: 9000, host: "127.0.0.1" })).to.deep.equal({ port: 9000, host: "127.0.0.1" });
    process.env.PORT = "9100";
    expect(resolveListen({ port: 9000 }).port).to.equal(9100);
    expect(resolveListen({ port: 9000, host: "127.0.0.1" }, { port: 0, host: "::" })).to.deep.equal({ port: 0, host: "::" });
  });

  it("reads server.port and server.host from the config file, and ignores a mistyped one without losing the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "light-listen-"));
    const read = async (server: unknown) => {
      writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, server, plugins: {} }));
      const store = new ConfigStore({ filePath: join(dir, "config.json") });
      await store.load();
      return { port: store.getServerPort(), host: store.getServerHost(), token: store.getServerAuthToken() };
    };
    expect(await read({ authToken: "t", port: 9000, host: " 127.0.0.1 " })).to.deep.equal({ port: 9000, host: "127.0.0.1", token: "t" });
    expect(await read({ authToken: "t", port: "9000", host: 12 })).to.deep.equal({ port: undefined, host: undefined, token: "t" });
    expect(await read({ authToken: "t", port: 70000 })).to.deep.include({ port: undefined, token: "t" });
  });

  it("reaches a wildcard host through loopback", () => {
    expect(localBaseUrl({ port: 8790, host: "0.0.0.0" })).to.equal("http://127.0.0.1:8790");
    expect(localBaseUrl({ port: 8790, host: "::" })).to.equal("http://127.0.0.1:8790");
    expect(localBaseUrl({ port: 8791, host: "::1" })).to.equal("http://[::1]:8791");
  });
});
