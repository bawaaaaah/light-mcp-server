import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { Venue, type ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";

type Tracks = {
  enabled: boolean;
  applies: "fixture" | "model" | "none";
  channels: { name: string; kind: string; fade: boolean; from: string }[];
  own: string[] | null;
  model: { fade: string[] | null; fixtures: number };
  motion: { pan?: string; tilt?: string } | null;
};

/** A plugin on a temporary data root, two bars bar4 (one model) and a 16-bit spot. */
function plugin() {
  const dataRoot = join(mkdtempSync(join(tmpdir(), "light-tracks-cmd-")), "data");
  mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
  for (const f of ["bar4.qxf", "spot.qxf"]) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(dataRoot, "fixtures", f));
  const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
  const p = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
  const run = (name: string, args: unknown = {}) => p.commands.invoke(name, args, systemContext());
  const get = async (fixture: string) => (await run("venue.tracks.get", { fixture })) as Tracks;
  return { p, run, get, dataRoot };
}
async function patched() {
  const t = plugin();
  for (const [id, address] of [["bar-l", 1], ["bar-r", 16]] as const) await t.run("venue.fixture.put", { fixture: { id, name: id, manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address } });
  await t.run("venue.fixture.put", { fixture: { id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 100 } });
  return t;
}
const ticked = (t: Tracks) => t.channels.filter((c) => c.fade).map((c) => c.name);

describe("fadeable tracks: commands (T5)", () => {
  it("reads a fixture's channels by kind, nothing enabled nor ticked at first", async () => {
    const { get } = await patched();
    const t = await get("bar-l");
    expect([t.enabled, t.applies, t.own, t.model, t.motion]).to.deep.equal([false, "none", null, { fade: null, fixtures: 2 }, null]);
    expect(t.channels.slice(0, 4).map((c) => [c.name, c.kind, c.fade])).to.deep.equal([
      ["Dimmer", "dimmer", false],
      ["Strobe", "other", false],
      ["Program", "other", false],
      ["R1", "colour", false],
    ]);
  });

  it("sets the list on the model, enables per fixture, overrides it on one and goes back to the model", async () => {
    const { run, get } = await patched();
    await run("venue.tracks.put", { fixtures: ["bar-l"], scope: "model", fade: ["Dimmer", "R1"] });
    expect([(await get("bar-r")).applies, ticked(await get("bar-r"))]).to.deep.equal(["model", ["Dimmer", "R1"]]);
    // several fixtures enabled in one command
    await run("venue.tracks.put", { fixtures: ["bar-l", "bar-r"], enabled: true });
    expect([(await get("bar-l")).enabled, (await get("bar-r")).enabled]).to.deep.equal([true, true]);
    const own = (await run("venue.tracks.put", { fixtures: ["bar-l"], fade: ["Dimmer"] })) as Tracks;
    expect([own.applies, ticked(own), own.own]).to.deep.equal(["fixture", ["Dimmer"], ["Dimmer"]]);
    expect(ticked(await get("bar-r"))).to.deep.equal(["Dimmer", "R1"]); // the other still follows the model
    const back = (await run("venue.tracks.clear", { fixture: "bar-l" })) as Tracks;
    expect([back.applies, back.enabled, ticked(back)]).to.deep.equal(["model", true, ["Dimmer", "R1"]]); // still enabled
    await run("venue.tracks.clear", { fixture: "bar-l", scope: "model" });
    expect([(await get("bar-l")).applies, ticked(await get("bar-l"))]).to.deep.equal(["none", []]);
  });

  it("refuses `enabled` on a model, an unknown or fine channel name, and fixtures of two models", async () => {
    const { run } = await patched();
    const refused = async (args: object, pattern: RegExp) => {
      let message = "";
      try {
        await run("venue.tracks.put", args);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).to.match(pattern);
    };
    await refused({ fixtures: ["bar-l"], scope: "model", enabled: true }, /pas sur le modèle|not on its model/);
    await refused({ fixtures: ["bar-l"], fade: ["Nope"] }, /Nope.*(canaux|channels).*Dimmer/);
    await refused({ fixtures: ["spot"], fade: ["Pan fine"] }, /fin|fine/);
    await refused({ fixtures: ["bar-l", "spot"], scope: "model", fade: ["Dimmer"] }, /même modèle|one model/);
  });

  it("tells the motion layer, per axis, what to do with pan and tilt", async () => {
    const { run, get } = await patched();
    await run("venue.tracks.put", { fixtures: ["spot"], enabled: true, fade: ["Pan", "Dimmer"] });
    expect((await get("spot")).motion).to.deep.equal({ pan: "glide", tilt: "cut" });
    expect((await get("spot")).channels.map((c) => c.name)).to.not.include("Pan fine");
  });

  it("keeps the parts on disk, tells why a channel jumps, and notes a fixture where nothing fades", async () => {
    const { p, run, dataRoot } = await patched();
    await run("venue.tracks.put", { fixtures: ["bar-l"], scope: "model", fade: ["Dimmer"] });
    await run("venue.tracks.put", { fixtures: ["bar-l"], enabled: true });
    await run("venue.tracks.put", { fixtures: ["bar-r"], enabled: true, fade: [] });
    // a venue opened again from disk reads the same tracks (no part dropped by a schema)
    const again = new Venue(new FolderStore(p.venue.store.root), [join(dataRoot, "fixtures")]);
    expect([...(again.resolve("bar-l") as ResolvedFixture).tracks!.fade]).to.deep.equal([0]);
    const explain = async (channel: number) => ((await run("dmx.explain", { universe: 1, channel })) as { track?: string }).track;
    expect([await explain(1), await explain(3), await explain(100)]).to.deep.equal(["fade", "jump", undefined]);
    const lint = (await run("show.lint")) as { issues: { level: string; where: string; message: string }[] } | { level: string; where: string; message: string }[];
    const issues = Array.isArray(lint) ? lint : lint.issues;
    expect(issues.filter((i) => /bar-r/.test(i.where) && /rien ne fond|nothing fades/.test(i.message))).to.have.length(1);
    expect(issues.filter((i) => /bar-l/.test(i.where) && /rien ne fond|nothing fades/.test(i.message))).to.have.length(0);
  });
});
