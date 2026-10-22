import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { encodeFeedback, Os2lReader } from "../../../src/plugins/light/os2l/codec.js";

describe("OS2L (DJ software)", () => {
  it("reads JSON objects one after the other, however the packets cut them", () => {
    const r = new Os2lReader();
    const beat = '{"evt":"beat","change":false,"pos":12,"bpm":124.5,"strength":0.3}';
    const btn = '{"evt":"btn","name":"Strobe {fast}","page":"Pad","state":"on"}';
    expect(r.push(beat + "\n" + btn.slice(0, 20))).to.deep.equal([{ evt: "beat", change: false, pos: 12, bpm: 124.5, strength: 0.3 }]);
    expect(r.push(btn.slice(20) + '{"evt":"cmd","id":3,"param":1.4}')).to.deep.equal([
      { evt: "btn", name: "Strobe {fast}", page: "Pad", state: "on" }, // braces inside a string are not the object's
      { evt: "cmd", id: 3, param: 1 },
    ]);
    expect(r.push('noise {"evt":"unknown"} {"evt":"beat","bpm":0} {not json}')).to.deep.equal([]);
    expect(JSON.parse(encodeFeedback("Strobe", false, "Pad"))).to.deep.equal({ evt: "feedback", name: "Strobe", page: "Pad", state: "off" });
  });

  describe("server", function () {
    this.timeout(10_000);
    let plugin: LightPlugin;
    let dj: Socket;
    const received: string[] = [];
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    const send = (o: object) => dj.write(JSON.stringify(o));
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
      expect(ok()).to.equal(true);
    };

    beforeEach(async () => {
      const dataRoot = join(mkdtempSync(join(tmpdir(), "light-os2l-")), "data");
      mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
      copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
      const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, os2l: { port: 0, advertise: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
      await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
      await plugin.start();
      received.length = 0;
      dj = connect(plugin.os2l.port!, "127.0.0.1");
      dj.setEncoding("utf8");
      dj.on("data", (d: string) => received.push(d));
      await new Promise((r) => dj.once("connect", r));
    });
    afterEach(async () => {
      dj.destroy();
      await plugin.stop();
    });

    it("follows the DJ's tempo, unless the MIDI clock plays", async () => {
      await run("tempo.set", { bpm: 100, source: "manual" });
      send({ evt: "beat", change: true, pos: 1, bpm: 126, strength: 0.5 });
      await until(() => plugin.tempo.state().source === "os2l");
      expect(plugin.tempo.state().bpm).to.equal(126);
      await until(() => (plugin.os2l.status().clients[0]?.beats ?? 0) === 1);
      // the desk chose the MIDI clock, and Ableton plays: the DJ is not followed
      await run("tempo.set", { source: "midi" });
      for (let i = 0; i < 48; i++) plugin.tempo.handleMidi({ type: "clock" });
      send({ evt: "beat", change: false, pos: 2, bpm: 90, strength: 0.5 });
      await until(() => plugin.os2l.status().clients[0]!.beats === 2);
      expect(plugin.tempo.state().source).to.equal("midi");
    });

    it("leads while the MIDI clock is silent, and gives the tempo back when it plays again", async () => {
      await run("tempo.set", { source: "midi" }); // chosen, but nothing plays
      send({ evt: "beat", change: true, pos: 1, bpm: 122, strength: 0.5 });
      await until(() => plugin.tempo.state().source === "os2l");
      for (let i = 0; i < 48; i++) plugin.tempo.handleMidi({ type: "clock" }); // Ableton starts
      await until(() => plugin.tempo.state().source === "midi");
    });

    it("plays a numbered command through the mappings made for the DJ, never through a controller's", async () => {
      await run("midi.mapping.put", { mapping: { id: "dj-master", input: { port: "OS2L", type: "cc", channel: 1, number: 5 }, on: { command: "group.level", args: { id: "master" } }, levelArg: "level", feedback: "none" } });
      await run("midi.mapping.put", { mapping: { id: "pad-cc5", input: { type: "cc", channel: 1, number: 5 }, on: { command: "grandmaster.set", args: {} }, levelArg: "level", feedback: "cc" } });
      send({ evt: "cmd", id: 5, param: 0.5 });
      await until(() => Math.abs((plugin.runtime.groups.get("master")!.master?.level ?? 1) - 0.5) < 0.01);
      expect(plugin.runtime.settings.grandMaster).to.equal(1); // the controller's « any input » CC 5 did not answer
      const line = ((await run("activity.list", { limit: 5 })) as { name: string; origin: string }[]).find((e) => e.name === "group.level")!;
      expect(line.origin).to.equal("os2l");
      send({ evt: "cmd", id: 300, param: 1 }); // past what a CC can say: ignored
      await until(() => plugin.os2l.status().log.length === 2);
      expect(plugin.runtime.groups.get("master")!.master?.level).to.be.closeTo(0.5, 0.01);
    });

    it("plays the look named by a pad button, says who did it, and shows on the pad what plays", async () => {
      send({ evt: "btn", name: "HOLE", page: "Lumière", state: "on" });
      await until(() => plugin.runtime.isActive("hole"));
      const line = ((await run("activity.list", { limit: 5 })) as { name: string; origin: string }[]).find((e) => e.name === "look.go")!;
      expect(line.origin).to.equal("os2l");
      // stopped from elsewhere: the pad's button goes dark
      await run("look.stop", { id: "hole" });
      await until(() => received.join("").includes('"state":"off"'));
      expect(JSON.parse(received.join("").trim())).to.deep.equal({ evt: "feedback", name: "HOLE", page: "Lumière", state: "off" });
      // a button with no look of its name does nothing
      send({ evt: "btn", name: "nothing here", state: "on" });
      await until(() => plugin.os2l.status().log.length === 2);
      expect(plugin.runtime.isActive("hole")).to.equal(false);
    });
  });
});
