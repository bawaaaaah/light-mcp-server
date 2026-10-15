import { expect } from "chai";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/core/config-store.js";
import { AuthService } from "../src/core/auth.js";
import { HttpError } from "../src/core/http-errors.js";
import { localBaseUrl, resolveListen } from "../src/core/env.js";

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

  it("lists only the roles that have a PIN, without their rights", () => {
    expect(auth.loginRoles()).to.deep.equal([
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
