import { expect } from "chai";
import { readFileSync } from "node:fs";
import { parseQxf } from "../../../src/plugins/light/venue/qxf-import.js";
import { parseQxw } from "../../../src/plugins/light/presets/qxw-import.js";
import { qxwToShow } from "../../../src/plugins/light/presets/qxw-to-show.js";

const fixture = (n: string) => readFileSync(new URL(`../../fixtures/${n}`, import.meta.url), "utf8");

describe("QLC+ workspace → venue + show", () => {
  const p = qxwToShow(parseQxw(fixture("synthetic.qxw")), [parseQxf(fixture("bar4.qxf"))]);

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
