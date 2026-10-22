import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { parseQxf } from "../../../src/plugins/light/venue/qxf-import.js";
import { parseQxw } from "../../../src/plugins/light/presets/qxw-import.js";
import { qxwToShow } from "../../../src/plugins/light/presets/qxw-to-show.js";

const fixture = (n: string) => readFileSync(new URL(`../../fixtures/${n}`, import.meta.url), "utf8");

describe("QLC+ workspace → venue + show", () => {
  const p = qxwToShow(parseQxw(fixture("synthetic.qxw")), [parseQxf(fixture("bar4.qxf"))]);

  it("names each missing definition once, so the page can ask for it", () => {
    expect(p.report.missingDefinitions).to.deep.equal([]);
    const without = qxwToShow(parseQxw(fixture("synthetic.qxw")), []);
    expect(without.report.missingDefinitions).to.have.length(1); // two bars of one model, one entry
    expect(without.report.missingDefinitions[0]).to.match(/Bar 4 \(.+\)$/);
  });

  it("patches fixtures with 1-based universes and addresses", () => {
    expect(p.fixtures.map((f) => [f.id, f.universe, f.address])).to.deep.equal([
      ["bar-0", 1, 1],
      ["bar-1", 1, 16],
    ]);
  });

  it("builds a canvas from the decoded cells", () => {
    expect(p.canvas!.cells).to.equal(8);
    expect(p.canvas!.render[5]).to.deep.equal({ from: 5, to: 5, targets: [{ fixture: "bar-1", head: 1 }] });
  });

  it("imports sequences as exact steps tagged with the recognised technique", () => {
    const checker = p.looks.find((l) => l.name === "checker")!;
    expect(checker.technique.kind).to.equal("pas");
    expect(checker.tags).to.include("technique:damier");
    const steps = (checker.technique as { steps: string[][] }).steps;
    expect(steps[0]!.slice(0, 4)).to.deep.equal(["#ff0000", "#ff0000", "#0000ff", "#0000ff"]);
    expect(p.looks.find((l) => l.name === "hole")!.tags).to.include("technique:creux qui tourne");
  });

  it("derives cadence and attack from the speed dial multipliers (6/6/6 = 1 beat, breathing)", () => {
    expect(p.looks.find((l) => l.name === "checker")!.timing).to.include({ attack: 1, order: "loop" });
    expect(p.looks.find((l) => l.name === "checker")!.timing.every).to.deep.equal({ beats: 1 });
    expect(p.looks.find((l) => l.name === "palette")!.timing.order).to.equal("random");
    expect(p.tempoFromMidiClock).to.equal(true);
  });

  it("turns solo frames into exclusive groups and dimmer sliders into masters", () => {
    const solo = p.groups.find((g) => g.exclusive)!;
    expect(solo.members.looks).to.deep.equal(["checker", "palette"]);
    const master = p.groups.find((g) => g.master)!;
    expect(master.members.fixtures).to.deep.equal(["bar-0", "bar-1"]);
  });

  it("keeps the same MIDI notes and CCs", () => {
    expect(p.mappings.map((m) => [m.input.type, m.input.channel, m.input.number, m.on.command])).to.have.deep.members([
      ["note", 1, 36, "look.go"],
      ["note", 2, 37, "look.go"],
      ["cc", 1, 7, "group.level"],
    ]);
    expect(p.mappings.find((m) => m.input.type === "cc")!.levelArg).to.equal("level");
  });
});

