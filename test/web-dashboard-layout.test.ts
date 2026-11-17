import { expect } from "chai";
import { WIDGET_KINDS } from "../src/plugins/light/dashboards/widget-kinds.js";
import { WidgetSchema } from "../src/plugins/light/dashboards/dashboards.js";
import { added, autoColored, clone, colorOf, confirmable, defaultSize, dragged, dropCell, holdable, KINDS, neutral, pressable, settle, shared, SUB, targetListOf, type Dashboard, type Drag, type Widget, type WidgetKind } from "../web/src/dashboard-layout.js";

const widget = (id: string, x: number, y: number, w = 2, h = 1, more: Partial<Widget> = {}): Widget => ({ id, kind: "look", x, y, w, h, ...more });
/** A drag of the widget `w`, taken at (100, 100) px, on cells of 50 × 40 px. */
const drag = (w: Widget, mode: Drag["mode"]): Drag => ({ id: w.id, mode, x0: w.x, y0: w.y, w0: w.w, h0: w.h, px: 100, py: 100, cw: 50, rh: 40 });

describe("dashboard layout", () => {
  it("offers every kind once in the palette, each at a size that fits a dashboard", () => {
    // WidgetKind is derived from KINDS: a kind missing here is missing from the type, and the registry
    // (Record<WidgetKind, …>) would not compile with a kind the palette does not offer
    const every: Record<WidgetKind, true> = Object.fromEntries(KINDS.map((k) => [k, true])) as Record<WidgetKind, true>;
    expect(Object.keys(every)).to.have.length(KINDS.length); // no kind twice
    for (const k of KINDS) {
      const { w, h } = defaultSize(k);
      expect(w, k).to.be.within(1, 12);
      expect(h, k).to.be.at.least(1);
    }
    expect(defaultSize("look")).to.deep.equal({ w: 2, h: 1 }); // a button, by default
  });

  it("offers the kinds the server accepts, in the palette's order", () => {
    expect(KINDS).to.equal(WIDGET_KINDS);
    expect(WidgetSchema.shape.kind.options).to.deep.equal([...KINDS]);
  });

  it("copies a dashboard deeply: the copy kept for undo does not change with it", () => {
    const d: Dashboard = { id: "d", name: "D", columns: 12, widgets: [widget("a", 0, 0)] };
    const copy = clone(d);
    d.widgets[0]!.x = 3;
    expect(copy.widgets[0]!.x).to.equal(0);
  });

  describe("settle", () => {
    it("pushes what a widget lands on down, in cascade", () => {
      const ws = [widget("a", 0, 0), widget("b", 0, 1), widget("c", 1, 2), widget("d", 4, 0)];
      const moved = settle([{ ...ws[0]!, h: 2 }, ...ws.slice(1)], "a");
      expect(moved.map((w) => [w.id, w.y])).to.deep.equal([["a", 0], ["b", 2], ["c", 3], ["d", 0]]); // b under a, c under b, d untouched
    });

    it("leaves the widgets given as they are, and those that only touch", () => {
      const ws = [widget("a", 0, 0), widget("b", 2, 0), widget("c", 0, 1)];
      const out = settle(ws, "a");
      expect(out).to.deep.equal(ws);
      expect(out[0]).to.not.equal(ws[0]); // copies
    });

    it("stops on an unknown id", () => {
      const ws = [widget("a", 0, 0), widget("b", 0, 0)];
      expect(settle(ws, "nope")).to.deep.equal(ws);
    });
  });

  describe("dragged", () => {
    const w = widget("a", 2, 3, 2, 2);
    it("moves by whole cells on the magnetic grid, by quarters off it", () => {
      expect(dragged(drag(w, "move"), 100 + 60, 100 + 45, 1, 12)).to.deep.equal({ x: 3, y: 4, w: 2, h: 2 }); // 1.2 cells → 1, 1.125 → 1
      expect(dragged(drag(w, "move"), 100 + 60, 100 + 45, 1 / SUB, 12)).to.deep.equal({ x: 3.25, y: 4.25, w: 2, h: 2 });
    });

    it("keeps the widget within the columns and below the top", () => {
      expect(dragged(drag(w, "move"), 100 - 500, 100 - 500, 1, 12)).to.deep.equal({ x: 0, y: 0, w: 2, h: 2 });
      expect(dragged(drag(w, "move"), 100 + 5000, 100, 1, 12)).to.deep.equal({ x: 10, y: 3, w: 2, h: 2 });
    });

    it("resizes by a corner, the opposite corner staying put", () => {
      expect(dragged(drag(w, "se"), 100 + 100, 100 + 80, 1, 12)).to.deep.equal({ x: 2, y: 3, w: 4, h: 4 });
      expect(dragged(drag(w, "nw"), 100 - 50, 100 - 40, 1, 12)).to.deep.equal({ x: 1, y: 2, w: 3, h: 3 });
      expect(dragged(drag(w, "ne"), 100 + 50, 100 + 40, 1, 12)).to.deep.equal({ x: 2, y: 4, w: 3, h: 1 });
      expect(dragged(drag(w, "sw"), 100 + 50, 100 + 40, 1, 12)).to.deep.equal({ x: 3, y: 3, w: 1, h: 3 });
    });

    it("never makes a widget smaller than a step, nor wider than the dashboard", () => {
      expect(dragged(drag(w, "se"), 100 - 500, 100 - 500, 1, 12)).to.deep.equal({ x: 2, y: 3, w: 1, h: 1 });
      expect(dragged(drag(w, "nw"), 100 + 500, 100 + 500, 1 / SUB, 12)).to.deep.equal({ x: 3.75, y: 4.75, w: 0.25, h: 0.25 });
      expect(dragged(drag(w, "se"), 100 + 5000, 100, 1, 4)).to.deep.equal({ x: 0, y: 3, w: 4, h: 2 });
    });
  });

  it("puts a drop in the cell under it, snapped down", () => {
    expect(dropCell(130, 90, 50, 40, 1)).to.deep.equal({ x: 2, y: 2 });
    expect(dropCell(130, 90, 50, 40, 1 / SUB)).to.deep.equal({ x: 2.5, y: 2.25 });
    expect(dropCell(-10, -10, 50, 40, 1)).to.deep.equal({ x: 0, y: 0 });
  });

  describe("added", () => {
    const d: Dashboard = { id: "d", name: "D", columns: 12, widgets: [widget("a", 0, 0), widget("b", 0, 1, 4, 2)] };
    it("goes under the others when clicked, at its default size", () => {
      expect(added(d, "group-fader", "n", undefined, "dca")).to.deep.include({ id: "n", kind: "group-fader", x: 0, y: 3, w: 1, h: 4, target: "dca" });
      expect(added(d, "panic", "n").at(-1)).to.deep.equal({ id: "n", kind: "panic", x: 0, y: 3, w: 2, h: 1 }); // no target: none written
    });

    it("lands where dropped, within the columns, pushing down what it covers", () => {
      const out = added(d, "look", "n", { x: 11, y: 0 }, "l");
      expect(out.find((w) => w.id === "n")).to.include({ x: 10, y: 0 });
      const onA = added(d, "look", "n", { x: 0, y: 0 });
      expect(onA.map((w) => [w.id, w.y])).to.deep.equal([["a", 1], ["b", 2], ["n", 0]]);
    });
  });

  it("says which list a widget picks its target from", () => {
    expect(targetListOf("look")).to.equal("looks");
    expect(["group-fader", "xy", "motion-lock", "colours", "zones"].map((k) => targetListOf(k as Widget["kind"]))).to.deep.equal(Array(5).fill("groups"));
    expect(targetListOf("snapshot")).to.equal("snapshots");
    expect(targetListOf("target")).to.equal("targets");
    expect(targetListOf("position")).to.equal("positions");
    expect(targetListOf("channel-fader")).to.equal("faders");
    expect(targetListOf("panic")).to.equal(undefined);
  });

  it("says which buttons have a mode, ask to confirm, and open their menu on a long press", () => {
    const look = widget("l", 0, 0);
    const momentary = { ...look, mode: "momentary" as const };
    const snapshot = widget("s", 0, 0, 2, 1, { kind: "snapshot" });
    const fader = widget("f", 0, 0, 1, 4, { kind: "group-fader" });
    expect([look, momentary, snapshot, fader].map(pressable)).to.deep.equal([true, true, false, false]);
    expect([look, momentary, snapshot, fader].map(confirmable)).to.deep.equal([true, false, true, false]);
    expect([look, momentary, snapshot, fader].map(holdable)).to.deep.equal([true, false, true, false]);
  });

  it("colours a widget: its own, its look's for « auto », a position's own unless « none »", () => {
    const swatch = (id: string) => (id === "l" ? "#ff0000" : undefined);
    const ofPosition = (id: string | undefined) => (id === "p" ? "#00ff00" : undefined);
    const colour = (more: Partial<Widget>) => colorOf(widget("w", 0, 0, 2, 1, more), swatch, ofPosition);
    expect(colour({ color: "#123456" })).to.equal("#123456");
    expect(colour({ target: "l", color: "auto" })).to.equal("#ff0000");
    expect(colour({ target: "l" })).to.equal(undefined);
    expect(colour({ kind: "position", target: "p" })).to.equal("#00ff00");
    expect(colour({ kind: "position", target: "p", color: "none" })).to.equal(undefined);
    const position = widget("p", 0, 0, 2, 1, { kind: "position" });
    expect([neutral(position), autoColored(position)]).to.deep.equal([false, true]);
    expect([neutral(widget("l", 0, 0)), autoColored(widget("l", 0, 0))]).to.deep.equal([true, false]);
  });

  it("says what several widgets share, or nothing when they differ", () => {
    const ws = [widget("a", 0, 0, 2, 1, { color: "#111111" }), widget("b", 0, 0, 2, 1, { color: "#111111", mode: "trigger" })];
    expect(shared("color", ws)).to.equal("#111111");
    expect(shared("mode", ws)).to.equal(undefined);
    expect(shared("mode", ws.slice(0, 1), "latch")).to.equal("latch");
  });
});
