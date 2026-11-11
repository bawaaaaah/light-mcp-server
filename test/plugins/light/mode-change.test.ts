import { expect } from "chai";
import { freeAddress, planReferences, remapByName, type ModeLayout } from "../../../src/plugins/light/venue/mode-change.js";

const layout = (channels: string[], heads: [number, number[]][] = [[-1, []]]): ModeLayout => ({ channels, heads: new Map(heads) });

/** A fixture's DMX mode changed (T6, A): its channels and heads carried over by name. */
describe("mode change plan (venue/mode-change.ts)", () => {
  const six = layout(["Dimmer", "Red", "Green", "Blue", "Program", "Speed"]);
  const eight = layout(["Strobe", "Dimmer", "Red", "Green", "Blue", "White", "Program", "Speed"]);
  const pixel = layout(["Dimmer", "Red 1", "Green 1", "Blue 1", "Red 2", "Green 2", "Blue 2", "Macro", "Macro"], [
    [0, [1, 2, 3]],
    [1, [4, 5, 6]],
  ]);
  const reversed = layout(["Dimmer", "Red 2", "Green 2", "Blue 2", "Red 1", "Green 1", "Blue 1", "Macro"], [
    [0, [1, 2, 3]],
    [1, [4, 5, 6]],
  ]);

  it("carries a channel by its name: unchanged, moved, lost when absent, past the old mode, or repeated", () => {
    const r = remapByName(six, eight);
    expect(r.channel(0)).to.deep.equal({ kind: "moved", offset: 0, to: 1, name: "Dimmer" });
    expect(r.channel(5)).to.deep.equal({ kind: "moved", offset: 5, to: 7, name: "Speed" });
    expect(remapByName(eight, eight).channel(3)).to.deep.equal({ kind: "same", offset: 3, name: "Green" });
    expect(remapByName(eight, six).channel(0)).to.deep.equal({ kind: "lost", offset: 0, name: "Strobe", why: "absent" });
    expect(r.channel(9)).to.deep.equal({ kind: "lost", offset: 9, why: "beyond" });
    // repeated in the new mode, or in the old one: ambiguous, lost
    expect(remapByName(reversed, pixel).channel(7)).to.deep.equal({ kind: "lost", offset: 7, name: "Macro", why: "ambiguous" });
    expect(remapByName(pixel, reversed).channel(8)).to.deep.equal({ kind: "lost", offset: 8, name: "Macro", why: "ambiguous" });
  });

  it("knows a head by its channels' names: reordered heads follow, the whole fixture stays whole, an unmatched head is lost", () => {
    const r = remapByName(pixel, reversed);
    expect(r.head(0)).to.deep.equal({ kind: "moved", head: 0, to: 1 });
    expect(r.head(1)).to.deep.equal({ kind: "moved", head: 1, to: 0 });
    expect(r.head(-1)).to.deep.equal({ kind: "same", head: -1, to: -1 });
    expect(remapByName(pixel, six).head(0)).to.deep.equal({ kind: "lost", head: 0 });
    // a single head becomes the whole fixture when the new mode has no distinct heads
    const single = layout(["Dimmer", "Red 1", "Green 1", "Blue 1"], [[0, [1, 2, 3]]]);
    expect(remapByName(single, six).head(0)).to.deep.equal({ kind: "moved", head: 0, to: -1 });
  });

  it("rewrites the looks' raw channels (a lost column goes with its channel), the faders and the canvases; lists the rest untouched", () => {
    const looks = [
      { id: "smoke", name: "Fumée", channels: { targets: [{ fixture: "par", offset: 4 }, { fixture: "other", offset: 0 }, { fixture: "par", offset: 0 }], steps: [[10, 20, 30], [11, 21, 31]] } },
      { id: "plain", name: "Sans canal" },
      { id: "elsewhere", name: "Ailleurs", channels: { targets: [{ fixture: "other", offset: 2 }], steps: [[5]] } },
    ];
    const faders = [
      { id: "prog", name: "Programme", channels: [{ fixture: "par", offset: 4 }] },
      { id: "mixed", name: "Mixte", channels: [{ fixture: "par", offset: 5 }, { fixture: "other", offset: 1 }] },
    ];
    const plan = planReferences("par", remapByName(six, pixel), { looks, faders, canvases: [] });
    // Program and Speed are not in Pixel: lost; Dimmer stays at 0
    expect(plan.looks).to.deep.equal([{ id: "smoke", name: "Fumée", channels: { targets: [{ fixture: "other", offset: 0 }, { fixture: "par", offset: 0 }], steps: [[20, 30], [21, 31]] } }]);
    expect(plan.faders).to.deep.equal([{ id: "mixed", name: "Mixte", channels: [{ fixture: "other", offset: 1 }] }]);
    expect(plan.emptied.map((f) => f.id)).to.deep.equal(["prog"]);
    expect(plan.carried.filter((c) => c.fate === "lost").map((c) => `${c.kind}:${c.id}:${c.channel}`)).to.deep.equal(["look:smoke:Program", "fader:prog:Program", "fader:mixed:Speed"]);
    // six → eight: everything moves, nothing lost; a look whose only raw channel goes keeps no channels at all
    const moved = planReferences("par", remapByName(six, eight), { looks, faders, canvases: [] });
    expect(moved.looks[0]!.channels!.targets).to.deep.equal([{ fixture: "par", offset: 6 }, { fixture: "other", offset: 0 }, { fixture: "par", offset: 1 }]);
    expect(moved.faders.map((f) => f.channels[0]!.offset)).to.deep.equal([6, 7]);
    expect(moved.carried.every((c) => c.fate === "moved")).to.equal(true);
    const gone = planReferences("par", remapByName(six, pixel), { looks: [{ id: "only", name: "Seul", channels: { targets: [{ fixture: "par", offset: 5 }], steps: [[1]] } }], faders: [], canvases: [] });
    expect(gone.looks).to.deep.equal([{ id: "only", name: "Seul" }]);
  });

  it("takes a lost canvas target out of its cells, counts the cells left dark, and renumbers moved heads", () => {
    const canvas = {
      id: "row",
      name: "Rang",
      cells: 3,
      render: [
        { from: 0, to: 0, targets: [{ fixture: "par", head: 0 }] },
        { from: 1, to: 1, targets: [{ fixture: "par", head: 1 }, { fixture: "other", head: -1 }] },
        { from: 2, to: 2, targets: [{ fixture: "other", head: -1 }] },
      ],
    };
    const swapped = planReferences("par", remapByName(pixel, reversed), { looks: [], faders: [], canvases: [canvas] });
    expect(swapped.canvases[0]!.render.map((r) => r.targets)).to.deep.equal([[{ fixture: "par", head: 1 }], [{ fixture: "par", head: 0 }, { fixture: "other", head: -1 }], [{ fixture: "other", head: -1 }]]);
    expect(swapped.cellsWithoutRender).to.deep.equal([]);
    const lost = planReferences("par", remapByName(pixel, six), { looks: [], faders: [], canvases: [canvas] });
    expect(lost.canvases[0]!.render).to.deep.equal([
      { from: 1, to: 1, targets: [{ fixture: "other", head: -1 }] },
      { from: 2, to: 2, targets: [{ fixture: "other", head: -1 }] },
    ]);
    expect(lost.cellsWithoutRender).to.deep.equal([{ canvas: "row", name: "Rang", cells: [0] }]);
    expect(lost.carried.filter((c) => c.kind === "canvas").map((c) => c.fate)).to.deep.equal(["lost", "lost"]);
  });

  it("finds the first address where a footprint fits, leaving the fixture itself out", () => {
    const ranges = [
      { id: "a", universe: 1, address: 1, channels: 6 },
      { id: "par", universe: 1, address: 7, channels: 6 },
      { id: "b", universe: 1, address: 15, channels: 4 },
      { id: "c", universe: 2, address: 1, channels: 512 },
    ];
    expect(freeAddress(ranges, 1, 8, "par")).to.equal(7);
    expect(freeAddress(ranges, 1, 9, "par")).to.equal(19);
    expect(freeAddress(ranges, 2, 1, "par")).to.equal(undefined);
  });
});
