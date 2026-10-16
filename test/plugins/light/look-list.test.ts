import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

describe("look list: brief for buttons, whole for the editor", () => {
  let plugin: LightPlugin;
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());

  before(async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-looks-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
  });

  it("is brief by default: no steps, but what a button and the Show table show", async () => {
    const full = (await run("look.list", { brief: false })) as Record<string, unknown>[];
    const brief = (await run("look.list")) as { id: string; name: string; active: boolean; swatch?: string; technique: Record<string, unknown>; timing: unknown; tags: string[]; notes?: string }[];
    expect(brief.map((l) => l.id)).to.deep.equal(full.map((l) => l.id));
    const checker = brief.find((l) => l.id === "checker")!;
    expect(checker.technique).to.deep.equal({ kind: "pas" });
    expect(checker).to.include.keys("name", "active", "swatch", "timing", "tags");
    expect(checker.notes).to.equal(undefined);
    expect(JSON.stringify(brief).length).to.be.below(JSON.stringify(full).length / 2);
  });

  it("refuses to save a look taken from the brief list, which would drop its steps", async () => {
    const brief = ((await run("look.list")) as { id: string; name: string }[]).find((l) => l.id === "checker")!;
    let refused = "";
    await run("look.put", { look: { ...brief, name: "Renommé" } }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("look.get");
    const whole = (await run("look.get", { id: "checker" })) as Record<string, unknown>;
    await run("look.put", { look: { ...whole, name: "Renommé" } }); // the whole look goes through
    expect(plugin.runtime.looks.get("checker")!.name).to.equal("Renommé");
  });

  it("gives one look whole", async () => {
    const look = (await run("look.get", { id: "checker" })) as { technique: { kind: string; steps?: unknown[] }; active: boolean };
    expect(look.technique.steps).to.be.an("array").that.is.not.empty;
    let refused = "";
    await run("look.get", { id: "nope" }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("look inconnu");
  });
});
