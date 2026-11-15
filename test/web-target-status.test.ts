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

  it("a tilt alone held for the target holds the head; the reason in the screen's words", () => {
    const pan = axis("target", "target:t");
    const tilt = { ...axis("target", "target:t", "hors de portée (pan 0°, tilt 180°)"), hold: { reason: "out-of-reach" as const, reach: { pan: 0, tilt: 180 } } };
    const states = targetHeads([head("a", pan, { tilt })], "t", true, { reason: (a) => (a.hold ? `out of reach (tilt ${a.hold.reach!.tilt}°)` : a.error!) });
    expect(states).to.deep.equal([{ id: "a", name: "A", state: "held", reason: "out of reach (tilt 180°)" }]);
  });

  it("says what masks a head (the soft lock, another target) and a head handed back with nothing below as at rest", () => {
    const states = targetHeads(
      [
        head("a", axis("lock", null), { lock: "soft" }),
        head("b", { ...axis("target", "target:u"), name: "Cible U" }),
        head("c", axis("rest", null), { released: [{ owner: "target:t" }] }),
        head("d", axis("look", "look:x"), { released: [{ owner: "target:t" }] }),
      ],
      "t",
      true,
      { softLock: "le verrou souple" },
    );
    expect(states.map((h) => [h.state, h.by])).to.deep.equal([
      ["masked", "le verrou souple"],
      ["masked", "Cible U"],
      ["resting", undefined],
      ["released", undefined],
    ]);
    expect(targetParts(states).map((p) => [p.state, p.by, p.names])).to.deep.equal([
      ["released", undefined, ["D"]],
      ["resting", undefined, ["C"]],
      ["masked", "le verrou souple", ["A"]],
      ["masked", "Cible U", ["B"]],
    ]);
  });

  it("not engaged: « Non engagée » first, counting every head, then the frozen ones", () => {
    const states = targetHeads([head("a", axis("rest", null)), head("b", axis("lock", null), { lock: "hard" }), head("c", axis("rest", null))], "t", false);
    expect(targetParts(states)).to.deep.equal([
      { state: "idle", names: ["A", "B", "C"] },
      { state: "frozen", names: ["B"] },
    ]);
  });
});
