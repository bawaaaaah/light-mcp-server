import { expect } from "chai";
import { GHOST_RADIUS_PX, swallows } from "../web/src/ghost-guard.js";
import { SHEET_GUARD_MS } from "../web/src/preview-first.js";

describe("preview before launch: the echo of the press that closed the sheet", () => {
  const armed = { x: 200, y: 400, until: 1000 };

  it("swallows a press at the same spot while the guard lasts", () => {
    expect(swallows(900, armed, { x: 200, y: 400 })).to.equal(true);
    expect(swallows(999, armed, { x: 210, y: 395 })).to.equal(true);
  });

  it("lets a press through once the guard is over (strictly: at the end it is over)", () => {
    expect(swallows(1000, armed, { x: 200, y: 400 })).to.equal(false);
    expect(swallows(5000, armed, { x: 200, y: 400 })).to.equal(false);
  });

  it("lets a press elsewhere through, even inside the delay: a deliberate press is not dropped", () => {
    expect(swallows(900, armed, { x: 200 + GHOST_RADIUS_PX + 1, y: 400 })).to.equal(false);
    expect(swallows(900, armed, { x: 600, y: 90 })).to.equal(false);
    expect(swallows(900, armed, { x: 200 + GHOST_RADIUS_PX, y: 400 })).to.equal(true); // on the edge it still is the same spot
  });

  it("swallows nothing when nothing armed it", () => {
    expect(swallows(0, null, { x: 0, y: 0 })).to.equal(false);
  });

  it("lasts as long as the guard of the sheet (400 ms)", () => {
    expect(SHEET_GUARD_MS).to.equal(400);
  });
});

describe("preview before launch: what the guard lets through while it lasts", () => {
  type Listener = (e: unknown) => void;
  const listeners = new Map<string, Listener>();
  (globalThis as { window?: unknown }).window = { addEventListener: (type: string, fn: Listener) => void listeners.set(type, fn) };
  const press = (type: string, pointerId: number, closest: string | null = null) => {
    const calls: string[] = [];
    const e = { type, pointerId, clientX: 100, clientY: 100, target: { closest: (sel: string) => (sel === closest ? {} : null) }, stopPropagation: () => calls.push("stop"), preventDefault: () => calls.push("prevent") };
    listeners.get(type)!(e);
    return calls.length > 0; // true: swallowed
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("swallows the echo, but never Panic; its undo is an ordinary button", async () => {
    const { armGhostGuard } = await import("../web/src/ghost-guard.js");
    armGhostGuard({ x: 100, y: 100 }, performance.now(), 40);
    expect(press("pointerdown", 1)).to.equal(true);
    expect(press("pointerdown", 2, "button.panic")).to.equal(false);
    expect(press("pointerdown", 3, "button.panic-undo")).to.equal(true);
    expect(press("pointerdown", 4, "button.panic-undo")).to.equal(true);
  });

  it("swallows the release and the click of a swallowed press, however late", async () => {
    const { armGhostGuard } = await import("../web/src/ghost-guard.js");
    armGhostGuard({ x: 100, y: 100 }, performance.now(), 40);
    expect(press("pointerdown", 7)).to.equal(true);
    await wait(80); // held past the guard
    expect(press("pointerup", 7)).to.equal(true);
    expect(press("click", 7)).to.equal(true);
    expect(press("pointerdown", 7)).to.equal(false); // the next press of that pointer is its own
    expect(press("pointerup", 7)).to.equal(false);
  });
});
