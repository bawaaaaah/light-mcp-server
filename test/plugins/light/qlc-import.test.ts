import { expect } from "chai";
import { readFileSync } from "node:fs";
import { capabilityTags, findMode, parseQxf } from "../../../src/plugins/light/venue/qxf-import.js";
import { decodeMidiInput, parseQxw, parseStepValues } from "../../../src/plugins/light/presets/qxw-import.js";
import { analyzeWorkspace } from "../../../src/plugins/light/presets/qxw-analyze.js";

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");
const def = parseQxf(fixture("bar4.qxf"));
const ws = parseQxw(fixture("synthetic.qxw"));

describe("QLC+ fixture definition import", () => {
  it("reads channels, colours, tags and heads", () => {
    expect(def.model).to.equal("Bar 4");
    expect(def.channels.get("R1")).to.include({ attribute: "color", color: "red" });
    expect(def.channels.get("Dimmer")!.attribute).to.equal("intensity");
    expect(def.channels.get("Strobe")!.tags).to.include("strobe");
    expect(def.channels.get("Program")!.tags).to.include.members(["autoProgram", "soundActive"]);
    expect(def.modes[0]!.heads).to.deep.equal([[3, 4, 5], [6, 7, 8], [9, 10, 11], [12, 13, 14]]);
  });

  it("matches mode names loosely across QLC+ versions", () => {
    expect(findMode(def, "15-channel")?.name).to.equal("15 Channel");
    expect(findMode(def, "15 Channels")?.name).to.equal("15 Channel");
  });

  it("tags capabilities from their names", () => {
    expect(capabilityTags("Sound Control")).to.include("soundActive");
    expect(capabilityTags("Strobe Off")).to.not.include("strobe");
  });
});

describe("QLC+ workspace import", () => {
  it("parses step values", () => {
    const v = parseStepValues("0:3,255,4,10:1:5,7");
    expect([...v.get(0)!]).to.deep.equal([
      [3, 255],
      [4, 10],
    ]);
    expect(v.get(1)!.get(5)).to.equal(7);
  });

  it("decodes QLC+ MIDI input channels", () => {
    expect(decodeMidiInput(164)).to.deep.equal({ kind: "note", channel: 1, note: 36 });
    expect(decodeMidiInput(7)).to.deep.equal({ kind: "cc", channel: 1, controller: 7 });
    expect(decodeMidiInput(4096 + 165)).to.deep.equal({ kind: "note", channel: 2, note: 37 });
    expect(decodeMidiInput(530)).to.deep.equal({ kind: "clock", what: "beat" });
  });

  it("reads fixtures, functions and the virtual console", () => {
    expect(ws.fixtures).to.have.length(2);
    expect(ws.functions.get(20)).to.include({ type: "Sequence", runOrder: "Random" });
    const buttons = ws.widgets.filter((w) => w.kind === "button");
    expect(buttons.map((b) => b.soloFrame)).to.deep.equal([100, 100]);
    expect(buttons.map((b) => b.functionId)).to.deep.equal([10, 20]);
    expect(ws.soloFrames[0]!.members).to.deep.equal([101, 102]);
    expect(ws.widgets.find((w) => w.kind === "speeddial")!.input!.midi).to.deep.equal({ kind: "clock", what: "beat" });
  });
});

describe("QLC+ workspace analysis", () => {
  const a = analyzeWorkspace(ws, [def]);
  const tech = (id: number) => a.sequences.find((s) => s.id === id)!;

  it("decodes 8 colour cells from 2 bars", () => {
    expect(a.cells).to.have.length(8);
    expect(a.missingDefinitions).to.deep.equal([]);
  });

  it("recognises the techniques", () => {
    expect(tech(10).technique).to.equal("damier");
    expect(tech(20).technique).to.equal("palette qui tourne");
    expect(tech(30).technique).to.equal("creux qui tourne");
    expect(tech(40).technique).to.equal("masques");
    expect(tech(50).technique).to.equal("respiration");
  });

  it("measures attack: cut vs breathe", () => {
    expect(tech(10).attackLabel).to.equal("claque");
    expect(tech(50).attackLabel).to.equal("respire");
  });

  it("extracts the palette colours", () => {
    expect(tech(10).colors.sort()).to.deep.equal(["#0000ff", "#ff0000"]);
  });

  it("lists the MIDI mapping", () => {
    expect(a.midi.map((m) => m.binding)).to.include.members(["note 36 (canal 1)", "note 37 (canal 2)", "CC 7 (canal 1)"]);
  });
});
