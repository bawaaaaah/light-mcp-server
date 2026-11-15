import { expect } from "chai";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

/** The `light` CLI on temporary data, with no server running (offline mode). */
describe("CLI light (offline)", function () {
  this.timeout(60_000);
  const dir = mkdtempSync(join(tmpdir(), "light-cli-"));
  mkdirSync(join(dir, "data", "fixtures"), { recursive: true });
  copyFileSync(new URL("../fixtures/bar4.qxf", import.meta.url), join(dir, "data", "fixtures", "bar4.qxf"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, server: {}, plugins: { light: { discovery: false, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } } } }));
  const env = { ...process.env, LIGHT_CONFIG_PATH: join(dir, "config.json"), LIGHT_DATA_ROOT: join(dir, "data"), LIGHT_URL: "http://127.0.0.1:9" };
  const light = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", main, ...args], { env, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it("imports a QLC+ workspace, then checks and self-tests it", () => {
    const dry = light("import", "qxw", fileURLToPath(new URL("../fixtures/synthetic.qxw", import.meta.url)));
    expect(dry.code).to.equal(0);
    expect(dry.err).to.match(/proposition seulement/);
    expect(light("import", "qxw", fileURLToPath(new URL("../fixtures/synthetic.qxw", import.meta.url)), "--apply").code).to.equal(0);
    const check = light("check");
    expect(check.code).to.equal(0);
    expect(check.out).to.match(/show valide/);
    expect(check.err).to.match(/données ouvertes directement/);
    const selftest = light("selftest");
    expect(selftest.code).to.equal(0);
    expect(selftest.out).to.match(/Mappings : 3\/3/);
  });

  it("renews the master token without ever printing it", () => {
    const first = light("token").out.trim();
    expect(first).to.have.length.above(20);
    const r = light("token", "--new");
    expect(r.code).to.equal(0);
    expect(r.out).to.match(/Jeton maître renouvelé/);
    const second = (JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as { server: { authToken: string } }).server.authToken;
    expect(second).to.have.length.above(20).and.not.equal(first);
    expect(r.out + r.err).to.not.include(first).and.not.include(second);
    expect(light("token").out.trim()).to.equal(second);
  });

  it("lists the recent activity, the CLI's own commands included", () => {
    expect(light("call", "show.settings.set", "{}").code).to.equal(0);
    const r = light("activity", "--limit", "5");
    expect(r.code).to.equal(0);
    expect(r.out).to.match(/cli\s+✔ Modifier les réglages du show/);
  });

  it("checks a write without making it (--check): what it would change", () => {
    const zone = { id: "parvis", name: "Parvis", type: "floor", polygon: [[0, 0], [2, 0], [2, 2], [0, 2]] };
    const check = light("call", "stage.zone.put", JSON.stringify({ zone }), "--check");
    expect(check.code).to.equal(0);
    expect(JSON.parse(check.out)).to.include({ valid: true, new: true, id: "parvis" });
    expect(JSON.parse(light("call", "stage.zone.list").out)).to.deep.equal([]); // nothing written
    expect(light("call", "show.reset", "{}", "--check").code).to.not.equal(0); // no proposal for that one: said, not run
  });

  it("exports a library definition as a .qxf: to stdout, to a file, into a folder; non-UTF-8 bytes as they are", () => {
    const wheel = readFileSync(new URL("../fixtures/wheel-spot.qxf", import.meta.url));
    writeFileSync(join(dir, "data", "fixtures", "wheel-spot.qxf"), wheel);
    const latin = Buffer.from(wheel.toString("utf8").replace("Wheel Spot", "Latin Spot").replace("light-mcp-server tests", "Café"), "latin1");
    writeFileSync(join(dir, "data", "fixtures", "latin-spot.qxf"), latin);
    // stdout: the file byte for byte
    const out = spawnSync(process.execPath, ["--import", "tsx", main, "export", "qxf", "Test", "Wheel Spot"], { env });
    expect(out.status).to.equal(0);
    expect(out.stdout.equals(wheel)).to.equal(true);
    // --out file, then refused over an existing file without --force
    const file = join(dir, "spot.qxf");
    expect(light("export", "qxf", "Test", "Wheel Spot", "--out", file).code).to.equal(0);
    expect(readFileSync(file).equals(wheel)).to.equal(true);
    const again = light("export", "qxf", "Test", "Wheel Spot", "--out", file);
    expect(again.code).to.equal(1);
    expect(again.err).to.match(/existe déjà/);
    expect(light("export", "qxf", "Test", "Wheel Spot", "--out", file, "--force").code).to.equal(0);
    // a folder named with a trailing slash: created, the file under QLC+'s name; the Latin-1 bytes kept (base64)
    const folder = join(dir, "qxf-out") + "/";
    const r = light("export", "qxf", "Test", "Latin Spot", "--out", folder);
    expect(r.code).to.equal(0);
    expect(r.err).to.include(join(dir, "qxf-out", "Test-Latin-Spot.qxf"));
    expect(readFileSync(join(dir, "qxf-out", "Test-Latin-Spot.qxf")).equals(latin)).to.equal(true);
    // what the corrections wrote is said; a fixture together with a model is refused
    expect(light("call", "venue.fixture.put", JSON.stringify({ fixture: { id: "cli-spot", name: "Spot CLI", manufacturer: "Test", model: "Wheel Spot", mode: "Standard", universe: 1, address: 200 } })).code).to.equal(0);
    expect(light("call", "venue.wheel.put", JSON.stringify({ id: "cli-spot", scope: "model", wheel: { slots: { "20": { color: "#ff6600" } } } })).code).to.equal(0);
    const corrected = light("export", "qxf", "--fixture", "cli-spot", "--corrections", "--out", join(dir, "qxf-out"));
    expect(corrected.code).to.equal(0);
    expect(corrected.err).to.match(/écrit dans le fichier : .*#ff6600/);
    expect(readFileSync(join(dir, "qxf-out", "Test-Wheel-Spot.qxf"), "utf8")).to.include('Res1="#ff6600">Orange');
    expect(light("export", "qxf", "Test", "Wheel Spot", "--fixture", "cli-spot").code).to.equal(1);
  });

  it("packs a .lightshow and reports errors with a non-zero exit code", () => {
    const out = join(dir, "backup.lightshow");
    expect(light("pack", out).code).to.equal(0);
    expect(existsSync(out)).to.equal(true);
    const check = light("unpack", out, "--check");
    expect(check.code).to.equal(0);
    expect(check.out).to.match(/Show : 0 ajouté\(s\), 0 modifié\(s\), 0 supprimé\(s\)/);
    expect(check.err).to.match(/rien n'a été écrit/);
    const bad = light("call", "nope");
    expect(bad.code).to.equal(1);
    expect(bad.err).to.match(/commande inconnue/);
  });
});

/** `serve` under the Windows tray app (windows/): there is no SIGTERM there, a closed stdin asks for the clean stop. */
describe("light serve, stopped by closing its stdin", function () {
  this.timeout(60_000);

  it("saves and exits with 0 once its stdin closes, with LIGHT_STOP_ON_STDIN_CLOSE", () => {
    const dir = mkdtempSync(join(tmpdir(), "light-serve-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, server: {}, plugins: { light: { discovery: false, osc: { enabled: false }, os2l: { port: 0, advertise: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } } } }));
    const env = { ...process.env, LIGHT_CONFIG_PATH: join(dir, "config.json"), LIGHT_DATA_ROOT: join(dir, "data"), LIGHT_STOP_ON_STDIN_CLOSE: "1" };
    // stdin closes right after the empty input; a server that ignored it would be SIGKILLed at the timeout
    const r = spawnSync(process.execPath, ["--import", "tsx", main, "serve", "--no-http"], { env, input: "", encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    expect(r.signal, r.stderr).to.equal(null);
    expect(r.status, r.stderr).to.equal(0);
  });
});
