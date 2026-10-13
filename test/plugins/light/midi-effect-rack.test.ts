import { expect } from "chai";
import { readFileSync } from "node:fs";
import { buildRackXml, listChains, readAdg, ShellError, writeAdg } from "../../../src/plugins/light/ableton/midi-effect-rack.js";

const shell = readFileSync(new URL("../../fixtures/shell-rack.xml", import.meta.url), "utf8");

const spec = {
  userName: "Show · sections · ch 1",
  annotation: 'Faders: "Master" = CC 7',
  chains: [
    { name: "Intro · palette qui tourne", note: 36, color: 12 },
    { name: "Refrain · damier & punch", note: 37, color: 12 },
    { name: "❌ Flash blanc", note: 60, color: 0 },
  ],
};

describe("MIDI Effect Rack builder", () => {
  it("clones one chain per action, on a one-key zone", () => {
    const xml = buildRackXml(shell, spec);
    expect(listChains(xml)).to.deep.equal(spec.chains);
  });

  it("leaves BranchSelectorRange untouched and labels the device", () => {
    const xml = buildRackXml(shell, spec);
    const selector = xml.match(/<BranchSelectorRange>\s*<Min Value="(\d+)"/g)!;
    expect(selector).to.have.length(3);
    selector.forEach((s) => expect(s).to.match(/Value="0"$/));
    expect(xml).to.contain('<UserName Value="Show · sections · ch 1" />');
    expect(xml).to.contain("&quot;Master&quot;");
    // branch mixers keep their own (empty) labels
    expect(xml.match(/<UserName Value="" \/>/g)).to.have.length(3);
  });

  it("keeps everything outside the branches byte for byte", () => {
    const xml = buildRackXml(shell, spec);
    const outside = (s: string): string =>
      s.replace(/<BranchPresets>[\s\S]*<\/BranchPresets>/, "").replace(/<UserName Value="[^"]*" \/>\s*<Annotation Value="[^"]*" \/>/, "");
    expect(outside(xml)).to.equal(outside(shell));
  });

  it("refuses a note used twice", () => {
    expect(() => buildRackXml(shell, { ...spec, chains: [spec.chains[0]!, { ...spec.chains[1]!, note: 36 }] })).to.throw(RangeError);
  });

  it("refuses a shell without a branch to clone", () => {
    expect(() => buildRackXml(shell.replace(/<MidiEffectBranchPreset[\s\S]*<\/MidiEffectBranchPreset>\n/, ""), spec)).to.throw(ShellError);
  });

  it("round-trips through gzip deterministically", () => {
    const xml = buildRackXml(shell, spec);
    const a = writeAdg(xml);
    expect(a.equals(writeAdg(xml))).to.equal(true);
    expect(readAdg(a)).to.equal(xml);
  });
});
