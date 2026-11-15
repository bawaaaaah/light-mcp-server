import { expect } from "chai";
import { targetHeads, targetParts } from "../web/src/target-status.js";
import type { HeadMotion } from "../src/plugins/light/show/motion-report.js";

type Axis = HeadMotion["pan"];
const axis = (layer: Axis["layer"], owner: string | null, error?: string): Axis => ({ layer, layers: [layer], claims: [], owner, position: 0.5, moving: false, ...(error ? { error } : {}) });
const head = (id: string, pan: Axis, more: Partial<HeadMotion> = {}) => ({ id, name: id.toUpperCase(), motion: { lock: "off" as const, pan, tilt: pan, masked: [], released: [], ...more } });

/** The target pad's status line (T24, lot 4): what each head of a target does, from the motion layer's report. */
describe("target pad: the state of each head", () => {
  it("follows, holds with its reason, taken by hand, released, frozen, masked, before any frame", () => {
    const heads = [
      head("a", axis("target", "target:t")),
      head("b", axis("target", "target:t", "hors de portée")),
      head("c", axis("manual", "manual")),
      head("d", axis("look", "look:x"), { released: [{ owner: "target:t" }] }),
      head("e", axis("lock", null), { lock: "hard" }),
      head("f", axis("target", "target:u")),
      { id: "g", name: "G", motion: null },
    ];
    expect(targetHeads(heads, "t", true).map((h) => [h.id, h.state, h.reason])).to.deep.equal([
      ["a", "follows", undefined],
      ["b", "held", "hors de portée"],
      ["c", "manual", undefined],
      ["d", "released", undefined],
      ["e", "frozen", undefined],
      ["f", "masked", undefined],
      ["g", "waiting", undefined],
    ]);
    // not engaged: idle, except a head frozen hard, which is said whatever the target does (decision T-b)
    expect(targetHeads(heads, "t", false).map((h) => h.state)).to.deep.equal(["idle", "idle", "idle", "idle", "frozen", "idle", "idle"]);
  });

  it("groups the heads by state, the held ones by reason, in the line's order", () => {
    const states = targetHeads(
      [
        head("a", axis("target", "target:t")),
        head("b", axis("target", "target:t", "hors de portée")),
        head("c", axis("target", "target:t")),
        head("d", axis("target", "target:t", "vers une zone interdite")),
        head("e", axis("manual", "manual")),
        head("f", axis("target", "target:t", "hors de portée")),
      ],
      "t",
      true,
    );
    expect(targetParts(states)).to.deep.equal([
      { state: "follows", names: ["A", "C"] },
      { state: "held", reason: "hors de portée", names: ["B", "F"] },
      { state: "held", reason: "vers une zone interdite", names: ["D"] },
      { state: "manual", names: ["E"] },
    ]);
    expect(targetParts([])).to.deep.equal([]);
  });
});
