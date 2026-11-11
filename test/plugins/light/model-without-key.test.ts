import { expect } from "chai";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

/**
 * A model whose manufacturer has no letter or digit has no model key (venue/overrides.ts modelKey):
 * its model-wide settings are refused, but each fixture's own settings (heads, wheel) still work.
 */
describe("a model named without a letter or digit", () => {
  let dataRoot: string;
  let plugin: LightPlugin;
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  const unkeyed = (file: string) => readFileSync(new URL(`../../fixtures/${file}`, import.meta.url), "utf8").replace("<Manufacturer>Test</Manufacturer>", "<Manufacturer>★</Manufacturer>");

  before(async () => {
    dataRoot = join(mkdtempSync(join(tmpdir(), "light-unkeyed-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    writeFileSync(join(dataRoot, "fixtures", "wheel-spot.qxf"), unkeyed("wheel-spot.qxf"));
    writeFileSync(join(dataRoot, "fixtures", "bar4.qxf"), unkeyed("bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    await run("venue.fixture.put", { fixture: { id: "roue", name: "Lyre à roue", manufacturer: "★", model: "Wheel Spot", mode: "Standard", universe: 1, address: 60 } });
    await run("venue.fixture.put", { fixture: { id: "bar", name: "Barre", manufacturer: "★", model: "Bar 4", mode: "15 Channel", universe: 1, address: 30 } });
  });
  after(async () => {
    await plugin.stop();
    rmSync(join(dataRoot, ".."), { recursive: true, force: true });
  });

  it("still has its wheel, set per fixture; the model scope is refused, not said « no wheel »", async () => {
    const got = (await run("venue.wheel.get", { id: "roue" })) as { model: unknown; applies: string } | null;
    expect(got).to.not.equal(null);
    expect(got).to.deep.include({ model: null, applies: "definition" });
    await run("venue.wheel.put", { id: "roue", scope: "fixture", wheel: { doubles: false } });
    expect(await run("venue.wheel.get", { id: "roue" })).to.deep.include({ applies: "fixture", own: { doubles: false } });
    const err = await run("venue.wheel.put", { id: "roue", scope: "model", wheel: { doubles: false } }).then(() => "set", (e: Error) => e.message);
    expect(err).to.match(/lettre ni chiffre|letter or digit/);
    expect(await run("venue.wheel.clear", { id: "roue", scope: "model" })).to.deep.equal({ cleared: false });
    expect(await run("venue.wheel.clear", { id: "roue", scope: "fixture" })).to.deep.equal({ cleared: true });
  });

  it("takes its own heads settings without a model key", async () => {
    const got = (await run("venue.fixture.heads.set", { fixture: "bar", scope: "fixture", follow: false })) as { overrides: { fixture?: unknown } };
    expect(got.overrides.fixture).to.deep.equal({ follow: false });
    const err = await run("venue.fixture.heads.set", { fixture: "bar", scope: "model", follow: false }).then(() => "set", (e: Error) => e.message);
    expect(err).to.match(/lettre ni chiffre|letter or digit/);
  });
});
