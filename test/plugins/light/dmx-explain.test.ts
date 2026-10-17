import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

describe("dmx.explain: why a channel has its value", () => {
  it("names the fixture and channel, the DCAs dosing it, the faders writing it and a forcing", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-explain-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    await run("group.put", { group: { id: "face", name: "Face", members: { fixtures: ["bar-0"], looks: [], groups: [] }, master: { level: 0.5, mute: false } } });
    await run("fader.put", { fader: { id: "w", name: "Blanc", channels: [{ fixture: "bar-0", offset: 2 }], level: 0.4, dca: "face" } });
    await run("dmx.set", { universe: 1, channel: 3, value: 99 });
    type E = { value: number; parked?: number; fixture?: { name: string; offset: number; channel?: string }; intensity?: { dcas: { name: string; own: number; effective: number }[] }; faders: { name: string; effective: number }[] };
    const e = (await run("dmx.explain", { universe: 1, channel: 3 })) as E;
    expect(e.fixture).to.deep.include({ name: "Bar 0", offset: 3 });
    expect(e.fixture!.channel).to.be.a("string");
    expect(e.intensity!.dcas.map((d) => [d.name, d.own])).to.deep.include(["Face", 0.5]);
    expect(e.faders).to.deep.equal([{ id: "w", name: "Blanc", level: 0.4, dca: "face", effective: 0.2 }]); // 40 % × the DCA's 50 %
    expect(e.parked).to.equal(99);
    const outside = (await run("dmx.explain", { universe: 1, channel: 500 })) as E;
    expect(outside.fixture).to.equal(undefined);
    let refused = "";
    await run("dmx.explain", { universe: 9, channel: 1 }).catch((err: Error) => (refused = err.message));
    expect(refused).to.not.equal("");
  });

  it("lets a forced channel override the show and ordinary rules, never a locked one", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-locked-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    const channels = (await run("venue.fixture.channels")) as { id: string; channels: { offset: number; name: string }[] }[];
    const name = channels.find((f) => f.id === "bar-0")!.channels.find((c) => c.offset === 2)!.name;
    const out = () => plugin.engine.render()[0]![2];
    await run("rule.put", { rule: { id: "plafond", name: "Plafond", level: "show", target: { channel: name }, max: 100 } });
    await run("dmx.set", { universe: 1, channel: 3, value: 250 });
    expect(out()).to.equal(250); // the technician's forcing passes an ordinary rule
    await run("rule.put", { rule: { id: "plafond", name: "Plafond", level: "venue", target: { channel: name }, max: 100, locked: true } });
    expect(out()).to.equal(100); // a locked one holds
    const e = (await run("dmx.explain", { universe: 1, channel: 3 })) as { value: number; rules?: { rule: string }[] };
    expect(JSON.stringify(e)).to.contain("plafond"); // and it says so
  });
});
