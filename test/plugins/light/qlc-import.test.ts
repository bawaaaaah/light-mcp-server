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

  it("never takes a machine's output for a dimmer, even with the IntensityDimmer preset", () => {
    const machine = parseQxf(`<?xml version="1.0" encoding="UTF-8"?>
<FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition">
 <Manufacturer>Test</Manufacturer>
 <Model>Bubble Hazer</Model>
 <Type>Hazer</Type>
 <Channel Name="Bubble Output" Preset="IntensityDimmer"/>
 <Channel Name="Fog Output" Preset="IntensityDimmer"/>
 <Channel Name="Fan" Preset="IntensityDimmer"/>
 <Channel Name="Flame Height"><Group Byte="0">Intensity</Group></Channel>
 <Channel Name="Dimmer" Preset="IntensityDimmer"/>
 <Channel Name="Red" Preset="IntensityRed"/>
 <Mode Name="6 Channel">
  <Channel Number="0">Bubble Output</Channel>
  <Channel Number="1">Fog Output</Channel>
  <Channel Number="2">Fan</Channel>
  <Channel Number="3">Flame Height</Channel>
  <Channel Number="4">Dimmer</Channel>
  <Channel Number="5">Red</Channel>
 </Mode>
</FixtureDefinition>`);
    for (const name of ["Bubble Output", "Fog Output", "Fan", "Flame Height"]) expect(machine.channels.get(name)!.attribute, name).to.equal("effect");
    expect(machine.channels.get("Dimmer")!.attribute).to.equal("intensity"); // the LEDs' dimmer stays one
    expect(machine.channels.get("Red")).to.include({ attribute: "color", color: "red" });
  });

  it("takes an Intensity channel cut into functions for a mode selector, not a dimmer", () => {
    const bar = parseQxf(`<?xml version="1.0" encoding="UTF-8"?>
<FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition">
 <Manufacturer>Test</Manufacturer>
 <Model>Sound Bar</Model>
 <Type>LED Bar (Beams)</Type>
 <Channel Name="Mode Selection"><Group Byte="0">Intensity</Group><Colour>Generic</Colour>
  <Capability Min="0" Max="63">RGBW color chasing</Capability>
  <Capability Min="64" Max="127">Color Presets</Capability>
  <Capability Min="128" Max="191">Color Macros</Capability>
  <Capability Min="192" Max="255">Music Controlled</Capability>
 </Channel>
 <Channel Name="Relay"><Group Byte="0">Intensity</Group><Capability Min="0" Max="127">Off</Capability><Capability Min="128" Max="255">On</Capability></Channel>
 <Channel Name="Master"><Group Byte="0">Intensity</Group><Capability Min="0" Max="0">Off</Capability><Capability Min="1" Max="255">Dimmer 0-100%</Capability></Channel>
 <Channel Name="Layer Master"><Group Byte="0">Intensity</Group><Capability Min="0" Max="0">Transparent</Capability><Capability Min="1" Max="255">Intensity off…bright</Capability></Channel>
 <Channel Name="Dimmer"><Group Byte="0">Intensity</Group><Capability Min="0" Max="255">Intensity</Capability></Channel>
 <Mode Name="5 Channel">
  <Channel Number="0">Mode Selection</Channel>
  <Channel Number="1">Relay</Channel>
  <Channel Number="2">Master</Channel>
  <Channel Number="3">Layer Master</Channel>
  <Channel Number="4">Dimmer</Channel>
 </Mode>
</FixtureDefinition>`);
    // at full, « Mode Selection » put the bar in its sound mode and its colour presets never answered
    expect(bar.channels.get("Mode Selection")!.attribute).to.equal("effect");
    expect(bar.channels.get("Relay")!.attribute).to.equal("effect");
    for (const level of ["Master", "Layer Master", "Dimmer"]) expect(bar.channels.get(level)!.attribute, level).to.equal("intensity");
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
