import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { flashesPerLoop, flashesPerSecond, flashesWithin, flashProfile, playOrder } from "../../../src/plugins/light/show/flashes.js";

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

  it("has no flash rate without a step or a step duration, and never divides by zero", () => {
    expect(flashesPerSecond([], 0.5, 0)).to.equal(0);
    expect(flashesPerSecond([[lit], [dark]], 0, 0)).to.equal(0);
    expect(flashesPerSecond([[lit], [dark]], 0.5, 0)).to.equal(1); // one flash per loop of two steps of 0.5 s
  });

  it("counts an untouched cell as dark for a preview, which draws it hatched and dark, but not for the stage, which keeps its level", () => {
    const steps = [[lit], [null as never]];
    expect(flashesPerLoop(steps, 0)).to.equal(0); // the stage: the lit level stays
    expect(flashesPerLoop(steps, 0, "loop", true)).to.equal(1); // the preview: lit, then dark: one flash a loop
  });

  it("raises a random or weighted order to one flash every two steps for a look that has a dark and a lit step", () => {
    const steps = [[dark], [{ red: 0.3, green: 0.3, blue: 0.3 }], [lit]]; // the loop never goes dark then lit
    expect(flashesPerLoop(steps, 0, "loop")).to.equal(0);
    expect(flashesPerSecond(steps, 0.05, 0, "loop")).to.equal(0);
    expect(flashesPerLoop(steps, 0, "random")).to.equal(1);
    expect(flashesPerSecond(steps, 0.05, 0, "random")).to.be.closeTo(10, 1e-9); // 1 / (2 × 0.05 s)
    expect(flashesPerSecond(steps, 0.05, 0, "weighted")).to.be.closeTo(10, 1e-9);
    expect(flashesPerSecond([[lit], [lit]], 0.05, 0, "random")).to.equal(0); // never dark: no flash
    expect(flashesPerSecond(steps, 0.05, 1, "random")).to.equal(0); // a fade is not a flash
  });

  it("counts flashes along the order the steps are played: ping-pong goes there and back", () => {
    const steps = [[lit], [dark], [lit]];
    expect(playOrder(3, "loop")).to.deep.equal([0, 1, 2]);
    expect(playOrder(3, "pingpong")).to.deep.equal([0, 1, 2, 1]); // the ends are not played twice
    expect(playOrder(4, "pingpong")).to.deep.equal([0, 1, 2, 3, 2, 1]);
    expect(playOrder(2, "pingpong")).to.deep.equal([0, 1]);
    expect(flashesPerLoop(steps, 0, "loop")).to.equal(1);
    expect(flashesPerLoop(steps, 0, "pingpong")).to.equal(2); // lit, dark, lit, dark, ...: two flashes every four steps
    expect(flashesPerSecond(steps, 0.125, 0, "loop")).to.equal(3); // the 8 steps of a second hold 3 flashes of a cycle of 3 steps: the average said 2.7
    expect(flashesPerSecond(steps, 0.125, 0, "pingpong")).to.equal(4); // over the 3 s limit: the loop count said 2.7
  });

  it("counts the worst second, not the average of the cycle: a burst then a long dark spell is still a burst", () => {
    const burst = [...Array.from({ length: 5 }, () => [[lit], [dark]]).flat(), ...Array.from({ length: 30 }, () => [dark])]; // 5 flashes in 10 steps, then 30 dark
    expect(flashesPerLoop(burst, 0)).to.equal(5);
    expect(flashesPerSecond(burst, 0.05, 0)).to.equal(5); // 5 flashes in half a second; the average over the 2 s cycle said 2.5
    expect(flashesPerSecond(burst, 0.5, 0)).to.equal(1); // slowed down, a second holds 2 steps
    expect(flashesPerSecond(burst, 1 / 3, 0)).to.equal(2); // 3 steps start in a second: at most 2 flashes among 3 changes
    expect(flashProfile(burst, 0).windows[10]).to.equal(5);
  });

  it("counts the steps that start in one second, and whole cycles beyond the profile", () => {
    const profile = { perLoop: 2, period: 4, windows: [0, 1, 1, 2, 2] };
    expect(flashesWithin(profile, 3)).to.equal(2);
    expect(flashesWithin(profile, 4)).to.equal(2);
    expect(flashesWithin(profile, 9)).to.equal(5); // two cycles, then one step
    expect(flashesWithin({ perLoop: 0, period: 0, windows: [0] }, 5)).to.equal(0);
  });

  it("counts a fade out of an untouched cell for a preview, which cuts there, but not a fade between real levels", () => {
    expect(flashesPerLoop([[lit], [null as never]], 0.5, "loop", true)).to.equal(1); // back to the first step, out of the untouched cell: cut, not fade
    expect(flashesPerLoop([[lit], [lit], [null as never]], 0.5, "pingpong", true)).to.equal(1); // there and back: a cut at each end only counts once a cycle
    expect(flashesPerLoop([[dark], [lit]], 0.5, "loop", true)).to.equal(0); // a real dark fades up
    expect(flashesPerLoop([[null as never], [lit]], 0.5, "loop")).to.equal(0); // the stage keeps its level and fades: no flash
    expect(flashesPerLoop([[null as never], [lit]], 0, "loop", true)).to.equal(1);
    // random: a fading look flashes only through a cut
    expect(flashProfile([[null as never], [lit]], 0.5, "random", true)).to.deep.equal({ perLoop: 1, period: 2, windows: [0, 1, 1] });
    expect(flashProfile([[dark], [lit]], 0.5, "random", true).perLoop).to.equal(0);
  });

  it("counts flashes per loop", () => {
    expect(flashesPerLoop([[lit], [dark]], 0)).to.equal(1); // alternating lit/dark: 1 flash
    expect(flashesPerLoop([[lit], [dark]], 1)).to.equal(0); // a fading attack ramps, no flash
    expect(flashesPerLoop([[lit]], 0)).to.equal(0); // a single step
    expect(flashesPerLoop([[lit, dark], [dark, lit]], 0)).to.equal(1); // the worst cell, still an integer
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

  it("refuses a look a reject rule would bound, and asks first for a confirm rule", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-strict-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    const as = (origin: "ui" | "midi") => (name: string, args: unknown) => plugin.commands.invoke(name, args, { origin, can: () => true });
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    const canvas = plugin.runtime.venue.canvases.list()[0]!.id;
    const channels = (await run("venue.fixture.channels")) as { id: string; channels: { offset: number; name: string }[] }[];
    const name = channels.find((f) => f.id === "bar-0")!.channels.find((c) => c.offset === 2)!.name;
    const machine = (id: string, value: number) => ({ id, name: id, canvas, technique: { kind: "aucune" }, timing: { every: { beats: 1 }, attack: 0, order: "loop", entryFade: 0 }, channels: { targets: [{ fixture: "bar-0", offset: 2 }], steps: [[value]] } });
    await run("look.put", { look: machine("fort", 200) });
    await run("look.put", { look: machine("sage", 80) });
    await run("rule.put", { rule: { id: "plafond", name: "Plafond", level: "show", target: { channel: name }, max: 100, onViolation: "reject" } });
    let refused: { message: string; detail?: { confirm?: boolean } } = { message: "" };
    await as("ui")("look.go", { id: "fort" }).catch((e) => (refused = e));
    expect(refused.message).to.contain("look refusé").and.contain("Plafond");
    expect(plugin.runtime.activeLooks()).to.not.include("fort");
    await as("ui")("look.go", { id: "sage" }); // under the bound: launched
    expect(plugin.runtime.activeLooks()).to.include("sage");
    await run("look.stopall");
    // a confirm rule: the interface is asked, MIDI cannot answer
    await run("rule.put", { rule: { id: "plafond", name: "Plafond", level: "show", target: { channel: name }, max: 100, onViolation: "confirm" } });
    await as("ui")("look.go", { id: "fort" }).catch((e) => (refused = e));
    expect(refused.detail?.confirm).to.equal(true);
    expect(plugin.runtime.activeLooks()).to.not.include("fort");
    await as("midi")("look.go", { id: "fort" }).catch((e) => (refused = e));
    expect(refused.detail?.confirm).to.equal(false);
    await as("ui")("look.go", { id: "fort", confirm: true }); // on the user's yes: launched, and bounded
    expect(plugin.runtime.activeLooks()).to.include("fort");
    await run("look.stopall");
    // for some callers only: AI clients and a volunteer may not launch it, the interface may, unbounded
    await run("rule.delete", { where: "show", id: "plafond" });
    await run("rule.put", { rule: { id: "ia", name: "Pas pour l'IA", level: "show", target: { channel: name }, max: 100, appliesTo: { origins: ["mcp"], roles: ["benevole"] } } });
    await plugin.commands.invoke("look.go", { id: "fort" }, { origin: "mcp", can: () => true }).catch((e) => (refused = e));
    expect(refused.message).to.contain("Pas pour l'IA");
    await plugin.commands.invoke("look.go", { id: "fort" }, { origin: "ui", role: "benevole", can: () => true }).catch((e) => (refused = e));
    expect(plugin.runtime.activeLooks()).to.not.include("fort");
    await as("ui")("look.go", { id: "fort" });
    expect(plugin.runtime.activeLooks()).to.include("fort");
    const channelValue = plugin.engine.render()[0]![2];
    expect(channelValue).to.equal(200); // the output is not bounded by it
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

  it("returns flashes in look.preview", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-preview-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    const canvas = plugin.runtime.venue.canvases.list()[0]!.id;
    const look = (attack: number) => ({ id: `l-${attack}`, name: `l-${attack}`, canvas, technique: { kind: "pas", steps: [["#ffffff"], ["-"]] }, timing: { every: { seconds: 0.1 }, attack, order: "loop", entryFade: 0 } });
    const flashing = (await run("look.preview", { look: look(0) })) as { flashes: { perLoop: number; period: number; max: number } };
    expect(flashing.flashes).to.deep.equal({ perLoop: 1, period: 2, windows: [0, 1, 1], max: 3 }); // a loop: the cycle is the steps
    const fading = (await run("look.preview", { look: look(1) })) as { flashes: { perLoop: number } };
    expect(fading.flashes.perLoop).to.equal(0);
    // ping-pong: the cycle is longer than the steps, and the answer says so
    const back = { id: "l-pp", name: "l-pp", canvas, technique: { kind: "pas", steps: [["#ffffff"], ["-"], ["#ffffff"]] }, timing: { every: { seconds: 0.125 }, attack: 0, order: "pingpong", entryFade: 0 } };
    const pingpong = (await run("look.preview", { look: back })) as { flashes: { perLoop: number; period: number; max: number } };
    expect(pingpong.flashes).to.deep.equal({ perLoop: 2, period: 4, windows: [0, 1, 1, 2, 2], max: 3 });
  });
});
