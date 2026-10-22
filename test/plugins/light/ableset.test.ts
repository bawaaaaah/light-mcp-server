import { expect } from "chai";
import { createSocket } from "node:dgram";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { AbleSetFollower } from "../../../src/plugins/light/ableset/ableset.js";
import { decodeOsc, encodeOsc, type OscArg } from "../../../src/plugins/light/osc/codec.js";

describe("AbleSet", () => {
  it("starts a section only while AbleSet plays, once per change, and the one it starts on", () => {
    const f = new AbleSetFollower();
    expect(f.receive("/setlist/activeSongName", ["Chant"])).to.equal(undefined);
    expect(f.receive("/setlist/activeSectionName", ["Couplet"])).to.equal(undefined); // stopped: moving around plays nothing
    expect(f.receive("/global/isPlaying", [{ type: "i", value: 1 }])).to.deep.equal({ song: "Chant", section: "Couplet" });
    expect(f.receive("/setlist/activeSectionName", ["Couplet"])).to.equal(undefined); // the same again
    expect(f.receive("/setlist/activeSectionName", ["Refrain"])).to.deep.equal({ song: "Chant", section: "Refrain" });
    expect(f.receive("/global/isPlaying", [false])).to.equal(undefined);
    expect(f.receive("/global/isPlaying", [true])).to.deep.equal({ song: "Chant", section: "Refrain" }); // played again from there
    expect(f.receive("/global/tempo", [{ type: "f", value: 120 }])).to.equal(undefined);
  });

  it("subscribes to AbleSet and follows its sections into the show's songs, by title and name", async function () {
    this.timeout(10_000);
    // a fake AbleSet: answers the subscription with its heartbeat and what plays
    const ableset = createSocket("udp4");
    const subscriptions: OscArg[][] = [];
    const jumps: [string, OscArg[]][] = [];
    let client: { port: number; address: string } | undefined;
    ableset.on("message", (buf, rinfo) => {
      for (const m of decodeOsc(buf)) {
        if (m.address.startsWith("/setlist/jump")) jumps.push([m.address, m.args]);
        if (m.address !== "/subscribe") continue;
        subscriptions.push(m.args);
        const port = m.args[1];
        client = { port: typeof port === "object" && port !== null ? port.value : Number(port), address: rinfo.address };
      }
    });
    await new Promise<void>((r) => ableset.bind(0, "127.0.0.1", r));
    const say = (address: string, args: OscArg[] = []) => ableset.send(encodeOsc({ address, args }), client!.port, client!.address);

    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-ableset-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, os2l: { enabled: false }, ableset: { enabled: false, host: "127.0.0.1", port: (ableset.address() as { port: number }).port }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    await run("song.put", { song: { id: "chant", title: "Chant d'entrée", bpm: 100, sections: [{ id: "intro", name: "Intro", look: "checker" }, { id: "refrain", name: "Refrain", look: "palette" }] } });
    await plugin.start();
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 150 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
      expect(ok()).to.equal(true);
    };
    try {
      await run("ableset.configure", { enabled: true });
      await until(() => subscriptions.length > 0);
      expect(subscriptions[0]!.slice(0, 1)).to.deep.equal(["auto"]); // AbleSet sends to the subscriber's own address
      say("/heartbeat");
      say("/setlist/activeSongName", ["CHANT D'ENTRÉE"]);
      say("/setlist/activeSectionName", ["refrain"]);
      say("/global/isPlaying", [{ type: "i", value: 1 }]);
      await until(() => plugin.runtime.isActive("palette"));
      const status = (await run("ableset.status")) as { connected: boolean; song: string; lastMatch: { found: boolean } };
      expect(status).to.deep.include({ connected: true, song: "CHANT D'ENTRÉE" });
      expect(status.lastMatch.found).to.equal(true);
      const line = ((await run("activity.list", { limit: 5 })) as { name: string; origin: string }[]).find((e) => e.name === "song.section.go")!;
      expect(line.origin).to.equal("ableset");
      // a section the show does not have: said, nothing started
      say("/setlist/activeSectionName", ["Pont"]);
      await until(() => (plugin.ableset.status().lastMatch?.section ?? "") === "Pont");
      expect(plugin.ableset.status().lastMatch!.found).to.equal(false);
      // the other way: the light sends AbleSet to a song and section, by their titles and names
      await run("ableset.jump", { song: "chant", section: "intro" });
      await until(() => jumps.length === 2);
      expect(jumps).to.deep.equal([
        ["/setlist/jumpToSong", ["Chant d'entrée"]],
        ["/setlist/jumpToSection", ["Intro"]],
      ]);
      await run("ableset.jump", { song: "absent" }).then(
        () => expect.fail("no such song"),
        (e: Error) => expect(e.message).to.match(/chant inconnu/),
      );
    } finally {
      await plugin.stop();
      ableset.close();
    }
  });
});
