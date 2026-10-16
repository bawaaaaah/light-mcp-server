import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { flashesPerSecond } from "../../../src/plugins/light/show/flashes.js";

const lit = { red: 1, green: 1, blue: 1 };
const dark = { red: 0, green: 0, blue: 0 };
const blue = { red: 0, green: 0, blue: 1 };

describe("flashes per second (photosensitive safety)", () => {
  it("counts dark-to-lit changes over the loop", () => {
    expect(flashesPerSecond([[lit], [dark]], 0.1, 0)).to.be.closeTo(5, 1e-9); // one flash every 0.2 s
    expect(flashesPerSecond([[lit], [dark]], 0.1, 0.5)).to.equal(0); // a fading attack ramps, no flash
    expect(flashesPerSecond([[lit], [null], [dark], [null]], 0.25, 0)).to.be.closeTo(1, 1e-9); // untouched keeps its level
    expect(flashesPerSecond([[lit], [blue]], 0.05, 0)).to.equal(0); // a palette always lit does not flash
    expect(flashesPerSecond([[lit, dark], [dark, lit]], 0.1, 0)).to.be.closeTo(5, 1e-9); // the worst cell
  });

  it("warns in the show check for a look flashing faster than 3 times a second", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-flash-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    const canvas = plugin.runtime.venue.canvases.list()[0]!.id;
    const look = (id: string, seconds: number, attack: number) => ({ id, name: id, canvas, technique: { kind: "pas", steps: [["#ffffff"], ["-"]] }, timing: { every: { seconds }, attack, order: "loop", entryFade: 0 } });
    await run("look.put", { look: look("strobe-vite", 0.05, 0) }); // 10 flashes a second
    await run("look.put", { look: look("doux", 0.05, 1) }); // the same, faded
    await run("look.put", { look: look("lent", 0.5, 0) }); // 1 flash a second
    const lint = (await run("show.lint")) as { issues: { where: string; message: string }[] };
    const flagged = lint.issues.filter((i) => i.message.includes("photosensibles")).map((i) => i.where);
    expect(flagged).to.include("look strobe-vite").and.not.include.members(["look doux", "look lent"]);
  });

  it("flags a look whose raw channel the rules bring back, and says by how much", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-bound-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    const canvas = plugin.runtime.venue.canvases.list()[0]!.id;
    const channels = (await run("venue.fixture.channels")) as { id: string; channels: { offset: number; name: string }[] }[];
    const name = channels.find((f) => f.id === "bar-0")!.channels.find((c) => c.offset === 2)!.name;
    await run("rule.put", { rule: { id: "plafond", name: "Plafond", level: "show", scope: {}, target: { channel: name }, max: 100 } });
    const machine = (id: string, value: number) => ({ id, name: id, canvas, technique: { kind: "aucune" }, timing: { every: { beats: 1 }, attack: 0, order: "loop", entryFade: 0 }, channels: { targets: [{ fixture: "bar-0", offset: 2 }], steps: [[value]] } });
    await run("look.put", { look: machine("trop-fort", 200) });
    await run("look.put", { look: machine("sage", 80) });
    const lint = (await run("show.lint")) as { issues: { where: string; message: string }[] };
    const bound = lint.issues.filter((i) => i.message.includes("le ramène"));
    expect(bound.map((i) => i.where)).to.deep.equal(["look trop-fort"]);
    expect(bound[0]!.message).to.contain(`${name} à 200`).and.contain("à 100");
  });

  it("says where a « Hz max » does nothing: definitions without strobe frequencies", async () => {
    const blindTo = async (qxf: string) => {
      const dataRoot = join(mkdtempSync(join(tmpdir(), "light-hz-")), "data");
      mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
      writeFileSync(join(dataRoot, "fixtures", "bar4.qxf"), qxf);
      const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
      const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
      await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
      await run("rule.put", { rule: { id: "photo", name: "Photosensibles", level: "venue", scope: {}, target: { attribute: "strobe" }, maxHz: 3 } });
      const lint = (await run("show.lint")) as { issues: { where: string; message: string }[] };
      return lint.issues.filter((i) => i.message.includes("Hz max sans effet"));
    };
    const bar4 = readFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), "utf8");
    const blind = await blindTo(bar4);
    expect(blind.map((i) => i.where)).to.deep.equal(["règle photo"]);
    expect(await blindTo(bar4.replace('Preset="StrobeSlowToFast"', 'Preset="StrobeFreqRange" Res1="1" Res2="25"'))).to.deep.equal([]);
  });
});
