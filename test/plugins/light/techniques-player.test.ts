import { expect } from "chai";
import { generateSteps, hexToColor, TechniqueSchema } from "../../../src/plugins/light/engine/techniques.js";
import { LookPlayer, TimingSchema } from "../../../src/plugins/light/engine/player.js";

const hex = (c: { red?: number; green?: number; blue?: number } | null) =>
  c ? "#" + [c.red ?? 0, c.green ?? 0, c.blue ?? 0].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("") : "-";
const row = (step: ({ red?: number; green?: number; blue?: number } | null)[]) => step.map(hex).join(" ");
const tech = (t: unknown) => TechniqueSchema.parse(t);

describe("techniques", () => {
  it("parses hex colours with white", () => {
    expect(hexToColor("#ff0000+w51")).to.deep.equal({ red: 1, green: 0, blue: 0, white: 0.2 });
  });

  it("damier swaps two colours per block, mirrored", () => {
    const steps = generateSteps(tech({ kind: "damier", colors: ["#ff0000", "#0000ff"], block: 2 }), 8, true);
    expect(steps.map(row)).to.deep.equal(["#ff0000 #ff0000 #0000ff #0000ff #0000ff #0000ff #ff0000 #ff0000", "#0000ff #0000ff #ff0000 #ff0000 #ff0000 #ff0000 #0000ff #0000ff"]);
  });

  it("palette shifts hues per block and never goes dark", () => {
    const steps = generateSteps(tech({ kind: "palette", colors: ["#ff0000", "#00ff00", "#0000ff"], block: 1 }), 3, false);
    expect(steps.map(row)).to.deep.equal(["#ff0000 #00ff00 #0000ff", "#00ff00 #0000ff #ff0000", "#0000ff #ff0000 #00ff00"]);
  });

  it("creux moves one dark block around the wall", () => {
    const steps = generateSteps(tech({ kind: "creux", colors: ["#ff0000", "#ff0000"], block: 1 }), 4, false);
    expect(steps.map(row)).to.deep.equal(["#000000 #ff0000 #ff0000 #ff0000", "#ff0000 #000000 #ff0000 #ff0000", "#ff0000 #ff0000 #000000 #ff0000", "#ff0000 #ff0000 #ff0000 #000000"]);
  });

  it("masques apply ON/OFF patterns per block", () => {
    const steps = generateSteps(tech({ kind: "masques", colors: ["#ff0000", "#ff0000"], block: 2, masks: ["##", "#-"] }), 8, true);
    expect(row(steps[1]!)).to.equal("#ff0000 #ff0000 #000000 #000000 #000000 #000000 #ff0000 #ff0000");
  });

  it("onde: a sine travels along the canvas with phase spread, wings mirror it", () => {
    const steps = generateSteps(tech({ kind: "onde", colors: ["#ff0000"], wave: "sine", spread: 1, resolution: 4 }), 4, false);
    expect(steps).to.have.length(4);
    const levels = steps.map((s) => s.map((c) => Math.round((c?.red ?? 0) * 100) / 100));
    expect(levels[0]).to.deep.equal([0, 0.5, 1, 0.5]); // cell k lags by k/4 of a cycle
    expect(levels[1]).to.deep.equal([0.5, 0, 0.5, 1]);
    const wings = generateSteps(tech({ kind: "onde", colors: ["#ff0000"], spread: 1, wings: true, resolution: 4 }), 4, false);
    const w0 = wings[1]!.map((c) => Math.round((c?.red ?? 0) * 100) / 100);
    expect(w0[0]).to.equal(w0[3]);
    expect(w0[1]).to.equal(w0[2]);
    const shallow = generateSteps(tech({ kind: "onde", colors: ["#ff0000"], depth: 0.25, resolution: 4 }), 2, false);
    expect(Math.min(...shallow.flat().map((c) => c!.red!))).to.be.closeTo(0.75, 1e-9);
  });

  it("orage is a weighted pool of calm and single-cell strike steps", () => {
    const steps = generateSteps(tech({ kind: "orage", base: "#000080", calm: 3, strikes: 2 }), 4, false);
    expect(steps).to.have.length(5);
    expect(steps.slice(3).every((s) => s.filter((c) => hex(c) !== "#000080").length === 1)).to.equal(true);
  });
});

describe("look player", () => {
  const two = generateSteps(tech({ kind: "damier", colors: ["#ff0000", "#0000ff"], block: 1 }), 2, false);

  it("cuts hard with attack 0 (« claque »)", () => {
    const p = new LookPlayer(two, TimingSchema.parse({ every: { beats: 1 }, attack: 0 }), 1);
    p.start(0, 0);
    expect(row(p.render(0, 0.99))).to.equal("#ff0000 #0000ff");
    expect(row(p.render(0, 1.01))).to.equal("#0000ff #ff0000");
  });

  it("crossfades with attack 1 (« respire »)", () => {
    const p = new LookPlayer(two, TimingSchema.parse({ every: { beats: 1 }, attack: 1 }), 1);
    p.start(0, 0);
    expect(row(p.render(0, 1.5))).to.equal("#800080 #800080");
  });

  it("follows the tempo in beats: a BPM change does not jump the phase", () => {
    const p = new LookPlayer(two, TimingSchema.parse({ every: { beats: 2 } }), 1);
    p.start(0, 10);
    expect(p.position(0, 13)).to.equal(1.5); // position is driven by beats, not wall time
  });

  it("uses seconds when the cadence is fixed", () => {
    const p = new LookPlayer(two, TimingSchema.parse({ every: { seconds: 0.5 } }), 1);
    p.start(1000, 0);
    expect(p.position(2000, 99)).to.equal(2);
  });

  it("orders steps: pingpong, and random without immediate repeats (deterministic)", () => {
    const four = generateSteps(tech({ kind: "palette", colors: ["#ff0000", "#00ff00", "#0000ff", "#ffffff"], block: 1 }), 4, false);
    const pp = new LookPlayer(four, TimingSchema.parse({ order: "pingpong" }), 1);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => pp.stepAt(i))).to.deep.equal([0, 1, 2, 3, 2, 1, 0]);
    const r1 = new LookPlayer(four, TimingSchema.parse({ order: "random" }), 42);
    const r2 = new LookPlayer(four, TimingSchema.parse({ order: "random" }), 42);
    const seq = Array.from({ length: 20 }, (_, i) => r1.stepAt(i));
    expect(seq).to.deep.equal(Array.from({ length: 20 }, (_, i) => r2.stepAt(i)));
    expect(seq.every((s, i) => i === 0 || s !== seq[i - 1])).to.equal(true);
  });

  it("fades in from the previous state on entry", () => {
    const off = [{ red: 0, green: 0, blue: 0 }, { red: 0, green: 0, blue: 0 }];
    const p = new LookPlayer(two, TimingSchema.parse({ entryFade: 2 }), 1, off);
    p.start(0, 0);
    expect(row(p.render(1000, 0))).to.equal("#800000 #000080");
    expect(row(p.render(2500, 0))).to.equal("#ff0000 #0000ff");
  });
});
