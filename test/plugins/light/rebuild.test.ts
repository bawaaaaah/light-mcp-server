import { expect } from "chai";
import { generateSteps, TechniqueSchema } from "../../../src/plugins/light/engine/techniques.js";
import { rebuild } from "../../../src/plugins/light/presets/rebuild.js";

const toHex = (steps: ReturnType<typeof generateSteps>) =>
  steps.map((row) => row.map((c) => (c ? "#" + [c.red ?? 0, c.green ?? 0, c.blue ?? 0].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("") : "")).map((h) => (h === "#000000" ? "-" : h)));

describe("rebuild imported steps into techniques", () => {
  const roundTrip = (t: unknown, cells: number, mirror: boolean, recognised: string) => {
    const original = toHex(generateSteps(TechniqueSchema.parse(t), cells, mirror));
    return rebuild(original, recognised, mirror);
  };

  it("damier (mirrored, blocks of 4)", () => {
    const r = roundTrip({ kind: "damier", colors: ["#ff960f", "#ffdc14"], block: 4 }, 32, true, "damier");
    expect(r.technique).to.deep.include({ kind: "damier", block: 4 });
    expect(r.fidelity).to.equal(1);
  });

  it("palette qui tourne", () => {
    const r = roundTrip({ kind: "palette", colors: ["#ff5500", "#ffebd2", "#00b4a0"], block: 4 }, 32, true, "palette qui tourne");
    expect(r.technique).to.deep.include({ kind: "palette", colors: ["#ff5500", "#ffebd2", "#00b4a0"] });
    expect(r.fidelity).to.equal(1);
  });

  it("creux qui tourne", () => {
    const r = roundTrip({ kind: "creux", colors: ["#ff0000", "#0000ff"], block: 4, width: 1 }, 32, false, "creux qui tourne");
    expect(r.technique).to.deep.include({ kind: "creux", block: 4, width: 1 });
    expect(r.fidelity).to.equal(1);
  });

  it("masques", () => {
    const r = roundTrip({ kind: "masques", colors: ["#ff0000", "#0000ff"], block: 4, masks: ["####", "-##-", "#--#"] }, 32, true, "masques");
    expect(r.technique).to.deep.include({ kind: "masques", masks: ["####", "-##-", "#--#"] });
    expect(r.fidelity).to.equal(1);
  });

  it("keeps steps for techniques it cannot rebuild", () => {
    expect(rebuild([["#ff0000"]], "orage", false).technique).to.equal(null);
  });
});
