import { expect } from "chai";
import { readFileSync } from "node:fs";
import { parseQxf } from "../../../src/plugins/light/venue/qxf-import.js";
import { applyWheelOverrides, askOf, isOpenName, pickSlot, slotAt, slotValue, SWITCH_MARGIN, wheelCapabilities, wheelFrame, wheelOf, wheelSlots, type Wheel } from "../../../src/plugins/light/venue/color-wheel.js";
import { hexToColor } from "../../../src/plugins/light/engine/techniques.js";
import { WheelOverridesSchema } from "../../../src/plugins/light/venue/overrides.js";
import { oklab, tintDistance } from "../../../src/plugins/light/engine/oklab.js";

/** A synthetic wheel of ten colours (Open, red … CTO) and one split slot (red / green), test/fixtures/wheel-spot.qxf. */
const def = parseQxf(readFileSync(new URL("../../fixtures/wheel-spot.qxf", import.meta.url), "utf8"));
const caps = def.channels.get("Color Wheel")!.capabilities;
const slots = wheelSlots(caps);
const named = (name: string) => slots.find((s) => s.name === name)!;
const pick = (hex: string | string[], previous?: number) => pickSlot(slots, (Array.isArray(hex) ? hex : [hex]).map(hexToColor), previous)?.slot.name;
const wheel: Wheel = { offset: 2, slots, doubles: true, change: "mid", changeMs: 300 };

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
    const between = "#ff5a00";
    const dRed = tintDistance(lab(between), lab("#ff0000"));
    const dOrange = tintDistance(lab(between), lab("#ff8000"));
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

  it("goes by the tint, not the lightness: a pale pink is a pink, a violet a magenta, a faint tint stays white", () => {
    expect(pick("#ffc0d8")).to.equal("Pink"); // not the CTO, nearer in lightness only
    expect(pick("#8000ff")).to.equal("Magenta"); // not the blue, nearer because darker: the level goes to the dimmer
    expect(pick("#ffd0a0")).to.equal("CTO");
    expect(pick("#ffe4e8")).to.equal("Open"); // barely pink: white rather than a saturated pink
    expect(pick("#400000")).to.equal("Red");
  });

  it("does not flap around the near-neutral threshold: a pale colour with noise keeps its slot", () => {
    // deterministic noise of ±0.03 on each component around #ffdbdb, whose chroma sits on the threshold
    let seed = 12345;
    const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 0.06;
    const base = hexToColor("#ffdbdb");
    for (const wheelSlotsUnderTest of [slots, [...slots, { min: 200, max: 209, name: "Pale pink", color: hexToColor("#ffd0d8") }]]) {
      let held: number | undefined;
      const seen = new Set<string>();
      for (let i = 0; i < 400; i++) {
        const c = { red: Math.min(1, base.red! + noise()), green: base.green! + noise(), blue: base.blue! + noise() };
        const got = pickSlot(wheelSlotsUnderTest, [c], held)!;
        held = got.slot.min;
        if (i > 0) seen.add(got.slot.name);
      }
      expect([...seen], `slots after the first frame: ${[...seen].join(", ")}`).to.have.length(1);
    }
    // the two thresholds: between them the wheel stays where it is
    const edge = hexToColor("#ffd8d8"); // chroma between NEUTRAL_CHROMA and NEUTRAL_LEAVE
    const pale = [...slots, { min: 200, max: 209, name: "Pale pink", color: hexToColor("#ffd0d8") }];
    expect(pickSlot(pale, [edge])?.slot.name).to.equal("Pale pink");
    expect(pickSlot(pale, [edge], 0)?.slot.name).to.equal("Open"); // already on the open slot: it stays
  });

  it("reads « Open » from the whole name only, and bounds the slot keys to DMX values", () => {
    for (const name of ["Open", "White", "Blanc", "Open / White", "White (open)", "White 5600K", "No color", "Sans couleur", "Open 2"]) expect(isOpenName(name), name).to.equal(true);
    for (const name of ["White + Red", "white/red split", "Red", "Rainbow", "Warm white", "Opening", "5600K", "3200K", "CTO 3200 K", "Open red"]) expect(isOpenName(name), name).to.equal(false);
    for (const key of ["0", "16", "255"]) expect(WheelOverridesSchema.safeParse({ slots: { [key]: { off: true } } }).success, key).to.equal(true);
    for (const key of ["256", "999", "016", "00", "-1", "1.5"]) expect(WheelOverridesSchema.safeParse({ slots: { [key]: { off: true } } }).success, key).to.equal(false);
  });

  it("gives a range without colour a slot once a correction gives it its colour", () => {
    const all = wheelCapabilities(caps);
    expect(all.map((c) => c.name)).to.include("Rainbow"); // every range of the channel is listed
    expect(all.find((c) => c.name === "Rainbow")!.color).to.equal(undefined);
    const fixed = applyWheelOverrides(all, { slots: { "110": { color: "#8000ff" } } });
    expect(pickSlot(fixed, [hexToColor("#8000ff")])?.slot.name).to.equal("Rainbow");
    // a definition that gives no colour at all: no slot, then those corrected
    const bare = parseQxf(readFileSync(new URL("../../fixtures/wheel-spot.qxf", import.meta.url), "utf8").replace(/ Preset="Color(Double)?Macro" Res1="#[0-9a-f]{6}"( Res2="#[0-9a-f]{6}")?/g, "").replace(">Open<", ">Slot 1<")).channels.get("Color Wheel")!.capabilities;
    expect(wheelOf(2, bare, undefined).slots).to.deep.equal([]);
    expect(wheelOf(2, bare, { slots: { "10": { color: "#ff0000" }, "60": { color: "#0000ff" } } }).slots.map((x) => x.name)).to.deep.equal(["Red", "Blue"]);
    // an open slot given a real colour is no longer white
    expect(applyWheelOverrides(all, { slots: { "0": { color: "#ffc080" } } })[0]).to.not.have.property("open");
  });

  it("tells the gap of both colours when two are asked of a plain slot", () => {
    const one = pickSlot(slots, [hexToColor("#ff0000")])!;
    const two = pickSlot(slots, ["#ff0000", "#0000ff"].map(hexToColor))!;
    expect(one.gap).to.equal(0);
    expect(two.slot.name).to.equal("Red");
    expect(two.gap).to.be.above(0.3); // the blue asked is not shown at all
  });

  it("asks nothing of a head far darker than the brightest, whatever the look's level", () => {
    const red = hexToColor("#ff0000");
    expect(askOf(new Map([[0, red], [1, { green: 0.01 }]]))).to.deep.equal([red]);
    // far down a fade the two heads still ask their two colours
    expect(askOf(new Map([[0, { red: 0.01 }], [1, { green: 0.01 }]]))).to.have.length(2);
    expect(askOf(new Map([[0, { red: 0.0005 }]]))).to.deep.equal([]); // below half a DMX step: black
  });

  describe("on a frame", () => {
    const at = (level: number, hex: string) => new Map([[-1, Object.fromEntries(Object.entries(hexToColor(hex)).map(([k, v]) => [k, (v ?? 0) * level]))]]);
    const full = (hex: string) => new Map([[-1, hexToColor(hex)]]);
    const paint = (look: string, sheet: string, level: number, hex: string) => ({ look, sheet, heads: at(level, hex), hues: full(hex) });
    const at0 = { now: 0, merge: "last" as const };
    const name = (f: { pick: { slot: { name: string } } | undefined }) => f.pick?.slot.name;

    it("« last »: only the latest sheet counts, from its first dark frame, and its black keeps the slot held", () => {
      // B blue rising over A red, each on its own sheet: blue at once, the light is B's
      expect(name(wheelFrame(wheel, [paint("a", "look:a", 1, "#ff0000"), paint("b", "look:b", 0, "#0000ff")], undefined, { slot: 10 }, at0))).to.equal("Blue");
      // a chase over a red background, on its black step: the wheel stays on the chase's blue
      expect(name(wheelFrame(wheel, [paint("a", "look:a", 1, "#ff0000"), paint("b", "look:b", 0, "#000000")], undefined, { slot: 60 }, at0))).to.equal("Blue");
      expect(wheelFrame(wheel, [paint("a", "look:a", 1, "#ff0000"), paint("b", "look:b", 0, "#000000")], undefined, { slot: 60 }, at0).asked).to.equal(undefined);
    });

    it("inside a sheet (a crossfade) and with « highest »: the look painting the most light, the later one on equal levels", () => {
      const x = (a: number, b: number) => [paint("a", "x:b", a, "#ff0000"), paint("b", "x:b", b, "#0000ff")];
      expect(name(wheelFrame(wheel, x(0.6, 0.4), undefined, undefined, at0))).to.equal("Red");
      expect(name(wheelFrame(wheel, x(0.5, 0.5), undefined, undefined, at0))).to.equal("Blue");
      const highest = { now: 0, merge: "highest" as const };
      expect(name(wheelFrame(wheel, [paint("a", "look:a", 1, "#ff0000"), paint("b", "look:b", 0.3, "#0000ff")], undefined, undefined, highest))).to.equal("Red");
      expect(name(wheelFrame(wheel, [paint("a", "look:a", 1, "#ff0000"), paint("b", "look:b", 0, "#000000")], undefined, { slot: 60 }, highest))).to.equal("Red"); // black never darkens: red is what shows
      expect(name(wheelFrame(wheel, [], { red: 0.5, blue: 0.5 }, undefined, at0))).to.equal("Magenta"); // no looks: the colour painted
      expect(name(wheelFrame(wheel, [], undefined, { slot: 60 }, at0))).to.equal("Blue"); // nothing asked: the slot held stays
    });

    it("« au noir »: dark for changeMs after a real change of slot, never while two looks merely paint the fixture", () => {
      const dark = { ...wheel, change: "black" as const, changeMs: 300 };
      const two = [paint("a", "look:a", 1, "#ff0000"), paint("b", "look:b", 1, "#0000ff")];
      // two looks at full on the same fixture, for good: lit (it stayed dark as long as both painted)
      expect(wheelFrame(dark, two, undefined, { slot: 60 }, { now: 5000, merge: "last" }).dim).to.equal(1);
      expect(wheelFrame(dark, two, undefined, { slot: 60 }, { now: 5000, merge: "highest" }).dim).to.equal(1);
      // the change: remembered, dark for 300 ms, then lit
      const turn = wheelFrame(dark, two, undefined, { slot: 10 }, { now: 1000, merge: "last" });
      expect(turn).to.include({ dim: 0, changedAt: 1000 });
      expect(wheelFrame(dark, two, undefined, { slot: 60, changedAt: 1000 }, { now: 1299, merge: "last" }).dim).to.equal(0);
      expect(wheelFrame(dark, two, undefined, { slot: 60, changedAt: 1000 }, { now: 1300, merge: "last" })).to.include({ dim: 1, changedAt: 1000 });
      // the first slot ever taken is no change; « mid » never dims
      expect(wheelFrame(dark, two, undefined, undefined, { now: 0, merge: "last" })).to.include({ dim: 1, changedAt: undefined });
      expect(wheelFrame(wheel, two, undefined, { slot: 10 }, { now: 1000, merge: "last" }).dim).to.equal(1);
      // the model's own time
      expect(wheelFrame({ ...dark, changeMs: 50 }, two, undefined, { slot: 60, changedAt: 1000 }, { now: 1060, merge: "last" }).dim).to.equal(1);
    });

    it("« au noir »: a clock gone back ends the window; a short crossfade ramps back up instead of jumping", () => {
      const dark = { ...wheel, change: "black" as const, changeMs: 300 };
      const two = [paint("a", "look:a", 1, "#ff0000"), paint("b", "look:b", 1, "#0000ff")];
      expect(wheelFrame(dark, two, undefined, { slot: 60, changedAt: 1000 }, { now: 500, merge: "last" }).dim).to.equal(1);
      // a crossfade ending just after the window: the level the crossfade allows is 1, the ramp bounds it
      const fade = [paint("a", "x:b", 0.9, "#ff0000"), paint("b", "x:b", 0.1, "#0000ff")];
      const held = { slot: 10, changedAt: 1000 };
      const dims = [1299, 1300, 1345, 1375, 1450, 1460].map((now) => wheelFrame(dark, fade, undefined, held, { now, merge: "last" }).dim);
      expect(dims[0]).to.equal(0);
      expect(dims[1]).to.equal(0);
      expect(dims[2]).to.be.within(0.2, 0.4);
      expect(dims[3]).to.be.within(0.45, 0.55);
      expect(dims[4]).to.equal(1);
      expect(dims[5]).to.equal(1);
    });

    it("« au noir » in a crossfade: the light ramps down ahead of the change", () => {
      const dark = { ...wheel, change: "black" as const, changeMs: 300 };
      const dims = [0, 0.25, 0.45, 0.48, 0.5].map((t) => wheelFrame(dark, [paint("a", "x:b", 1 - t, "#ff0000"), paint("b", "x:b", t, "#0000ff")], undefined, { slot: 10 }, { now: 0, merge: "last" }).dim);
      expect(dims[0]).to.equal(1);
      expect(dims[1]).to.equal(1); // far from the change: full
      expect(dims[2]).to.be.within(0.01, 0.99);
      expect(dims[3]).to.be.below(dims[2]!);
      expect(dims[4]).to.equal(0); // the change
      // two looks leaving the same slot do not dim each other
      expect(wheelFrame(dark, [paint("a", "x:b", 0.5, "#ff0000"), paint("b", "x:b", 0.5, "#ff0000")], undefined, { slot: 10 }, at0).dim).to.equal(1);
    });
  });
});
