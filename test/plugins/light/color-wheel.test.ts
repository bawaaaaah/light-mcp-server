import { expect } from "chai";
import { readFileSync } from "node:fs";
import { parseQxf } from "../../../src/plugins/light/venue/qxf-import.js";
import { applyWheelOverrides, askOf, pickSlot, slotAt, slotValue, SWITCH_MARGIN, wheelFrame, wheelSlots, type Wheel } from "../../../src/plugins/light/venue/color-wheel.js";
import { hexToColor } from "../../../src/plugins/light/engine/techniques.js";
import { oklab, oklabDistance } from "../../../src/plugins/light/engine/oklab.js";

/** A synthetic wheel of ten colours (Open, red … CTO) and one split slot (red / green), test/fixtures/wheel-spot.qxf. */
const def = parseQxf(readFileSync(new URL("../../fixtures/wheel-spot.qxf", import.meta.url), "utf8"));
const caps = def.channels.get("Color Wheel")!.capabilities;
const slots = wheelSlots(caps);
const named = (name: string) => slots.find((s) => s.name === name)!;
const pick = (hex: string | string[], previous?: number) => pickSlot(slots, (Array.isArray(hex) ? hex : [hex]).map(hexToColor), previous)?.slot.name;
const wheel: Wheel = { offset: 2, slots, doubles: true, change: "mid" };

