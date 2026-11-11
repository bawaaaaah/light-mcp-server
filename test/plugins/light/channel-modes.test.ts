import { expect } from "chai";
import { readdirSync, readFileSync } from "node:fs";
import { channelModes, modeAt, rootOf, valueOf, type CapabilityLike } from "../../../src/plugins/light/venue/channel-modes.js";
import { parseQxf } from "../../../src/plugins/light/venue/qxf-import.js";

const caps = (...list: [number, number, string, string?][]): CapabilityLike[] => list.map(([min, max, name, preset]) => ({ min, max, name, ...(preset ? { preset } : {}) }));
const shape = (modes: ReturnType<typeof channelModes>) => modes.map((m) => ({ name: m.name, variants: m.variants.map((v) => v.name), continuous: m.continuous }));

/** A channel's working modes (T6, B1): the ranges of a channel cut into functions, grouped by the root of their names. */
describe("channel modes (venue/channel-modes.ts)", () => {
  describe("rootOf", () => {
    const table: [string, string, boolean][] = [
      ["Auto 1", "Auto", true],
      ["Sound2", "Sound", true],
      ["Program #3", "Program", true],
      ["Macro no. 12", "Macro", true],
      ["Color fade slow", "Color fade", true],
      ["Rotation CCW", "Rotation", true],
      ["Speed slow → fast", "Speed", true],
      ["Speed slow to fast", "Speed", true],
      ["Dimmer 0-100%", "Dimmer", true],
      ["Auto 1 fast", "Auto", true],
      ["Rainbow", "Rainbow", false],
      ["No function", "No function", false],
      ["Strobe Off", "Strobe Off", false],
    ];
    for (const [name, root, stripped] of table) it(`« ${name} » → « ${root} »`, () => expect(rootOf(name)).to.deep.equal({ root, stripped }));
  });

  it("groups consecutive variants of one mode, keeps the others apart, and reads a wide progression as continuous", () => {
    const modes = channelModes(
      caps([0, 7, "No function"], [8, 39, "Auto 1"], [40, 71, "Auto 2"], [72, 103, "Auto 3"], [104, 135, "Sound 1"], [136, 167, "Sound 2"], [168, 211, "Color fade slow"], [212, 239, "Color fade fast"], [240, 255, "Speed slow → fast"]),
    );
    expect(shape(modes)).to.deep.equal([
      { name: "No function", variants: ["No function"], continuous: false },
      { name: "Auto", variants: ["Auto 1", "Auto 2", "Auto 3"], continuous: false },
      { name: "Sound", variants: ["Sound 1", "Sound 2"], continuous: false },
      { name: "Color fade", variants: ["Color fade slow", "Color fade fast"], continuous: false },
      { name: "Speed slow → fast", variants: ["Speed slow → fast"], continuous: true },
    ]);
    expect(modes[1]).to.include({ min: 8, max: 103 });
  });

  it("does not join variants that are not consecutive, nor a lone numbered function", () => {
    expect(shape(channelModes(caps([0, 9, "Auto 1"], [10, 19, "Sound 1"], [20, 29, "Auto 2"])))).to.deep.equal([
      { name: "Auto 1", variants: ["Auto 1"], continuous: false },
      { name: "Sound 1", variants: ["Sound 1"], continuous: false },
      { name: "Auto 2", variants: ["Auto 2"], continuous: false },
    ]);
  });

  it("sorts the capabilities by value first, and says nothing for a channel of one function", () => {
    expect(shape(channelModes(caps([16, 31, "Gobo 2"], [0, 15, "Gobo 1"])))).to.deep.equal([{ name: "Gobo", variants: ["Gobo 1", "Gobo 2"], continuous: false }]);
    expect(channelModes(caps([0, 255, "Open"]))).to.deep.equal([]);
  });

  it("reads a strobe's slow-to-fast range from its preset, but not a narrow one", () => {
    const modes = channelModes(caps([0, 10, "Strobe Off", "ShutterOpen"], [11, 255, "Strobe", "StrobeSlowToFast"]));
    expect(modes.map((m) => m.continuous)).to.deep.equal([false, true]);
    expect(channelModes(caps([0, 3, "Off"], [4, 6, "Speed slow → fast"]))[1]!.continuous).to.equal(false);
  });

  it("finds the mode and variant of a value, and sends the middle of the range (a continuous mode its value, kept inside)", () => {
    const modes = channelModes(caps([0, 7, "No function"], [8, 39, "Auto 1"], [40, 71, "Auto 2"], [72, 255, "Speed slow → fast"]));
    expect(modeAt(modes, 50)).to.deep.include({ variant: { name: "Auto 2", min: 40, max: 71 } });
    expect(modeAt(modes, 50)!.mode.name).to.equal("Auto");
    expect(modeAt(modes, 300)).to.equal(undefined);
    const auto = modes[1]!;
    expect(valueOf(auto)).to.equal(23); // the first variant
    expect(valueOf(auto, "Auto 2")).to.equal(55);
    expect(valueOf(modes[2]!, undefined, 100)).to.equal(100);
    expect(valueOf(modes[2]!, undefined, 3)).to.equal(72);
    expect(valueOf(modes[2]!)).to.equal(163);
  });

  it("groups every test definition's channels without losing or crossing a range", () => {
    const dir = new URL("../../fixtures/", import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".qxf"))) {
      const def = parseQxf(readFileSync(new URL(file, dir), "utf8"));
      for (const ch of def.channels.values()) {
        const modes = channelModes(ch.capabilities);
        if (ch.capabilities.length < 2) continue;
        const flat = modes.flatMap((m) => m.variants);
        expect(flat.length, `${file} ${ch.name}`).to.equal(ch.capabilities.length);
        for (const m of modes) expect([m.min, m.max], `${file} ${ch.name} ${m.name}`).to.deep.equal([m.variants[0]!.min, m.variants[m.variants.length - 1]!.max]);
      }
    }
    const par = parseQxf(readFileSync(new URL("mode-par.qxf", dir), "utf8"));
    expect(shape(channelModes(par.channels.get("Program")!.capabilities)).map((m) => m.name)).to.deep.equal(["No function", "Auto", "Sound", "Color fade"]);
  });
});
