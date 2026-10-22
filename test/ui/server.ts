/**
 * Server for the browser tests: temporary data (Test Bar 4 fixtures, synthetic QLC+ workspace
 * imported, one moving head on universe 2), PINs set (régisseur 1234, admin 9999, bénévole 5678, lecture 1357), auth token
 * "ui-test-token", built UI served on PORT. The output is bound to loopback (a broadcast or a multicast
 * never leaves the machine) on an Art-Net port of its own (the stage server never hears it), and DMX
 * USB goes to a fake serial port: the tests also run on the stage Mac, whose light must never receive
 * their frames.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../../src/index.js";
import { systemContext } from "../../src/plugins/light/commands/registry.js";
import { FakeSerial } from "../fakes/serial.js";

const port = Number(process.env.PORT ?? 8799);
const dir = mkdtempSync(join(tmpdir(), "light-ui-"));
const dataRoot = join(dir, "data");
mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
copyFileSync(new URL("../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
copyFileSync(new URL("../fixtures/spot.qxf", import.meta.url), join(dataRoot, "fixtures", "spot.qxf"));
writeFileSync(
  join(dir, "config.json"),
  JSON.stringify({ version: 1, server: { authToken: "ui-test-token" }, plugins: { light: { universes: 2, discovery: false, osc: { enabled: false }, os2l: { port: 0, advertise: false }, ableset: { port: 39999 }, output: { bindAddress: "127.0.0.1", artnetPort: 16454, routes: [{ universe: 1, artnet: { portAddress: 0, targets: ["127.0.0.2"] } }, { universe: 2, artnet: { portAddress: 1, targets: ["127.0.0.2"] } }] }, midi: { active: "local", profiles: { local: { inputs: [], rtp: { enabled: false } } } } } } }),
);
const running = await bootstrap({ configPath: join(dir, "config.json"), port, host: "127.0.0.1", log: () => undefined, light: { dataRoot, midiNative: null, serial: new FakeSerial() } });
await running.auth.setPin("regisseur", "1234");
await running.auth.setPin("admin", "9999");
await running.auth.setPin("benevole", "5678");
await running.auth.setPin("lecture", "1357");
const run = (name: string, args: unknown = {}) => running.light.commands.invoke(name, args, systemContext());
await run("import.qxw", { xml: readFileSync(new URL("../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
await run("venue.fixture.put", { fixture: { id: "spot", name: "Lyre", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 2, address: 1 } });
await run("song.put", { song: { id: "chant", title: "Chant test", bpm: 100, mood: ["joie"], sections: [{ id: "intro", name: "Intro", look: "checker", cue: "début" }, { id: "refrain", name: "Refrain", look: "palette" }] } });
await run("notes.set", { collection: "looks", id: "checker", notes: "note de test" });
console.log(`ui test server on http://127.0.0.1:${port}`);
process.on("SIGTERM", () => void running.stop().then(() => process.exit(0)));