describe("colour wheel (T18): which slot answers a painted colour", () => {
  it("reads every slot, an « Open » one without colour as white, both colours of a split slot", () => {
    expect(caps.find((c) => c.name === "Red / Green")).to.include({ color: "#ff0000", color2: "#00ff00" });
    expect(slots.map((s) => s.name)).to.deep.equal(["Open", "Red", "Orange", "Yellow", "Green", "Cyan", "Blue", "Magenta", "Pink", "CTO", "Red / Green"]); // « Rainbow » has no colour
    expect(named("Open")).to.include({ open: true });
    expect(named("Open").color).to.deep.equal({ red: 1, green: 1, blue: 1 });
  });

  it("lands each slot's own colour on that slot, by OKLab distance, at any level", () => {
    for (const c of caps.filter((x) => x.color && !x.color2)) expect(pick(c.color!), c.name).to.equal(c.name);
    expect(pickSlot(slots, [{ red: 0.3 }])?.slot.name).to.equal("Red"); // the level goes to the dimmer
    expect(pick("#ff9900")).to.equal("Orange");
    expect(pick("#ff60a0")).to.equal("Pink"); // between magenta and red: the pink part better in OKLab
  });

  it("sends a near-neutral colour to the white or open slot, not to a pale tint", () => {
    expect(pick("#ffffff")).to.equal("Open");
    expect(pick("#fff4ec")).to.equal("Open"); // a slightly warm white, not the CTO
    expect(pickSlot(slots, [{ white: 1 }])?.slot.name).to.equal("Open");
    expect(pick("#ffc080")).to.equal("CTO"); // a real warm white keeps its slot
  });

  it("never picks a split slot for one colour; picks it when a look asks its two colours", () => {
    expect(pick("#ff0000")).to.equal("Red");
    expect(pick(["#ff0000", "#00ff00"])).to.equal("Red / Green");
    expect(pick(["#00ff00", "#ff0000"])).to.equal("Red / Green"); // either way round
    expect(pick(["#ff0000", "#0000ff"])).to.equal("Red"); // no red / blue slot: the first colour asked
    expect(pickSlot(slots, ["#ff0000", "#00ff00"].map(hexToColor), undefined, { doubles: false })?.slot.name).to.equal("Red");
  });

  it("asks two colours only when a look paints two heads of the fixture with distinct colours", () => {
    const red = hexToColor("#ff0000");
    const green = hexToColor("#00ff00");
    expect(askOf(new Map([[-1, red]]))).to.deep.equal([red]);
    expect(askOf(new Map([[0, red], [1, green]]))).to.deep.equal([red, green]);
    expect(askOf(new Map([[0, red], [1, { red: 0.95, green: 0.05 }]]))).to.have.length(1); // two near reds: one colour
    expect(askOf(new Map([[0, red], [1, {}]]))).to.deep.equal([red]); // a dark head asks nothing
    expect(askOf(new Map([[0, {}]]))).to.deep.equal([]);
  });

  it("sends the middle of the slot, and finds a slot back from any value of its range", () => {
    expect(pickSlot(slots, [hexToColor("#0000ff")])?.value).to.equal(65);
    expect(slotValue({ min: 0, max: 255 })).to.equal(128);
    for (const v of [60, 65, 69]) expect(slotAt(slots, v)?.name, String(v)).to.equal("Blue");
    expect(slotAt(slots, 200)).to.equal(undefined); // the rainbow: no colour
  });

  it("keeps the slot held unless another is at least SWITCH_MARGIN closer", () => {
    const [red, orange] = [named("Red"), named("Orange")];
    // a colour gliding from red to orange, slightly closer to red: the wheel stays on orange
    const lab = (hex: string) => oklab([1, parseInt(hex.slice(3, 5), 16) / 255, 0]);
    const between = "#ff5400";
    const dRed = oklabDistance(lab(between), lab("#ff0000"));
    const dOrange = oklabDistance(lab(between), lab("#ff8000"));
    expect(dRed).to.be.below(dOrange).and.above(dOrange * (1 - SWITCH_MARGIN)); // closer, not clearly
    expect(pick(between)).to.equal("Red");
    expect(pick(between, orange.min)).to.equal("Orange");
    expect(pick("#ff4000", orange.min)).to.equal("Red"); // clearly closer: it turns
    expect(pick("#ff8000", red.min)).to.equal("Orange");
  });

  it("follows the corrections of a model or a fixture: a slot's colour, the colours it answers to, a slot left out", () => {
    const fixed = applyWheelOverrides(slots, { slots: { "20": { answers: ["#ff0000"] }, "80": { off: true }, "90": { color: "#ffe0c0" } } });
    expect(pickSlot(fixed, [hexToColor("#ff0000")])?.slot.name).to.equal("Orange"); // red answered by the orange slot
    expect(pickSlot(fixed, [hexToColor("#ff0000")])?.gap).to.be.above(0.05); // and the gap to its real colour told
    expect(pickSlot(fixed, [hexToColor("#ff80c0")])?.slot.name).to.not.equal("Pink");
    expect(fixed.find((s) => s.min === 90)!.color).to.deep.equal(hexToColor("#ffe0c0"));
  });

  describe("on a frame", () => {
    const red = new Map([[-1, hexToColor("#ff0000")]]);
    const blue = new Map([[-1, hexToColor("#0000ff")]]);
    it("follows the heaviest look, the later one on equal weights, never the mix", () => {
      expect(wheelFrame(wheel, [{ look: "a", weight: 0.6, heads: red }, { look: "b", weight: 0.4, heads: blue }], undefined, undefined).pick?.slot.name).to.equal("Red");
      expect(wheelFrame(wheel, [{ look: "a", weight: 0.5, heads: red }, { look: "b", weight: 0.5, heads: blue }], undefined, undefined).pick?.slot.name).to.equal("Blue");
      expect(wheelFrame(wheel, [], { red: 0.5, blue: 0.5 }, undefined).pick?.slot.name).to.equal("Magenta"); // no looks: the colour painted
      expect(wheelFrame(wheel, [], undefined, 60).pick?.slot.name).to.equal("Blue"); // nothing asked: the slot held stays
    });

    it("« au noir »: dims through black where the slot changes, not where it does not", () => {
      const dark = { ...wheel, change: "black" as const };
      const dims = [0, 0.25, 0.5, 0.75, 1].map((t) => wheelFrame(dark, [{ look: "a", weight: 1 - t, heads: red }, { look: "b", weight: t, heads: blue }], undefined, undefined).dim);
      expect(dims.map((d) => Math.round(d * 1000) / 1000)).to.deep.equal([1, 0.667, 0, 0.667, 1]);
      expect(wheelFrame(dark, [{ look: "a", weight: 0.5, heads: red }, { look: "b", weight: 0.5, heads: red }], undefined, undefined).dim).to.equal(1);
      expect(wheelFrame(wheel, [{ look: "a", weight: 0.5, heads: red }, { look: "b", weight: 0.5, heads: blue }], undefined, undefined).dim).to.equal(1);
    });
  });
});