describe("QLC+ EFX → Move FX", () => {
  const p = qxwToShow(parseQxw(fixture("efx.qxw")), [parseQxf(fixture("spot.qxf"))]);

  it("turns an EFX into a position-only look moving a group of its fixtures", () => {
    const circle = p.looks.find((l) => l.name === "Cercle lent")!;
    expect(circle.technique).to.deep.equal({ kind: "aucune" });
    expect(circle.move).to.deep.include({ shape: "cercle", every: { seconds: 8 }, spread: 0.5, reverse: false, group: "efx-cercle-lent" }); // serial: 2 heads half a cycle apart
    expect(circle.move!.center.pan).to.be.closeTo(127 / 255, 1e-9);
    expect(circle.move!.center.tilt).to.be.closeTo(191 / 255, 1e-9);
    expect(circle.move!.size.pan).to.be.closeTo(64 / 255, 1e-9);
    expect(circle.tags).to.include.members(["technique:efx-circle", "dossier:Mouvements"]);
    expect(p.groups.find((g) => g.id === "efx-cercle-lent")!.members.fixtures).to.deep.equal(["spot-a", "spot-b"]);
  });

  it("approximates the shapes it does not have, and says so", () => {
    const liss = p.looks.find((l) => l.name === "Lissajous")!;
    expect(liss.move).to.deep.include({ shape: "cercle", reverse: true, spread: 0 });
    expect(p.report.warnings.join("\n")).to.match(/Lissajous approximée par un cercle/).and.match(/rotation de 45° ignorée/);
  });

  it("skips colour-only EFX, builds a canvas for a moving-head rig, and keeps the MIDI button", () => {
    expect(p.looks.map((l) => l.name)).to.not.include("Couleurs seules");
    expect(p.report.warnings.join("\n")).to.match(/« Couleurs seules » : les parties gradateur ou RGB ne sont pas converties/);
    expect(p.canvas).to.deep.include({ id: "qlc", cells: 2 });
    expect(p.mappings.map((m) => [m.input.number, m.on.command, m.on.args.id])).to.deep.equal([[60, "look.go", "cercle-lent"]]);
  });

  it("applies, then the heads really move on the output", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-efx-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), join(dataRoot, "fixtures", "spot.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("import.qxw", { xml: fixture("efx.qxw"), apply: true });
    await run("look.go", { id: "cercle-lent" });
    expect(plugin.runtime.movedBy(plugin.runtime.looks.get("cercle-lent")!)).to.deep.equal(["spot-a", "spot-b"]);
    const pan = () => {
      const b = plugin.engine.render()[0]!;
      return [(b[0]! << 8) | b[1]!, (b[10]! << 8) | b[11]!];
    };
    const first = pan();
    await new Promise((r) => setTimeout(r, 300));
    const later = pan();
    expect(later[0]).to.not.equal(first[0]); // moving
    expect(first[0]).to.not.equal(first[1]); // serial propagation: the two heads are out of phase
  });
});

