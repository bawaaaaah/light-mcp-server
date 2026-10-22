import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { mergeColors, type AttributeFrame } from "../../../src/plugins/light/venue/venue.js";

const sheet = (entries: [string, [number, Record<string, number>][]][]): AttributeFrame["colors"] => new Map(entries.map(([f, heads]) => [f, new Map(heads)]));
const plain = (c: AttributeFrame["colors"]) => Object.fromEntries([...c].map(([f, heads]) => [f, Object.fromEntries(heads)]));

describe("several looks on the same fixtures", () => {
  it("the last one covers, or each colour keeps its highest value", () => {
    const red = sheet([["bar", [[-1, { red: 1 }]]]]);
    const blue = sheet([["bar", [[-1, { blue: 1, red: 0 }]]]]);
    const last = sheet([]);
    mergeColors(last, red, "last");
    mergeColors(last, blue, "last");
    expect(plain(last)).to.deep.equal({ bar: { "-1": { blue: 1, red: 0 } } });
    const high = sheet([]);
    mergeColors(high, red, "highest");
    mergeColors(high, blue, "highest");
    expect(plain(high)).to.deep.equal({ bar: { "-1": { red: 1, blue: 1 } } }); // magenta: black never darkens
  });

  it("a whole fixture and its heads add up as the output reads them", () => {
    const into = sheet([["bar", [[-1, { red: 0.5 }]]]]); // a look on the whole bar
    mergeColors(into, sheet([["bar", [[0, { blue: 1 }]]]]), "highest"); // another on its first head only
    expect(plain(into)).to.deep.equal({ bar: { "-1": { red: 0.5 }, 0: { red: 0.5, blue: 1 } } }); // head 0 keeps the whole bar's red
    mergeColors(into, sheet([["bar", [[-1, { green: 1 }]]]]), "highest"); // a third on the whole bar
    expect(plain(into)).to.deep.equal({ bar: { "-1": { red: 0.5, green: 1 }, 0: { red: 0.5, blue: 1, green: 1 } } });
  });

  it("is a show setting, played at once on the output", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-merge-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("venue.fixture.put", { fixture: { id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1 } });
    await run("venue.canvas.put", { canvas: { id: "mur", name: "Mur", cells: 4, render: [{ from: 0, to: 3, targets: [{ fixture: "bar", head: -1 }] }] } });
    await run("look.put", { look: { id: "rouge", name: "Rouge", canvas: "mur", technique: { kind: "plat", color: "#ff0000" } } });
    await run("look.put", { look: { id: "bleu", name: "Bleu", canvas: "mur", technique: { kind: "plat", color: "#0000ff" } } });
    const [bar] = (await run("venue.fixture.channels")) as { channels: { offset: number; color?: string }[] }[];
    const offset = (c: string) => bar!.channels.find((x) => x.color === c)!.offset;
    const out = () => {
      const buffers = [new Uint8Array(512)];
      plugin.runtime.render(buffers);
      return { red: buffers[0]![offset("red")], blue: buffers[0]![offset("blue")] };
    };
    await run("look.go", { id: "rouge" });
    await run("look.go", { id: "bleu" });
    expect(((await run("show.settings")) as { looksMerge: string }).looksMerge).to.equal("last"); // as before, by default
    expect(out()).to.deep.equal({ red: 0, blue: 255 }); // the last one started covers
    await run("show.settings.set", { looksMerge: "highest" });
    expect(out()).to.deep.equal({ red: 255, blue: 255 }); // they add up
    await run("look.stop", { id: "bleu" });
    expect(out()).to.deep.equal({ red: 255, blue: 0 });
  });
});