describe("QLC+ faders → channel faders and DCAs", () => {
  const p = qxwToShow(parseQxw(fixture("faders.qxw")), [parseQxf(fixture("bar4.qxf"))]);

  it("turns a level slider on other channels into a channel fader, even without a definition", () => {
    expect(p.faders.filter((f) => f.id === "strobe-et-fumee")).to.deep.equal([
      { id: "strobe-et-fumee", name: "Strobe et fumee", channels: [{ fixture: "bar-0", offset: 1 }, { fixture: "fumee", offset: 0 }], level: 0, notes: "Importé de QLC+ (fader #31, 2 canal(aux) hors gradateur)." },
    ]);
  });

  it("keeps a slider's limits (« 0 to 200 »): on the channel fader's range, on the DCA's limits", () => {
    expect(p.faders.find((f) => f.id === "ventilation")!.range).to.deep.equal({ min: 0, max: 200 });
    expect(p.faders.find((f) => f.id === "strobe-et-fumee")).to.not.have.property("range"); // 0..255: nothing to say
    expect(p.groups.find((g) => g.id === "dim-banque")!.limits).to.deep.equal({ min: 0, max: 127 / 255, mode: "scale" });
  });

  it("keeps dimmer sliders as DCAs and turns a submaster into a DCA dosing its frame's looks", () => {
    expect(p.groups.find((g) => g.id === "dim")!.members.fixtures).to.deep.equal(["bar-0"]);
    const sub = p.groups.find((g) => g.id === "sub-ambiance")!;
    expect(sub.master).to.not.equal(undefined);
    expect(sub.presets.included).to.deep.equal(["rouge", "bleu"]);
  });

  it("imports a scene a button starts as a one-step look, its fade in as the entry fade", () => {
    const scene = p.looks.find((l) => l.id === "face-rouge")!;
    expect((scene.technique as { steps: string[][] }).steps).to.have.length(1);
    expect((scene.technique as { steps: string[][] }).steps[0]!.slice(0, 4)).to.deep.equal(["#ff0000", "#ff0000", "#ff0000", "#ff0000"]);
    expect(scene.timing.entryFade).to.equal(2);
    expect(p.looks.find((l) => l.id === "liee")).to.equal(undefined); // no widget starts it
    expect(p.mappings.find((m) => m.on.args.id === "face-rouge")!.input.number).to.equal(39);
  });

  it("turns a submaster among level sliders into a DCA over their DCAs and channel faders", () => {
    const sub = p.groups.find((g) => g.id === "sub-banque")!;
    expect(sub.master).to.not.equal(undefined);
    expect(sub.members.groups).to.deep.equal(["dim-banque"]);
    expect(p.faders.find((f) => f.id === "ventilation")!.dca).to.equal("sub-banque");
    expect(p.faders.find((f) => f.id === "strobe-et-fumee")!.dca).to.equal(undefined); // not in that frame
  });

  it("turns a playback slider into a playback DCA over its scene's look, ignoring its leftover level channels", () => {
    const g = p.groups.find((x) => x.id === "contre")!;
    expect(g).to.deep.include({ playback: true, master: { level: 0, mute: false } });
    expect(g.presets.included).to.deep.equal(["contre-bleu"]);
    expect(p.faders.some((f) => f.name === "Contre")).to.equal(false);
  });

  it("maps each slider's CC to the right command", () => {
    const byCc = Object.fromEntries(p.mappings.filter((m) => m.input.type === "cc").map((m) => [m.input.number, [m.on.command, m.on.args.id, m.levelArg]]));
    expect(byCc).to.deep.equal({
      20: ["group.level", "sub-ambiance", "level"],
      21: ["fader.level", "strobe-et-fumee", "level"],
      22: ["group.level", "dim", "level"],
      24: ["fader.level", "ventilation", "level"],
      25: ["group.level", "sub-banque", "level"],
      26: ["group.level", "dim-banque", "level"],
      27: ["group.level", "contre", "level"],
    });
  });

  it("turns a colourless sequence (a machine) into a look playing raw channels, zeros restored", () => {
    const smoke = p.looks.find((l) => l.id === "bouffees")!;
    expect(smoke.technique).to.deep.equal({ kind: "aucune" });
    expect(smoke.channels).to.deep.equal({ targets: [{ fixture: "fumee", offset: 0 }, { fixture: "fumee", offset: 1 }], steps: [[200, 100], [0, 50]] });
    expect(p.report.warnings).to.include("« vide » : séquence vide — non importée");
    expect(p.mappings.find((m) => m.on.args.id === "bouffees")!.input.number).to.equal(38); // its button's note is kept
  });

  it("applies, then the fader drives its channels (highest takes precedence) and the submaster doses its looks", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-faders-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("import.qxw", { xml: fixture("faders.qxw"), apply: true });
    const out = () => plugin.engine.render()[0]!;
    expect([out()[1], out()[100]]).to.deep.equal([0, 0]); // faders start at 0
    await run("fader.level", { id: "strobe-et-fumee", level: 0.5 });
    expect([out()[1], out()[100]]).to.deep.equal([128, 128]);
    await run("look.go", { id: "rouge" });
    const full = out()[3]!;
    await run("group.level", { id: "sub-ambiance", level: 0.5 });
    expect(out()[3]).to.be.closeTo(full / 2, 1);
    await run("fader.level", { id: "ventilation", level: 1 });
    await run("group.level", { id: "sub-banque", level: 0.5 });
    expect(out()[101]).to.equal(100); // the submaster doses the fader of its frame, at full 200 (its QLC+ limit)
    await run("fader.level", { id: "ventilation", level: 0 });
    await run("look.stopall");
    await run("group.level", { id: "contre", level: 0.5 });
    expect(plugin.runtime.isActive("contre-bleu")).to.equal(true);
    expect(out()[5]).to.be.closeTo(128, 1); // started and dosed by the fader
    await run("group.level", { id: "contre", level: 0 });
    expect(plugin.runtime.isActive("contre-bleu")).to.equal(false);
    await run("look.go", { id: "contre-bleu" }); // launched by hand: the fader at 0 leaves it
    await run("group.level", { id: "contre", level: 0 });
    expect(plugin.runtime.isActive("contre-bleu")).to.equal(true);
    await run("look.stopall");
    await run("look.go", { id: "bouffees" });
    expect([out()[100], out()[101]]).to.deep.equal([200, 100]); // step 1, even without a definition for the machine
  });
});
