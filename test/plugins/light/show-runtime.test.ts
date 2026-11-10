import { expect } from "chai";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { addWeighted, settle, splitByShown, Venue, weighted } from "../../../src/plugins/light/venue/venue.js";
import { dcaLevel, ShowRuntime } from "../../../src/plugins/light/show/runtime.js";
import { GroupSchema } from "../../../src/plugins/light/show/model.js";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "light-show-"));
  const defs = join(dir, "fixtures");
  mkdirSync(defs);
  copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(defs, "bar4.qxf"));
  copyFileSync(new URL("../../fixtures/machine.qxf", import.meta.url), join(defs, "machine.qxf"));
  const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
  venue.fixtures.put({ id: "bar-l", name: "Barre public", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1, role: "wash-public" });
  venue.fixtures.put({ id: "bar-r", name: "Barre fond", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 16, role: "contre" });
  venue.canvases.put({
    id: "mur",
    name: "Mur",
    topology: "line",
    cells: 8,
    render: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ from: i, to: i, targets: [{ fixture: i < 4 ? "bar-l" : "bar-r", head: i % 4 }] })),
  });
  let beats = 0;
  let now = 0;
  const show = new ShowRuntime(new FolderStore(join(dir, "show")), venue, { state: () => ({ beats }) }, () => now);
  const advance = (b: number) => {
    beats += b;
    now += b * 500;
  };
  const dmx = () => {
    const buffers = [new Uint8Array(512)];
    show.render(buffers);
    return buffers[0]!;
  };
  return { venue, show, dmx, advance };
}

describe("weighted sheets (cross-fade)", () => {
  const red = { red: 1 };
  const green = { green: 1 };
  const sheet = (heads: [number, object][]) => new Map([["f", new Map(heads as [number, typeof red][])]]);

  it("adds the colours and the weights where both paint a head, and a whole fixture reaches the heads of the other", () => {
    const sum = addWeighted(weighted(sheet([[-1, red]]), 0.5), weighted(sheet([[0, green]]), 0.5));
    expect(sum.get("f")!.get(0)).to.deep.equal({ color: { red: 1, green: 1 }, weight: 1 }); // A's whole red reaches head 0
    expect(sum.get("f")!.get(-1)!.weight).to.equal(0.5); // and stays alone on the others
    const other = addWeighted(weighted(sheet([[0, red]]), 0.5), weighted(sheet([[-1, green]]), 0.5));
    expect(other.get("f")!.get(0)!.weight).to.equal(1); // the same the other way round
  });

  it("settles a cell shared out past 1 and leaves a lighter one as it is", () => {
    const heavy = settle(addWeighted(weighted(sheet([[0, { red: 0.74 }]]), 0.74), weighted(sheet([[0, green]]), 1))); // colours already scaled by their weight
    expect(heavy.get("f")!.get(0)!.red).to.be.closeTo(0.74 / 1.74, 1e-9);
    expect(heavy.get("f")!.get(0)!.green).to.be.closeTo(1 / 1.74, 1e-9);
    expect(settle(weighted(sheet([[0, { red: 0.4 }]]), 0.4)).get("f")!.get(0)).to.deep.equal({ red: 0.4 });
  });

  it("splits what is on the heads another sheet shows from the rest", () => {
    const a = weighted(sheet([[-1, red], [2, green]]), 1);
    const { inside, outside } = splitByShown(a, sheet([[0, green]]));
    expect([...inside.get("f")!.keys()]).to.deep.equal([0]); // the whole red copied to head 0
    expect([...outside.get("f")!.keys()].sort()).to.deep.equal([-1, 2]); // and still there for the other heads
    expect(splitByShown(a, new Map()).outside.get("f")).to.equal(a.get("f")); // a fixture the other does not paint: all outside
    expect(splitByShown(a, sheet([[-1, green]])).inside.get("f")).to.equal(a.get("f")); // painted whole: all inside
  });
});

describe("show runtime", () => {
  it("reads back what each head shows, for the live 2D preview", () => {
    const { venue, show, dmx } = setup();
    show.looks.put({ id: "dam", name: "Damier", canvas: "mur", technique: { kind: "damier", colors: ["#ff0000", "#0000ff"], block: 1 } });
    show.go("dam");
    const colors = venue.displayColors([dmx()]);
    expect(colors["bar-l"]).to.deep.equal(["#ff0000", "#0000ff", "#ff0000", "#0000ff"]);
    show.groups.put({ id: "m", name: "M", members: { fixtures: ["bar-l"] }, master: { level: 0.5, mute: false } });
    expect(venue.displayColors([dmx()])["bar-l"]![0]).to.equal("#800000"); // the dimmer is applied
    expect(venue.displayColors([new Uint8Array(512)])["bar-r"]).to.deep.equal(["#000000", "#000000", "#000000", "#000000"]);
    expect(venue.strobing([dmx()])).to.deep.equal({}); // the shutter is held open
    const strobe = dmx();
    strobe[1] = 200; // bar-l's strobe channel, in its « slow to fast » range: no frequency given
    expect(venue.strobing([strobe])).to.deep.equal({ "bar-l": null });
    // an absent fixture shows nothing, even on channels another fixture drives (here its own, read from a buffer it did not fill)
    venue.absent = new Set(["bar-l"]);
    expect(venue.displayColors([strobe])["bar-l"]).to.deep.equal(["#000000", "#000000", "#000000", "#000000"]);
    expect(venue.strobing([strobe])).to.deep.equal({});
  });

  it("bounds nothing through an absent fixture that shares an installed one's addresses", () => {
    const { venue, show, dmx } = setup();
    show.looks.put({ id: "rouge", name: "Rouge", canvas: "mur", technique: { kind: "damier", colors: ["#ff0000", "#ff0000"], block: 1 } });
    show.go("rouge");
    expect(dmx()[3]).to.equal(255); // bar-l, head 1, red
    // one channel further, the same model: its channels land on bar-l's, and its rule says « all at 0 »
    venue.fixtures.put({ id: "a-ghost", name: "Fantôme", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 2 });
    show.rules.put({ id: "noir", name: "Noir", level: "show", scope: { fixture: "a-ghost" }, target: {}, max: 0 });
    expect(dmx()[3]).to.equal(0); // installed, it is bounded (and so is bar-l, on the same bytes)
    show.saveSettings({ absentFixtures: ["a-ghost"] });
    expect(dmx()[3]).to.equal(255); // absent: its rule bounds nothing
    expect(show.explainChannel(1, 4).fixture?.id).to.equal("bar-l"); // and a channel is the installed fixture's
  });

  it("glides smoothed DCA, channel and grand master faders to their level (groups-masters.md, « Lissage »)", () => {
    const { show, dmx, advance } = setup();
    show.looks.put({ id: "f", name: "Face", canvas: "mur", technique: { kind: "plat", color: "#ff0000" } });
    show.go("f");
    const smoothing = { curve: "linear" as const, msPerStep: 10 }; // full travel in 2550 ms; the DCAs dose the dimmer (channel 1)
    show.groups.put({ id: "m", name: "M", members: { fixtures: ["bar-l"] }, master: { level: 0, mute: false, smoothing } });
    expect(dmx()[0]).to.equal(0);
    show.groups.putLive({ ...show.groups.get("m")!, master: { level: 1, mute: false, smoothing } });
    expect(dmx()[0]).to.equal(0); // asked 100 %, still at 0 %
    advance(1275 / 500);
    expect(dmx()[0]).to.equal(128); // halfway
    expect(show.gliding().groups.m).to.be.closeTo(0.5, 1e-9);
    show.setFlash("m", true);
    expect(dmx()[0]).to.equal(255); // a flash is never smoothed
    show.setFlash("m", false);
    advance(1275 / 500);
    expect(dmx()[0]).to.equal(255);
    expect(show.gliding()).to.deep.equal({ groups: {}, faders: {} });
    // the grand master
    show.saveSettings({ grandMasterSmoothing: smoothing });
    dmx();
    show.saveSettings({ grandMaster: 0 });
    expect(dmx()[0]).to.equal(255); // the glide starts at the frame that sees the change
    advance(1275 / 500);
    expect(dmx()[0]).to.equal(128);
    expect(show.gliding().gm).to.be.closeTo(0.5, 1e-9);
    show.saveSettings({ grandMaster: 1, grandMasterSmoothing: undefined });
    expect(dmx()[0]).to.equal(255); // smoothing off: at once
    // a channel fader (bar-r's first green, which the red look leaves at 0)
    show.faders.put({ id: "w", name: "W", channels: [{ fixture: "bar-r", offset: 4 }], level: 0, smoothing });
    expect(dmx()[19]).to.equal(0);
    show.faders.putLive({ ...show.faders.get("w")!, level: 1 });
    expect(dmx()[19]).to.equal(0);
    advance(1275 / 500);
    expect(dmx()[19]).to.equal(128);
    expect(show.gliding().faders.w).to.be.closeTo(0.5, 1e-9);
  });

  it("plays a look on the canvas and follows the beat", () => {
    const { show, dmx, advance } = setup();
    show.looks.put({ id: "dam", name: "Damier", canvas: "mur", technique: { kind: "damier", colors: ["#ff0000", "#0000ff"], block: 1 } });
    show.go("dam");
    let b = dmx();
    expect([b[3], b[5], b[6], b[8]]).to.deep.equal([255, 0, 0, 255]); // cell0 red, cell1 blue
    advance(1);
    b = dmx();
    expect([b[3], b[5]]).to.deep.equal([0, 255]); // swapped on the next beat
  });

  it("plays the entry fade from black (a QLC+ scene's fade in)", () => {
    const { show, dmx, advance } = setup();
    show.looks.put({ id: "f", name: "Face", canvas: "mur", technique: { kind: "plat", color: "#ff0000" }, timing: { entryFade: 2 } });
    show.go("f");
    expect(dmx()[3]).to.equal(0);
    advance(2); // 1 s of 2
    expect(dmx()[3]).to.be.within(100, 155);
    advance(2);
    expect(dmx()[3]).to.equal(255);
  });

  it("fades out on stop with the exit fade", () => {
    const { show, dmx, advance } = setup();
    show.looks.put({ id: "f", name: "Face", canvas: "mur", technique: { kind: "plat", color: "#ff0000" }, timing: { exitFade: 2 } });
    show.go("f");
    expect(show.isActive("f")).to.equal(true);
    show.stop("f");
    expect(show.isActive("f")).to.equal(false);
    expect(show.activeLooks()).to.not.include("f");
    expect(dmx()[3]).to.equal(255);
    advance(2); // 1 s of 2
    expect(dmx()[3]).to.be.within(100, 155);
    advance(2);
    expect(dmx()[3]).to.equal(0);
  });

  it("stops immediately with stopAll, even with an exit fade", () => {
    const { show, dmx } = setup();
    show.looks.put({ id: "f", name: "Face", canvas: "mur", technique: { kind: "plat", color: "#ff0000" }, timing: { exitFade: 2 } });
    show.go("f");
    show.stopAll();
    expect(dmx()[3]).to.equal(0);
  });

  it("restarts a look that is fading out at full when it has no entry fade (a hard cut)", () => {
    const { show, dmx, advance } = setup();
    show.looks.put({ id: "f", name: "Face", canvas: "mur", technique: { kind: "plat", color: "#ff0000" }, timing: { exitFade: 2 } });
    show.go("f");
    show.stop("f");
    advance(2); // halfway through the fade
    const r = show.go("f");
    expect(r.started).to.equal(true);
    expect(show.isActive("f")).to.equal(true);
    expect(dmx()[3]).to.equal(255);
  });

  it("lets the look that arrives win over the one fading out of an exclusive group", () => {
    const { show, dmx, advance } = setup();
    show.looks.put({ id: "a", name: "A", canvas: "mur", technique: { kind: "plat", color: "#ff0000" }, timing: { exitFade: 2 } });
    show.looks.put({ id: "b", name: "B", canvas: "mur", technique: { kind: "plat", color: "#00ff00" } });
    show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
    show.go("a");
    show.go("b");
    advance(1); // 0.5 s into A's 2 s fade-out: A is still lit, yet B (active) wins over it
    expect([dmx()[3], dmx()[4]]).to.deep.equal([0, 255]);
  });

  describe("crossfade between looks of an exclusive group", () => {
    /** A red look A playing, then B (colour `b`) started over it; A and B in one exclusive group. `between`: beats advanced between the two starts, so A is established when B takes over. */
    function pair(opts: { a?: object; b?: object; bColor?: string; aColor?: string; between?: number } = {}) {
      const t = setup();
      t.show.looks.put({ id: "a", name: "A", canvas: "mur", technique: { kind: "plat", color: opts.aColor ?? "#ff0000" }, timing: { ...opts.a } });
      t.show.looks.put({ id: "b", name: "B", canvas: "mur", technique: { kind: "plat", color: opts.bColor ?? "#00ff00" }, timing: { ...opts.b } });
      t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
      t.show.go("a");
      if (opts.between) t.advance(opts.between);
      t.show.go("b");
      return t;
    }
    const rg = (b: Uint8Array) => [b[3]!, b[4]!];

    it("is the weighted mix of both while B comes in and A goes, then B alone", () => {
      const { dmx, advance } = pair({ b: { entryFade: 2 } }); // A has no exit fade: it follows B's entry
      expect(rg(dmx())).to.deep.equal([255, 0]); // nothing of B yet, and A did not drop out
      advance(1); // 0.5 s of 2: B at 0.16, A at 0.84
      const [r0, g0] = rg(dmx());
      expect(r0).to.be.within(213, 217);
      expect(g0).to.be.within(38, 42);
      advance(1); // 1 s of 2: both at half
      const [r, g] = rg(dmx());
      expect(r).to.be.within(126, 129);
      expect(g).to.be.within(126, 129);
      advance(4);
      expect(rg(dmx())).to.deep.equal([0, 255]);
    });

    it("never goes brighter than the brighter of the two: two equal colours stay as they are all along", () => {
      const { dmx, advance } = pair({ b: { entryFade: 2 }, aColor: "#ff0000", bColor: "#ff0000" });
      for (let i = 0; i < 8; i++) {
        expect(dmx()[3]).to.equal(255);
        advance(0.5);
      }
    });

    it("follows A's own exit fade when it has one, and does not jump back up when B is fully in (3 s out, 1 s in)", () => {
      const { dmx, advance } = pair({ a: { exitFade: 3 }, b: { entryFade: 1 } });
      advance(1.98);
      const before = rg(dmx());
      advance(0.04); // across the end of B's fade-in
      const after = rg(dmx());
      expect(Math.abs(after[0] - before[0])).to.be.lessThan(8);
      expect(Math.abs(after[1] - before[1])).to.be.lessThan(8);
      expect(after[0]).to.be.greaterThan(60); // A's tail is still there where it overlaps B
      // at 1 s B is fully in (weight 1) and A still at 0.74: they share the cell as 0.74 and 1 over 1.74, never brighter
      advance(-0.02);
      const [r, g] = rg(dmx());
      expect(r).to.be.within(106, 111);
      expect(g).to.be.within(144, 149);
      advance(8);
      expect(rg(dmx())).to.deep.equal([0, 255]);
    });

    it("passes through a dip when A leaves faster than B comes in (1 s out, 3 s in)", () => {
      const { dmx, advance } = pair({ a: { exitFade: 1 }, b: { entryFade: 3 } });
      advance(1); // 0.5 s: both still on the cell, A at 0.5 and B at 0.07: not shared out up to 1, a dip
      const [ra, ga] = rg(dmx());
      expect(ra).to.be.within(125, 130);
      expect(ga).to.be.within(17, 21);
      advance(2); // 1.5 s: A is gone, B is at half
      const [r, g] = rg(dmx());
      expect(r).to.equal(0);
      expect(g).to.be.within(126, 129);
    });

    it("cuts at once when neither look fades, as before", () => {
      const { dmx } = pair();
      expect(rg(dmx())).to.deep.equal([0, 255]);
    });

    it("keeps the old behaviour when B has no entry fade: A fades under it and shows only where B does not paint", () => {
      const { dmx, advance } = pair({ a: { exitFade: 2 } });
      advance(1);
      expect(rg(dmx())).to.deep.equal([0, 255]);
    });

    it("does not make the leaving look active, and clears with stopAll", () => {
      const { show, dmx, advance } = pair({ b: { entryFade: 2 } });
      expect(show.activeLooks()).to.deep.equal(["b"]);
      advance(1);
      show.stopAll();
      expect(rg(dmx())).to.deep.equal([0, 0]);
    });

    it("starting A again during the crossfade resumes it from its queue weight, and B keeps the weight it has", () => {
      // the presets' case: entry 1 s, exit 0 — A too has an entry fade, so the relaunch is a crossfade
      const { show, dmx, advance } = pair({ a: { entryFade: 1 }, b: { entryFade: 1 }, between: 4 });
      advance(1); // half way into B's entry: A at 0.5 under it, B at 0.5
      const before = rg(dmx());
      show.go("a"); // A again: it resumes from the 0.5 it still has; B leaves from its 0.5
      const after = rg(dmx());
      expect(after[0]).to.be.within(before[0] - 4, before[0] + 4); // A at its queue weight, not from black
      expect(after[1]).to.be.within(before[1] - 4, before[1] + 4); // B at the weight it had, not dropped
      advance(2); // A's 1 s resumption: A back to full, B gone
      expect(rg(dmx())).to.deep.equal([255, 0]);
    });

    it("stopping B while it comes in lets what it replaced keep leaving, without a jump up", () => {
      const { show, dmx, advance } = pair({ b: { entryFade: 2 } });
      advance(2); // half way
      const before = rg(dmx());
      show.stop("b");
      const after = rg(dmx());
      expect(after[0]).to.be.at.most(before[0] + 2);
      expect(after[1]).to.be.at.most(before[1] + 2);
      advance(8);
      expect(rg(dmx())).to.deep.equal([0, 0]);
    });

    it("coming in over a look that was itself coming in: the first leaves from the weight it had", () => {
      const { show, dmx, advance } = pair({ b: { entryFade: 2 } });
      show.looks.put({ id: "c", name: "C", canvas: "mur", technique: { kind: "plat", color: "#0000ff" }, timing: { entryFade: 2 } });
      show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b", "c"] } });
      advance(2); // B is half in
      show.go("c");
      const [r, g] = rg(dmx());
      expect(r + g).to.be.within(120, 260); // what was on stage, not a jump to B at full
      advance(8);
      const b = dmx();
      expect([b[3], b[4], b[5]]).to.deep.equal([0, 0, 255]);
    });

    it("leaves other looks alone: one of another group keeps its place before and after", () => {
      const { show, dmx, advance } = pair({ b: { entryFade: 2 } });
      show.looks.put({ id: "k", name: "K", canvas: "mur", technique: { kind: "plat", color: "#0000ff" } });
      show.go("k"); // another group (none): the last started covers the others where it paints
      expect(dmx()[5]).to.equal(255);
      advance(1);
      expect(dmx()[5]).to.equal(255);
      advance(8);
      expect(dmx()[5]).to.equal(255);
    });

    it("is the same under « plus fort » (an addition, never a maximum)", () => {
      const { show, dmx, advance } = pair({ b: { entryFade: 2 } });
      show.settings = { ...show.settings, looksMerge: "highest" };
      advance(2);
      const [r, g] = rg(dmx());
      expect(r).to.be.within(126, 129);
      expect(g).to.be.within(126, 129);
    });

    it("is not changed by strictBounds, which samples the future, with a rule that really bounds the look it checks", () => {
      const { show, dmx, advance } = pair({ b: { entryFade: 2 }, aColor: "#00ff00", bColor: "#0000ff" });
      show.looks.put({ id: "r", name: "R", canvas: "mur", technique: { kind: "plat", color: "#ff0000" } });
      show.rules.put({ id: "max-red", name: "Max red", level: "show", target: { color: "red" }, max: 128, onViolation: "reject" });
      advance(1);
      const before = [dmx()[4], dmx()[5]];
      expect(show.strictBounds("r")).to.have.length(1); // sampled up to 4 s ahead, past the end of the crossfade
      expect([dmx()[4], dmx()[5]]).to.deep.equal(before);
      advance(1);
      const mid = [dmx()[4]!, dmx()[5]!];
      expect(mid[0]).to.be.within(100, 155); // still going: the crossfade was kept
      expect(show.strictBounds("a")).to.have.length(0);
      expect([dmx()[4], dmx()[5]]).to.deep.equal(mid);
      advance(4);
      expect([dmx()[4], dmx()[5]]).to.deep.equal([0, 255]);
    });

    describe("when the look coming in leaves while it comes in", () => {
      it("go(C) without a fade: A and B go on leaving from where they were, and A is not cut", () => {
        const { show, dmx, advance } = pair({ a: {}, b: { entryFade: 2, exitFade: 2 } });
        show.looks.put({ id: "c", name: "C", canvas: "mur", technique: { kind: "plat", color: "#0000ff" } });
        show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b", "c"] } });
        show.settings = { ...show.settings, looksMerge: "highest" };
        advance(1); // 0.5 s: B at 0.16, A at 0.84
        const before = rg(dmx());
        show.go("c");
        const after = rg(dmx());
        expect(after[0]).to.be.within(before[0] - 3, before[0] + 3); // A not cut
        expect(after[1]).to.be.within(before[1] - 3, before[1] + 3); // B not at full
        expect(dmx()[5]).to.equal(255); // C is there at once
        advance(10);
        expect(rg(dmx())).to.deep.equal([0, 0]); // both gone
        show.stop("c");
        show.go("b"); // a stale crossfade would bring A back
        expect(dmx()[3]).to.equal(0);
      });

      it("stop(B) while B has an exit fade: B and A add up as they did, they do not cover each other", () => {
        const { show, dmx, advance } = pair({ b: { entryFade: 2, exitFade: 2 } });
        advance(2); // half way: 0.5 and 0.5
        const before = rg(dmx());
        show.stop("b");
        const after = rg(dmx());
        expect(after[0]).to.be.within(before[0] - 3, before[0] + 3);
        expect(after[1]).to.be.within(before[1] - 3, before[1] + 3);
        advance(10);
        expect(rg(dmx())).to.deep.equal([0, 0]);
      });

      it("a third look comes in over B half in: A and B leave from the weights they had, adding up", () => {
        const { show, dmx, advance } = pair({ b: { entryFade: 2 } });
        show.looks.put({ id: "c", name: "C", canvas: "mur", technique: { kind: "plat", color: "#0000ff" }, timing: { entryFade: 2 } });
        show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b", "c"] } });
        advance(2); // B half in over A
        show.go("c");
        const [r, g] = rg(dmx());
        expect(r).to.be.within(125, 131); // not [0, 128]: A did not vanish under B
        expect(g).to.be.within(125, 131);
        advance(10);
        const b = dmx();
        expect([b[3], b[4], b[5]]).to.deep.equal([0, 0, 255]);
      });

      it("deleting B leaves what it replaced going on leaving", () => {
        const { show, dmx, advance } = pair({ b: { entryFade: 2 } });
        advance(1);
        show.drop("b");
        advance(2);
        expect(dmx()[3]).to.be.within(1, 254); // A is still on its way down
        advance(10);
        expect(rg(dmx())).to.deep.equal([0, 0]);
      });
    });

    /** The crossfades the runtime holds (private state: what a test can only see here is whether they are let go). */
    const held = (show: unknown) => (show as { crossfades: Map<string, { outgoing: { look: { id: string } }[] }> }).crossfades;

    it("is let go of once it has ended, and when a look starts again it no longer leaves under another", () => {
      const { show, dmx, advance } = pair({ b: { entryFade: 2 } });
      expect(held(show).size).to.equal(1);
      advance(10);
      dmx(); // a frame lets go of what has ended
      expect(held(show).size).to.equal(0);
      const again = pair({ b: { entryFade: 2 } });
      again.show.go("a"); // A starts again: B leaves, A is not under anything
      expect([...held(again.show).values()].flatMap((c) => c.outgoing.map((o) => o.look.id))).to.not.include("a");
    });

    it("keeps coming in at the right weight when B is edited while it comes in (it restarts without its own entry fade)", () => {
      const { show, dmx, advance } = pair({ b: { entryFade: 2 } });
      advance(2); // half way
      show.looks.put({ id: "b", name: "B", canvas: "mur", technique: { kind: "plat", color: "#00fe00" }, timing: { entryFade: 2 } }); // edited live (another green): it restarts
      const [r, g] = rg(dmx());
      expect(g).to.be.within(124, 132); // not from black again
      expect(r).to.be.within(124, 132);
    });

    it("does not bring a crossfade back when a deleted look is started again", () => {
      const { show, dmx, advance } = pair({ b: { entryFade: 2 } });
      advance(1); // 0.5 s: B just started to come in
      show.drop("b");
      show.go("b"); // B again, from its own entry fade: nothing of the old crossfade
      advance(2); // 1 s into the new entry fade, 1.5 s after the old start (it would be at 0.84)
      const [r, g] = rg(dmx());
      expect(g).to.be.within(126, 129); // its own entry fade only, not times the old one
      expect(r).to.equal(0); // and A is not back
    });

    it("sets aside the crossfade that names a look when strictBounds checks its launch: starting A again would break the rule even while it leaves", () => {
      const { show, advance } = pair({ b: { entryFade: 2 }, aColor: "#00ff00", bColor: "#0000ff" });
      show.rules.put({ id: "max-green", name: "Max green", level: "show", target: { color: "green" }, max: 200, onViolation: "reject" });
      advance(1); // A leaves at 0.84 of 255 = 215 over the limit, which a launch of A must not hide
      expect(show.strictBounds("a")).to.have.length(1);
      expect(held(show).size).to.equal(1); // and the crossfade is back
    });

    /** bar-l has 4 heads of 3 channels from channel 1: head h reads at 3 + 3h (red), +1 (green), +2 (blue). */
    const head = (b: Uint8Array, h: number) => [b[3 + 3 * h]!, b[4 + 3 * h]!, b[5 + 3 * h]!];
    function heads(opts: { aCanvas: string; bCanvas: string; bColor?: string }) {
      const t = setup();
      const one = (id: string, h?: number) => t.venue.canvases.put({ id, name: id, topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [h === undefined ? { fixture: "bar-l" } : { fixture: "bar-l", head: h }] }] });
      one("entier");
      one("tete0", 0);
      one("tete1", 1);
      t.show.looks.put({ id: "a", name: "A", canvas: opts.aCanvas, technique: { kind: "plat", color: "#ff0000" }, timing: { exitFade: 2 } });
      t.show.looks.put({ id: "d", name: "D", canvas: "tete1", technique: { kind: "plat", color: "#0000ff" } }); // on head 1 only, launched after A
      t.show.looks.put({ id: "b", name: "B", canvas: opts.bCanvas, technique: { kind: "plat", color: opts.bColor ?? "#00ff00" }, timing: { entryFade: 2 } });
      t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
      t.show.go("a");
      t.show.go("d");
      t.show.go("b");
      return t;
    }

    it("keeps the tail of A under a look launched after it on the heads B does not paint of a fixture B paints a head of", () => {
      const { dmx, advance } = heads({ aCanvas: "mur", bCanvas: "tete0" });
      advance(2); // 1 s of 2
      const b = dmx();
      expect(head(b, 1)).to.deep.equal([0, 0, 255]); // D shows on head 1, not A's red tail laid over it
      expect(head(b, 2)[0]).to.be.within(100, 140); // head 2: nobody else, A's tail is still there (half way)
      expect(head(b, 0)[0]).to.be.within(100, 140); // head 0: A and B share it
      expect(head(b, 0)[1]).to.be.within(100, 140);
    });

    it("does the same when A paints the whole fixture: shared with B on its head, under D elsewhere", () => {
      const { dmx, advance } = heads({ aCanvas: "entier", bCanvas: "tete0" });
      advance(2);
      const b = dmx();
      expect(head(b, 1)).to.deep.equal([0, 0, 255]);
      expect(head(b, 2)[0]).to.be.within(100, 140);
      expect(head(b, 0)[0]).to.be.within(100, 140);
      expect(head(b, 0)[1]).to.be.within(100, 140);
      advance(10);
      expect(head(dmx(), 2)).to.deep.equal([0, 0, 0]);
    });

    it("shares every head with B when B paints the whole fixture and A paints heads", () => {
      const { dmx, advance } = heads({ aCanvas: "mur", bCanvas: "entier" });
      advance(2);
      const b = dmx();
      expect(head(b, 2)[0]).to.be.within(100, 140);
      expect(head(b, 2)[1]).to.be.within(100, 140);
    });

    it("resetLive lets go of every crossfade, and a look whose build fails while one runs does not cut the others", () => {
      const { show, dmx, advance } = pair({ b: { entryFade: 2, exitFade: 2 } });
      advance(1);
      show.looks.put({ id: "x", name: "X", canvas: "nowhere", technique: { kind: "plat", color: "#0000ff" } });
      show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b", "x"] } });
      const before = rg(dmx());
      expect(() => show.go("x")).to.throw(/canevas inconnu|unknown canvas/); // B and A were released for it, then it did not build
      const after = rg(dmx());
      expect(after[0]).to.be.within(before[0] - 3, before[0] + 3);
      expect(after[1]).to.be.within(before[1] - 3, before[1] + 3);
      show.resetLive();
      expect(held(show).size).to.equal(0);
    });

    describe("resuming a look that still leaves (fast changes must not flash)", () => {
      /**
       * Samples the three channels of head 0 every 20 ms over `ms` milliseconds (plan-t2 §1), with `at` running
       * between samples (a relaunch, usually at i === 0), and checks the whole span:
       * - continuity: no channel moves faster than the fades in `fades` allow — smoothstep's steepest slope is
       *   1.5 per second of fade, and fades driving the same cell add up;
       * - no trough: the sum of the channels never dips below `floor` (default: the lesser of its two ends) —
       *   a relaunch that drops the old light shows at once;
       * - no overshoot: no channel, nor their sum, rises above the greater of its two ends — the look painted twice.
       */
      const sampled = (
        t: { dmx: () => Uint8Array; advance: (beats: number) => void },
        ms: number,
        fades: number[],
        opts: { floor?: number; at?: (i: number) => void; label?: string } = {},
      ): number[][] => {
        const margin = 8;
        const step = 255 * 0.02 * fades.reduce((sum, d) => sum + 1.5 / d, 0) + margin; // the most all the fades can move in 20 ms
        // sample 0 is the span's start; sample 1 is the same instant, right after `at` ran; then one every 20 ms
        const atMs = (k: number) => (k <= 1 ? 0 : (k - 1) * 20);
        const where = (i: number, what: string) => `${opts.label ?? ""} ${what} at sample ${i} (${atMs(i)} ms)`;
        const out: number[][] = [];
        let prev = head(t.dmx(), 0);
        out.push(prev);
        for (let i = 0; i * 20 < ms; i++) {
          opts.at?.(i);
          const cur = head(t.dmx(), 0);
          out.push(cur);
          for (let c = 0; c < 3; c++)
            expect(Math.abs(cur[c]! - prev[c]!), where(out.length - 1, `channel ${c} jumped ${prev[c]} → ${cur[c]}, more than ${step.toFixed(1)}`)).to.be.at.most(step);
          prev = cur;
          t.advance(0.04);
        }
        const sums = out.map((s) => s.reduce((a, b) => a + b, 0));
        const floor = opts.floor ?? Math.min(sums[0]!, sums.at(-1)!) - margin;
        const top = Math.max(sums[0]!, sums.at(-1)!) + margin;
        sums.forEach((s, i) => {
          expect(s, where(i, `a trough: ${s} under ${floor}`)).to.be.at.least(floor);
          expect(s, where(i, `an overshoot: ${s} over ${top}`)).to.be.at.most(top);
        });
        const tops = [0, 1, 2].map((c) => Math.max(out[0]![c]!, out.at(-1)![c]!) + margin);
        out.forEach((s, i) => s.forEach((v, c) => expect(v, where(i, `channel ${c} overshoot: ${v} over ${tops[c]}`)).to.be.at.most(tops[c]!)));
        return out;
      };

      it("resumes A mid-crossfade with no jump, no trough and no overshoot (25 %, 50 %, 75 %; entries 1 s and 2 s)", () => {
        for (const entry of [1, 2]) {
          for (const part of [0.25, 0.5, 0.75]) {
            const t = pair({ a: { entryFade: entry }, b: { entryFade: entry }, between: entry * 4 }); // A established when B takes over
            t.advance(part * entry * 2); // part of the way into B's entry (1 beat = 500 ms)
            sampled(t, (entry + 0.5) * 1000, [entry, entry], {
              label: `entry ${entry} s, relaunch at ${part * 100} %`,
              at: (i) => {
                if (i === 0) t.show.go("a");
              },
            });
          }
        }
      });

      it("resumes A after a chain A → B → C, with no jump and no overshoot (the chain's own dip stays)", () => {
        const t = pair({ a: { entryFade: 1 }, b: { entryFade: 1 }, between: 4 });
        t.show.looks.put({ id: "c", name: "C", canvas: "mur", technique: { kind: "plat", color: "#0000ff" }, timing: { entryFade: 1 } });
        t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b", "c"] } });
        t.advance(0.5); // 25 % into B's entry
        t.show.go("c");
        t.advance(0.5); // 25 % into C's entry: A at 0.63, B at 0.13 under C at 0.16 (blue)
        // the chain passes shortened tails on (dur − elapsed) while every entry is full length, so the full
        // light dips on its own — but that dip is before this span: what must not happen is the relaunch
        // dropping A's queue (pre-fix: red 159 → 0 at once) or any channel overshooting.
        sampled(t, 2500, [1, 0.5, 1], {
          at: (i) => {
            if (i === 0) t.show.go("a");
          },
        });
      });

      it("resumes a look relaunched from its own fading copy (stopped with an exit fade, nothing else playing)", () => {
        const t = setup();
        t.show.looks.put({ id: "a", name: "A", canvas: "mur", technique: { kind: "plat", color: "#ff0000" }, timing: { entryFade: 1, exitFade: 1 } });
        t.show.go("a");
        t.advance(4); // 2 s: in, past its entry
        t.show.stop("a"); // fades out over 1 s
        t.advance(1); // half way down: at 0.5
        sampled(t, 2000, [1], {
          at: (i) => {
            if (i === 0) t.show.go("a");
          },
        });
      });

      it("resumes B in turn, relaunched after A took its place back", () => {
        const t = pair({ a: { entryFade: 1 }, b: { entryFade: 1 }, between: 4 });
        t.advance(0.5); // 25 % into B's entry
        t.show.go("a"); // A takes its place back; B leaves under it
        t.advance(0.5); // 25 % into A's resumption
        sampled(t, 2000, [1, 1], {
          at: (i) => {
            if (i === 0) t.show.go("b");
          },
        });
      });

      it("holds through two relaunches less than 100 ms apart", () => {
        const t = pair({ a: { entryFade: 1 }, b: { entryFade: 1 }, between: 4 });
        sampled(t, 2200, [1, 1], {
          at: (i) => {
            if (i === 2) t.show.go("a"); // 40 ms into B's entry
            if (i === 4) t.show.go("b"); // 80 ms: less than 100 ms after
          },
        });
      });

      it("keeps the look's place in its animation when it resumes (it does not go back to the first step)", () => {
        const t = setup();
        t.show.looks.put({ id: "a", name: "A", canvas: "mur", technique: { kind: "damier", colors: ["#ff0000", "#0000ff"], block: 1 }, timing: { every: { beats: 2 }, entryFade: 1 } });
        t.show.looks.put({ id: "b", name: "B", canvas: "mur", technique: { kind: "plat", color: "#00ff00" }, timing: { entryFade: 1 } });
        t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
        t.show.go("a");
        t.advance(3); // 1.5 s: in, and on step 1 (a step every 2 beats) — cell 0 blue
        t.show.go("b");
        t.advance(0.2); // 100 ms into B's entry: A leaves under it
        t.show.go("a"); // A resumes: still on step 1, not back on step 0
        const b = t.dmx();
        expect(b[5]).to.be.within(230, 255); // head 0 blue, at the weight A still has (≈ 0.97)
        expect(b[3]).to.be.below(25); // not red: the animation did not restart on step 0
      });

      it("starts a look fresh that was edited while it was leaving (it does not resume the old copy)", () => {
        const t = pair({ a: { entryFade: 1 }, b: { entryFade: 1 }, between: 4 });
        t.advance(0.5); // 25 % into B's entry: A at 0.84 under it
        t.show.looks.put({ id: "a", name: "A", canvas: "mur", technique: { kind: "plat", color: "#ff8000" }, timing: { entryFade: 1 } }); // edited live
        t.show.go("a");
        const [r, g] = rg(t.dmx());
        expect(r).to.be.below(10); // from black again, not from the 0.84 its old copy still had
        expect(g).to.be.within(30, 45); // B keeps leaving from the weight it has (0.16)
        t.advance(2); // 1 s: the edited look is in
        expect(rg(t.dmx())).to.deep.equal([255, 128]); // the new definition plays
      });

      it("resumes without a jump when the look is saved again unchanged (a put stores another object)", () => {
        const t = pair({ a: { entryFade: 1 }, b: { entryFade: 1 }, between: 4 });
        t.advance(1); // half way: A at 0.5 under B
        const before = rg(t.dmx());
        t.show.looks.put(t.show.looks.get("a")!); // same definition, saved again: not an edit
        t.show.go("a");
        const after = rg(t.dmx());
        expect(after[0]).to.be.within(before[0] - 4, before[0] + 4); // A from its queue weight, not from black
        expect(after[1]).to.be.within(before[1] - 4, before[1] + 4);
      });

      it("resumes when the look is saved again with its technique map in another key order (a map has no order)", () => {
        const t = setup();
        const look = (map: object) => ({ id: "a", name: "A", canvas: "mur", technique: { kind: "masques-colores", block: 1, map, patterns: ["RB"] }, timing: { entryFade: 1 } });
        t.show.looks.put(look({ R: "#ff0000", B: "#0000ff" }));
        t.show.looks.put({ id: "b", name: "B", canvas: "mur", technique: { kind: "plat", color: "#00ff00" }, timing: { entryFade: 1 } });
        t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
        t.show.go("a");
        t.advance(4); // A established
        t.show.go("b");
        t.advance(1); // half way: A at 0.5 under B
        const before = head(t.dmx(), 0);
        t.show.looks.put(look({ B: "#0000ff", R: "#ff0000" })); // same content, other key order
        t.show.go("a");
        const after = head(t.dmx(), 0);
        for (let c = 0; c < 3; c++) expect(after[c]).to.be.within(before[c]! - 4, before[c]! + 4);
      });

      it("applies a palette edited while the look queued, rather than resuming the old one", () => {
        const t = setup();
        t.show.palettes.put({ id: "p", name: "P", colors: ["#ff0000"] });
        t.show.looks.put({ id: "a", name: "A", canvas: "mur", palette: "p", technique: { kind: "plat", color: "#000000" }, timing: { entryFade: 1 } });
        t.show.looks.put({ id: "b", name: "B", canvas: "mur", technique: { kind: "plat", color: "#00ff00" }, timing: { entryFade: 1 } });
        t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
        t.show.go("a");
        t.advance(4); // A established
        t.show.go("b");
        t.advance(0.5); // 25 % into B's entry: A at 0.84 under it
        t.show.palettes.put({ id: "p", name: "P", colors: ["#0000ff"] }); // edited while A queues
        t.show.go("a");
        t.advance(2); // A's 1 s resumption
        expect(head(t.dmx(), 0)).to.deep.equal([0, 0, 255]); // the palette now current, not the one it queued under
      });

      it("cuts at once on relaunch when the look has no entry fade, but its animation keeps its place", () => {
        const t = setup();
        t.show.looks.put({ id: "a", name: "A", canvas: "mur", technique: { kind: "damier", colors: ["#ff0000", "#0000ff"], block: 1 }, timing: { every: { beats: 2 } } });
        t.show.looks.put({ id: "b", name: "B", canvas: "mur", technique: { kind: "plat", color: "#00ff00" }, timing: { entryFade: 2 } });
        t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
        t.show.go("a");
        t.advance(3); // on step 1: cell 0 blue
        t.show.go("b");
        t.advance(0.2); // 100 ms into B's 2 s entry: A leaves under it
        t.show.go("a"); // no entry fade: A cuts back at once — on the step it is on
        expect(head(t.dmx(), 0)).to.deep.equal([0, 0, 255]); // blue, not the red of a restart on step 0
      });

      it("still drops the queue at once when the look is deleted", () => {
        const t = pair({ a: { entryFade: 1 }, b: { entryFade: 1 }, between: 4 });
        t.advance(1); // half way: A at 0.5 under B
        t.show.drop("a");
        expect(rg(t.dmx())).to.deep.equal([0, 128]); // A's tail is gone, B keeps its weight
        t.advance(10);
        expect(rg(t.dmx())).to.deep.equal([0, 255]);
      });

      it("starts from black after stopAll, with nothing left of the old state", () => {
        const t = pair({ a: { entryFade: 1 }, b: { entryFade: 1 }, between: 4 });
        t.advance(1); // half way into B's entry
        t.show.stopAll();
        expect(rg(t.dmx())).to.deep.equal([0, 0]);
        t.show.go("a");
        expect(rg(t.dmx())).to.deep.equal([0, 0]); // nothing to resume: its own entry fade, from black
        expect(held(t.show).size).to.equal(0); // no crossfade: nothing was released, nothing resumed
        t.advance(2);
        expect(rg(t.dmx())).to.deep.equal([255, 0]);
      });

      it("shares the cell and never goes brighter when A resumes over a longer tail (1 s in, 3 s out), in both merges", () => {
        for (const looksMerge of ["last", "highest"] as const) {
          const t = pair({ a: { entryFade: 1, exitFade: 3 }, b: { entryFade: 1 }, between: 4 });
          t.show.settings = { ...t.show.settings, looksMerge };
          t.advance(1); // 0.5 s: A leaves over its 3 s exit, B half in
          const before = rg(t.dmx());
          t.show.go("a"); // A resumes from 0.93, B leaves from 0.5: they share the cell over their sum
          const after = rg(t.dmx());
          expect(after[0]).to.be.within(before[0] - 3, before[0] + 3); // continuous
          expect(after[1]).to.be.within(before[1] - 3, before[1] + 3);
          expect(after[0]).to.be.within(160, 172); // 0.93 of the 1.43 the cell carries
          expect(after[1]).to.be.within(83, 95);
          t.advance(1); // 0.5 s of A's resumption
          const mid = rg(t.dmx());
          expect(mid[0]).to.be.within(196, 208); // 0.96 of 1.21 — never brighter than the brighter
          expect(mid[1]).to.be.within(46, 58);
          t.advance(5); // A's 1 s in, B's 1 s tail gone
          expect(rg(t.dmx())).to.deep.equal([255, 0]);
        }
      });
    });

    it("keeps the tail of A from covering a look that has nothing to do with the crossfade (another look under B's fixtures)", () => {
      const { venue, show, dmx, advance } = setup();
      venue.canvases.put({ id: "gauche", name: "Gauche", topology: "line", cells: 4, render: [0, 1, 2, 3].map((i) => ({ from: i, to: i, targets: [{ fixture: "bar-l", head: i }] })) });
      show.looks.put({ id: "d", name: "D", canvas: "mur", technique: { kind: "plat", color: "#0000ff" } });
      show.looks.put({ id: "a", name: "A", canvas: "mur", technique: { kind: "plat", color: "#ff0000" } });
      show.looks.put({ id: "b", name: "B", canvas: "gauche", technique: { kind: "plat", color: "#00ff00" }, timing: { entryFade: 2 } });
      show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
      show.go("d");
      show.go("a");
      show.go("b");
      for (let i = 0; i < 6; i++) {
        const b = dmx();
        expect([b[18], b[20]]).to.deep.equal([0, 255]); // on the right bar D shows, not A's red tail
        advance(0.5);
      }
    });
  });

  it("drops a deleted look at once, its fade-out included", () => {
    const { show, dmx } = setup();
    show.looks.put({ id: "f", name: "Face", canvas: "mur", technique: { kind: "plat", color: "#ff0000" }, timing: { exitFade: 2 } });
    show.go("f");
    show.drop("f");
    expect(dmx()[3]).to.equal(0);
  });

  it("keeps a fade-out going while strictBounds samples the future for another launch", () => {
    const { show, dmx, advance } = setup();
    show.looks.put({ id: "a", name: "A", canvas: "mur", technique: { kind: "plat", color: "#00ff00" }, timing: { exitFade: 2 } });
    show.looks.put({ id: "r", name: "R", canvas: "mur", technique: { kind: "plat", color: "#ff0000" } });
    show.rules.put({ id: "max-red", name: "Max red", level: "show", target: { color: "red" }, max: 128, onViolation: "reject" });
    show.go("a");
    show.stop("a");
    advance(2); // 1 s of 2
    expect(show.strictBounds("r")).to.have.length(1); // sampled up to 4 s ahead, past the end of A's fade
    expect(dmx()[4]).to.be.within(100, 155); // still half way down
    advance(2);
    expect(dmx()[4]).to.equal(0);
  });

  it("leaves out a look's own fading copy when strictBounds checks its relaunch, and keeps the copy", () => {
    const { show, dmx, advance } = setup();
    show.looks.put({ id: "r", name: "R", canvas: "mur", technique: { kind: "plat", color: "#ff0000" }, timing: { exitFade: 2 } });
    show.rules.put({ id: "max-red", name: "Max red", level: "show", target: { color: "red" }, max: 128, onViolation: "reject" });
    expect(show.strictBounds("r")).to.have.length(1); // not playing: its launch is bounded
    show.go("r");
    show.stop("r");
    advance(1); // 0.5 s into its fade-out: the copy still goes over the bound
    // go() would drop the fading copy, so the launch is bounded just the same
    expect(show.strictBounds("r")).to.have.length(1);
    advance(2); // 1.5 s into the 2 s fade-out; the live output is held at the bound (128) until it falls below
    expect(dmx()[3]).to.be.within(20, 60); // the copy is still fading, not dropped by the check
  });

  it("merges a fading look with the active ones by the highest in « highest » mode", () => {
    const { show, dmx, advance } = setup();
    show.saveSettings({ looksMerge: "highest" });
    show.looks.put({ id: "a", name: "A", canvas: "mur", technique: { kind: "plat", color: "#ff0000" }, timing: { exitFade: 2 } });
    show.looks.put({ id: "b", name: "B", canvas: "mur", technique: { kind: "plat", color: "#00ff00" } });
    show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
    show.go("a");
    show.go("b");
    advance(1); // 0.5 s into A's fade-out
    expect(dmx()[3]).to.be.within(1, 254); // A is still seen: the highest of the two wins per channel
    expect(dmx()[4]).to.equal(255);
    advance(4);
    expect([dmx()[3], dmx()[4]]).to.deep.equal([0, 255]); // only B is left
  });

  it("look.delete drops a look that is fading out", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-delete-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    const { runtime } = plugin;
    const canvas = runtime.venue.canvases.list()[0]!.id;
    await run("look.put", { look: { id: "fond", name: "Fond", canvas, technique: { kind: "plat", color: "#ff0000" }, timing: { exitFade: 30 } } });
    const lit = () => {
      const buffers = [new Uint8Array(512), new Uint8Array(512), new Uint8Array(512), new Uint8Array(512)];
      runtime.render(buffers);
      return Object.values(runtime.venue.displayColors(buffers)).some((cells) => cells.some((c) => c !== "#000000"));
    };
    await run("look.go", { id: "fond" });
    await run("look.stop", { id: "fond" });
    expect(lit()).to.equal(true); // fading out over 30 s: still on stage
    await run("look.delete", { id: "fond" });
    expect(lit()).to.equal(false);
  });

  it("uses palettes by reference", () => {
    const { show, dmx } = setup();
    show.palettes.put({ id: "chaud", name: "Chaud", colors: ["#ff8000", "#ffff00"] });
    show.looks.put({ id: "p", name: "Plat", canvas: "mur", palette: "chaud", technique: { kind: "plat", color: "#000000" } });
    show.go("p");
    expect([dmx()[3], dmx()[4]]).to.deep.equal([255, 128]);
    show.palettes.put({ id: "chaud", name: "Chaud", colors: ["#00ff00"] });
    expect([dmx()[3], dmx()[4]]).to.deep.equal([0, 255]);
  });

  it("releases the other looks of an exclusive group (idempotent go)", () => {
    const { show } = setup();
    show.looks.put({ id: "a", name: "A", canvas: "mur", technique: { kind: "plat", color: "#ff0000" } });
    show.looks.put({ id: "b", name: "B", canvas: "mur", technique: { kind: "plat", color: "#0000ff" } });
    show.groups.put({ id: "sections", name: "Sections", exclusive: true, members: { looks: ["a", "b"] } });
    show.go("a");
    expect(show.go("b").released).to.deep.equal(["a"]);
    expect(show.go("b")).to.deep.equal({ started: false, released: [] });
    expect(show.activeLooks()).to.deep.equal(["b"]);
  });

  it("multiplies masters like DCAs: Ambiance 50 % over LED bar public 80 % → 40 %", () => {
    const { show, dmx } = setup();
    show.groups.put({ id: "bar-public", name: "LED bar public", members: { fixtures: ["bar-l"] }, master: { level: 0.8 } });
    show.groups.put({ id: "bar-fond", name: "LED bar fond", members: { fixtures: ["bar-r"] }, master: { level: 1 } });
    show.groups.put({ id: "ambiance", name: "Ambiance", members: { groups: ["bar-public", "bar-fond"] }, master: { level: 0.5 } });
    const b = dmx();
    expect(b[0]).to.equal(Math.round(0.4 * 255)); // bar-l dimmer
    expect(b[15]).to.equal(Math.round(0.5 * 255)); // bar-r dimmer
  });

  it("keeps a DCA within its limits: clamped, or the whole travel scaled", () => {
    const clamp = { master: { level: 1, mute: false }, limits: { min: 0.2, max: 0.8, mode: "clamp" as const } };
    expect(dcaLevel(clamp)).to.equal(0.8);
    expect(dcaLevel({ ...clamp, master: { level: 0, mute: false } })).to.equal(0.2); // never below the floor
    expect(dcaLevel({ ...clamp, master: { level: 0.5, mute: false } })).to.equal(0.5);
    const scale = { ...clamp, limits: { ...clamp.limits, mode: "scale" as const } };
    expect(dcaLevel({ ...scale, master: { level: 0, mute: false } })).to.be.closeTo(0.2, 1e-9);
    expect(dcaLevel({ ...scale, master: { level: 0.5, mute: false } })).to.be.closeTo(0.5, 1e-9);
    expect(dcaLevel({ ...scale, master: { level: 1, mute: false } })).to.be.closeTo(0.8, 1e-9);
    expect(dcaLevel({ ...clamp, master: { level: 1, mute: true } })).to.equal(0); // mute still means dark
    expect(dcaLevel(clamp, true)).to.equal(0.8); // a flash goes to the max, never beyond
    expect(() => GroupSchema.parse({ id: "g", name: "G", limits: { min: 0.9, max: 0.1 } })).to.throw(/min au-dessus du max/);
  });

  it("applies mute, flash and limits", () => {
    const { show, dmx } = setup();
    show.groups.put({ id: "g", name: "G", members: { fixtures: ["bar-l"] }, master: { level: 1, mute: true } });
    expect(dmx()[0]).to.equal(0);
    show.setFlash("g", true);
    expect(dmx()[0]).to.equal(255);
    show.setFlash("g", false);
    show.groups.put({ id: "g", name: "G", members: { fixtures: ["bar-l"] }, master: { level: 1 }, limits: { max: 0.7 } });
    expect(dmx()[0]).to.equal(Math.round(0.7 * 255));
  });

  it("selects members dynamically by role", () => {
    const { show, dmx } = setup();
    show.groups.put({ id: "public", name: "Public", selector: { role: "wash-public" }, master: { level: 0.5 } });
    expect(dmx()[0]).to.equal(128);
    expect(dmx()[15]).to.equal(255);
  });

  it("doses included presets with the master and keeps excluded fixtures out", () => {
    const { show, dmx } = setup();
    show.looks.put({ id: "fx", name: "FX", canvas: "mur", technique: { kind: "plat", color: "#ff0000" } });
    show.groups.put({ id: "dose", name: "Dose FX", master: { level: 0.5 }, presets: { included: ["fx"] } });
    show.groups.put({ id: "face", name: "Face", members: { fixtures: ["bar-r"] }, presets: { excluded: ["fx"] } });
    show.go("fx");
    const b = dmx();
    expect(b[3]).to.equal(128); // bar-l red at 50 %
    expect(b[15 + 3]).to.equal(0); // bar-r untouched by fx
  });
});

describe("a look's raw channels ride its fade (T3)", () => {
  // bar-l sits at address 1: offset 0 = Dimmer, 1 = Strobe, 2 = Program (mode), 3 = R1, and head 0 reads at 3..5.
  const sceneLook = (id: string, timing: object, targets: { fixture: string; offset: number }[], steps: number[][], technique: object = { kind: "aucune" }) => ({
    id,
    name: id,
    canvas: "mur",
    technique,
    timing,
    channels: { targets, steps },
  });

  it("fades its raw channels in like its colours: a colour dosed once, the dimmer from what the show held, the mode channel held", () => {
    const { show, dmx, advance } = setup();
    show.looks.put(sceneLook("scene", { entryFade: 2 }, [{ fixture: "bar-l", offset: 0 }, { fixture: "bar-l", offset: 2 }, { fixture: "bar-l", offset: 3 }], [[255, 200, 128]]));
    show.go("scene");
    let b = dmx();
    expect([b[0], b[2], b[3]]).to.deep.equal([255, 200, 0]); // weight 0: R1 from black, the dimmer at what the show held, the Program channel set all the same
    advance(2); // 1 s of the 2 s entry: the weight is ease(0.5) = 0.5
    b = dmx();
    expect(b[2]).to.equal(200); // a machine channel holds verbatim: never faded
    expect(b[3]).to.equal(64); // 128 × 0.5
    expect(b[0]).to.equal(255); // from the held 255 to its own 255: the light fades once, by R1, not twice
    advance(2);
    b = dmx();
    expect([b[0], b[2], b[3]]).to.deep.equal([255, 200, 128]); // fully in
  });

  it("fades its raw channels out on stop, holds the mode channel, and drops everything when the fade expires", () => {
    const { show, dmx, advance } = setup();
    show.looks.put(sceneLook("scene", { exitFade: 2 }, [{ fixture: "bar-l", offset: 0 }, { fixture: "bar-l", offset: 2 }, { fixture: "bar-l", offset: 3 }], [[255, 200, 128]]));
    show.go("scene");
    advance(4); // established: fully in
    expect([dmx()[0], dmx()[2], dmx()[3]]).to.deep.equal([255, 200, 128]);
    show.stop("scene");
    expect([dmx()[0], dmx()[2], dmx()[3]]).to.deep.equal([255, 200, 128]); // the fade starts from where the look is
    advance(2); // 1 s of the 2 s fade: weight 0.5, the mirror of the entry
    let b = dmx();
    expect(b[2]).to.equal(200); // the machine channel holds during the whole descent
    expect(b[3]).to.equal(64);
    expect(b[0]).to.equal(255); // its 255 back to the held 255
    advance(4); // past the end: the copy is let go
    b = dmx();
    expect([b[0], b[2], b[3]]).to.deep.equal([255, 0, 0]); // the raws are gone; the dimmer rests at the byte the show holds it at
  });

  it("fades the fixture's dimmer with the weight of a look that only drives a machine channel (the fade reaches the intensity byte)", () => {
    const { show, dmx, advance } = setup();
    show.looks.put(sceneLook("machine", { exitFade: 2 }, [{ fixture: "bar-l", offset: 2 }], [[200]]));
    show.go("machine");
    advance(4);
    expect([dmx()[2], dmx()[0]]).to.deep.equal([200, 255]); // the look owns nothing but the mode channel; the dimmer rides at its held level
    show.stop("machine");
    advance(2); // 1 s of the 2 s fade
    const b = dmx();
    expect(b[2]).to.equal(200); // the channel holds: a machine never fades
    expect(b[0]).to.equal(128); // intensity × the look's weight, once
    advance(4);
    expect(dmx()[0]).to.equal(255); // and the fade leaves nothing behind
  });

  it("crosses two looks' raw channels like a cell's colours: the doses add up, no dip and no jump", () => {
    const { show, dmx, advance } = setup();
    show.looks.put(sceneLook("a", { exitFade: 2 }, [{ fixture: "bar-l", offset: 0 }, { fixture: "bar-l", offset: 3 }], [[255, 255]]));
    show.looks.put(sceneLook("b", { entryFade: 4 }, [{ fixture: "bar-l", offset: 0 }, { fixture: "bar-l", offset: 3 }], [[100, 20]]));
    show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
    show.go("a");
    advance(4);
    expect([dmx()[0], dmx()[3]]).to.deep.equal([255, 255]);
    show.go("b"); // B comes in through a crossfade; A leaves under it over its own 2 s exit fade
    advance(2); // 1 s in: A at 0.5, B at ease(0.25) = 0.15625 — the weights sum under 1, so the doses add up
    const b = dmx();
    expect(b[0]).to.equal(231); // 255 × 0.5 + 100 × 0.15625, plus the held 255 × the 0.34375 left
    expect(b[3]).to.equal(131); // 255 × 0.5 + 20 × 0.15625 (nothing painted there: held 0)
    advance(8); // both fades over: B alone at full
    expect([dmx()[0], dmx()[3]]).to.deep.equal([100, 20]);
  });

  for (const [from, to] of [
    [255, 200],
    [255, 255],
  ] as const) {
    it(`crosses a raw dimmer from ${from} to ${to} over equal fades without dipping or jumping`, () => {
      const { show, dmx, advance } = setup();
      show.looks.put(sceneLook("a", { exitFade: 2 }, [{ fixture: "bar-l", offset: 0 }], [[from]]));
      show.looks.put(sceneLook("b", { entryFade: 2 }, [{ fixture: "bar-l", offset: 0 }], [[to]]));
      show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
      show.go("a");
      advance(4);
      show.go("b");
      const levels: number[] = [];
      for (let i = 0; i <= 24; i++) {
        levels.push(dmx()[0]!);
        advance(0.2); // every 100 ms, past the end of both fades
      }
      for (const [i, v] of levels.entries()) {
        expect(v, `at ${i * 100} ms`).to.be.within(to, from); // a straight crossfade: never under the lower value
        if (i > 0) expect(Math.abs(v - levels[i - 1]!), `step at ${i * 100} ms`).to.be.at.most(10);
      }
      expect(levels.at(-1)).to.equal(to);
    });
  }

  it("doses the dimmer once per machine look, however many machine channels it holds", () => {
    const sample = (offsets: number[]) => {
      const { show, dmx, advance } = setup();
      show.looks.put(sceneLook("machine", { entryFade: 2 }, offsets.map((offset) => ({ fixture: "bar-l", offset })), [offsets.map(() => 200)]));
      show.go("machine");
      const levels: number[] = [];
      for (let i = 0; i <= 5; i++) {
        levels.push(dmx()[0]!);
        advance(1);
      }
      return levels;
    };
    expect(sample([1, 2])).to.deep.equal(sample([2])); // two machine channels: the same fade as one, not twice as fast
  });

  it("hands the dimmer from a painting look fading out to a machine look fading in, without a jump", () => {
    const { show, dmx, advance } = setup();
    show.looks.put({ id: "paint", name: "Paint", canvas: "mur", technique: { kind: "plat", color: "#ffffff" }, timing: { exitFade: 1 } });
    show.looks.put(sceneLook("machine", { entryFade: 6 }, [{ fixture: "bar-l", offset: 2 }], [[200]]));
    show.go("paint");
    advance(4);
    show.go("machine");
    advance(4); // 2 s into its 6 s entry
    show.stop("paint");
    const levels: number[] = [];
    for (let i = 0; i <= 30; i++) {
      levels.push(dmx()[0]!);
      advance(0.2);
    }
    // the paint's 1 s exit at most: smoothstep's steepest slope (1.5 / s) over the whole travel, per 100 ms — not the half drop in one frame there was
    for (let i = 1; i < levels.length; i++) expect(Math.abs(levels[i]! - levels[i - 1]!), `step at ${i * 100} ms: ${levels.join(",")}`).to.be.at.most(39);
    expect(levels.at(-1)).to.be.above(levels[10]!); // then it rises with the machine look's entry
  });

  it("keeps a look that writes its own colours at full dimmer while it also holds a machine channel", () => {
    const { show, dmx, advance } = setup();
    show.looks.put(sceneLook("scene", { entryFade: 2 }, [{ fixture: "bar-l", offset: 2 }, { fixture: "bar-l", offset: 3 }], [[200, 255]]));
    show.go("scene");
    advance(2); // half way in
    const b = dmx();
    expect(b[3]).to.equal(128); // its raw red rides its weight, once
    expect(b[0]).to.equal(255); // and the dimmer does not dose it a second time
  });

  it("keeps a crossfade straight when an unrelated look writes 0 on the same channel", () => {
    const { show, dmx, advance } = setup();
    show.looks.put(sceneLook("a", { exitFade: 2 }, [{ fixture: "bar-l", offset: 0 }], [[255]]));
    show.looks.put(sceneLook("b", { entryFade: 2 }, [{ fixture: "bar-l", offset: 0 }], [[200]]));
    show.looks.put(sceneLook("c", {}, [{ fixture: "bar-l", offset: 0 }], [[0]]));
    show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
    show.go("c");
    show.go("a");
    advance(4);
    show.go("b");
    const levels: number[] = [];
    for (let i = 0; i <= 24; i++) {
      levels.push(dmx()[0]!);
      advance(0.2);
    }
    for (const v of levels) expect(v, levels.join(",")).to.be.within(200, 255); // C does not cross them: the highest sheet wins
    expect(levels.at(-1)).to.equal(200);
  });

  it("names a look still fading out among the raw writers dmx.explain lists", () => {
    const { show, advance } = setup();
    show.looks.put(sceneLook("scene", { exitFade: 2 }, [{ fixture: "bar-l", offset: 0 }], [[255]]));
    show.go("scene");
    advance(4);
    expect(show.explainChannel(1, 1).rawLooks).to.deep.equal([{ id: "scene", name: "scene" }]);
    show.stop("scene");
    advance(1);
    expect(show.explainChannel(1, 1).rawLooks).to.deep.equal([{ id: "scene", name: "scene", leaving: true }]); // not active, still writing
  });

  it("rises its raw colour on the entry's ease through an entry fade longer than a second", () => {
    const { show, dmx, advance } = setup();
    show.looks.put(sceneLook("scene", { entryFade: 4 }, [{ fixture: "bar-l", offset: 3 }], [[255]]));
    show.go("scene");
    const smooth = (t: number) => t * t * (3 - 2 * t);
    for (let i = 0; i <= 8; i++) {
      expect(dmx()[3], `at ${i / 2} s`).to.be.closeTo(255 * smooth(i / 8), 1); // the whole 4 s ease, not stalled at 1 s
      advance(1); // every 500 ms
    }
  });

  it("crosses a raw dimmer from the level the show held to its own, both ways, never through black", () => {
    const { show, dmx, advance } = setup();
    show.looks.put({ id: "colour", name: "Colour", canvas: "mur", technique: { kind: "plat", color: "#ffffff" } });
    show.looks.put(sceneLook("dim", { entryFade: 2, exitFade: 2 }, [{ fixture: "bar-l", offset: 0 }], [[180]]));
    show.go("colour");
    advance(4);
    show.go("dim");
    const levels: number[] = [];
    for (let i = 0; i <= 50; i++) {
      if (i === 25) show.stop("dim"); // at 2.5 s, in; its 2 s exit is over at 4.5 s
      levels.push(dmx()[0]!);
      advance(0.2); // every 100 ms
    }
    for (const v of levels) expect(v, levels.join(",")).to.be.within(179, 255); // between the held 255 and its 180, never 0
    for (let i = 1; i < levels.length; i++) expect(Math.abs(levels[i]! - levels[i - 1]!), levels.join(",")).to.be.at.most(12);
    expect(levels.at(-1)).to.equal(255); // gone: the held level again
  });

  it("fades a scene that lights a fixture by its raw dimmer and a mode channel alone, from black and back", () => {
    const { show, dmx, advance } = setup();
    show.looks.put(sceneLook("scene", { entryFade: 2, exitFade: 2 }, [{ fixture: "bar-l", offset: 0 }, { fixture: "bar-l", offset: 2 }], [[255, 200]]));
    show.go("scene");
    const rise: number[] = [];
    for (let i = 0; i <= 20; i++) {
      rise.push(dmx()[0]!);
      advance(0.2);
    }
    expect(rise[0], rise.join(",")).to.equal(0); // nothing else lights it: its dimmer is its light, from black
    for (let i = 1; i < rise.length; i++) expect(rise[i]!, rise.join(",")).to.be.at.least(rise[i - 1]!);
    expect(rise.at(-1)).to.equal(255);
    show.stop("scene");
    advance(2); // 1 s of its 2 s exit
    expect(dmx()[0]).to.equal(128);
    expect(dmx()[2]).to.equal(200); // the mode channel holds all the way
  });

  it("keeps two unrelated looks on the same raw dimmer at the highest of them, without a hole", () => {
    const sample = (second: number, delay: number) => {
      const { show, dmx, advance } = setup();
      show.looks.put({ id: "colour", name: "Colour", canvas: "mur", technique: { kind: "plat", color: "#ffffff" } });
      show.looks.put(sceneLook("a", { entryFade: 2 }, [{ fixture: "bar-l", offset: 0 }], [[200]]));
      show.looks.put(sceneLook("b", { entryFade: 2 }, [{ fixture: "bar-l", offset: 0 }], [[second]]));
      show.go("colour");
      advance(4);
      show.go("a");
      const levels: number[] = [];
      for (let i = 0; i <= 40; i++) {
        if (i === delay) show.go("b");
        levels.push(dmx()[0]!);
        advance(0.2);
      }
      return levels;
    };
    const together = sample(200, 0); // both to 200, launched together: they do not cross, the highest sheet holds
    for (let i = 1; i < together.length; i++) expect(together[i]!, together.join(",")).to.be.at.most(together[i - 1]!);
    expect(together.at(-1)).to.equal(200);
    const staggered = sample(100, 5); // the lower one 500 ms later: still from the held 255 down to 200, never back up
    for (let i = 1; i < staggered.length; i++) expect(staggered[i]!, staggered.join(",")).to.be.at.most(staggered[i - 1]!);
    expect(staggered.at(-1)).to.equal(200);
  });

  it("doses a raw dimmer once on twin fixtures patched on the same addresses", () => {
    const targets = (twin: boolean, offset: number) => (twin ? ["bar-l", "bar-twin"] : ["bar-l"]).map((fixture) => ({ fixture, offset }));
    const sample = (twin: boolean) => {
      const { venue, show, dmx, advance } = setup();
      if (twin) venue.fixtures.put({ id: "bar-twin", name: "Barre jumelle", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1 });
      show.looks.put(sceneLook("lit", {}, targets(twin, 3), [targets(twin, 3).map(() => 255)])); // each lit by a raw red at full: the dimmer is held up
      show.looks.put(sceneLook("dim", { entryFade: 2 }, targets(twin, 0), [targets(twin, 0).map(() => 100)]));
      show.go("lit");
      advance(4);
      show.go("dim");
      const levels: number[] = [];
      for (let i = 0; i <= 20; i++) {
        levels.push(dmx()[0]!);
        advance(0.2);
      }
      return levels;
    };
    expect(sample(true)).to.deep.equal(sample(false)); // the twin reads what the show held, not its neighbour's dose
  });

  it("keeps the dimmer of a look that paints a fixture and holds its mode channel: dosed once, by its colours", () => {
    const { show, dmx, advance } = setup();
    show.looks.put(sceneLook("scene", { entryFade: 2, exitFade: 2 }, [{ fixture: "bar-l", offset: 2 }], [[200]], { kind: "plat", color: "#ffffff" }));
    show.go("scene");
    const levels: number[] = [];
    for (let i = 0; i <= 25; i++) {
      if (i === 15) show.stop("scene");
      levels.push(dmx()[0]!);
      advance(0.2);
    }
    expect(levels.every((v) => v === 255), levels.join(",")).to.equal(true);
  });

  for (const [what, paint, machine, stopAt] of [
    ["a machine look comes in while a painted look is still rising", { entryFade: 4 }, { entryFade: 2 }, undefined],
    ["a machine look ends while a painted look is still fading out", { exitFade: 3 }, { exitFade: 1 }, 0],
  ] as const) {
    it(`moves the dimmer without a jump when ${what}`, () => {
      const { show, dmx, advance } = setup();
      show.looks.put({ id: "paint", name: "Paint", canvas: "mur", technique: { kind: "plat", color: "#ffffff" }, timing: paint });
      show.looks.put(sceneLook("machine", machine, [{ fixture: "bar-l", offset: 2 }], [[200]]));
      show.go("paint");
      if (stopAt === undefined) advance(4); // 2 s into the paint's 4 s entry
      else {
        show.go("machine");
        advance(8);
      }
      if (stopAt === undefined) show.go("machine");
      else {
        show.stop("paint");
        show.stop("machine"); // both buttons let go together
      }
      const levels: number[] = [];
      for (let i = 0; i <= 40; i++) {
        levels.push(dmx()[0]!);
        advance(0.2);
      }
      for (let i = 1; i < levels.length; i++) expect(Math.abs(levels[i]! - levels[i - 1]!), `step at ${i * 100} ms: ${levels.join(",")}`).to.be.at.most(20);
    });
  }

  it("resumes a look's raw colour from where it was when relaunched mid-rise", () => {
    const { show, dmx, advance } = setup();
    show.looks.put(sceneLook("scene", { entryFade: 4, exitFade: 4 }, [{ fixture: "bar-l", offset: 3 }], [[255]]));
    show.go("scene");
    const levels: number[] = [];
    for (let i = 0; i <= 30; i++) {
      if (i === 10) show.stop("scene"); // at 1 s, mid-rise
      if (i === 15) show.go("scene"); // relaunched at 1.5 s, while it fades out
      levels.push(dmx()[3]!);
      advance(0.2);
    }
    for (let i = 1; i < levels.length; i++) expect(Math.abs(levels[i]! - levels[i - 1]!), `step at ${i * 100} ms: ${levels.join(",")}`).to.be.at.most(20);
  });

  it("leaves the dimmer of a fixture another look paints alone while a machine-only look fades in and out", () => {
    const { show, dmx, advance } = setup();
    show.looks.put({ id: "colour", name: "Colour", canvas: "mur", technique: { kind: "plat", color: "#ffffff" } });
    show.looks.put(sceneLook("machine", { entryFade: 2, exitFade: 2 }, [{ fixture: "bar-l", offset: 2 }], [[200]]));
    show.go("colour");
    advance(4);
    expect(dmx()[0]).to.equal(255);
    show.go("machine");
    const levels: number[] = [];
    for (let i = 0; i < 10; i++) {
      levels.push(dmx()[0]!);
      advance(1);
    }
    show.stop("machine");
    for (let i = 0; i < 10; i++) {
      levels.push(dmx()[0]!);
      advance(1);
    }
    expect(levels.every((v) => v === 255), levels.join(",")).to.equal(true); // the colours dose this fixture: the machine weight does not reach its dimmer
    expect(dmx()[2]).to.equal(0); // and the machine channel is gone with its look
  });

  it("plays on untouched when a playing look is only renamed, filed in a folder or annotated", () => {
    const { show, dmx, advance } = setup();
    const look = sceneLook("scene", { entryFade: 2 }, [{ fixture: "bar-l", offset: 0 }], [[255]], { kind: "plat", color: "#ffffff" });
    show.looks.put(look);
    show.go("scene");
    advance(4);
    expect([dmx()[0], dmx()[3]]).to.deep.equal([255, 255]);
    show.looks.put({ ...look, name: "Scène", tags: ["dossier:Rangés"], notes: "rangé" });
    expect([dmx()[0], dmx()[3]]).to.deep.equal([255, 255]); // no fade-in replayed from black
    advance(1);
    expect([dmx()[0], dmx()[3]]).to.deep.equal([255, 255]);
    show.looks.put({ ...look, channels: { targets: [{ fixture: "bar-l", offset: 0 }], steps: [[200]] } }); // what it plays changed: it restarts
    expect(dmx()[3]).to.be.below(255); // its colour rises again from its entry
  });

  it("fades nothing on a fixture with machine channels only: the channels hold their value to the end", () => {
    const { venue, show, dmx, advance } = setup();
    venue.fixtures.put({ id: "machine", name: "Machine", manufacturer: "Test", model: "Machine 1", mode: "1 Channel", universe: 1, address: 33 });
    show.looks.put(sceneLook("machine", { exitFade: 2 }, [{ fixture: "machine", offset: 0 }], [[200]]));
    show.go("machine");
    advance(4);
    expect(dmx()[32]).to.equal(200);
    show.stop("machine");
    advance(2); // 1 s of the 2 s fade: no dimmer to dose, nothing to fade
    expect(dmx()[32]).to.equal(200);
    advance(4);
    expect(dmx()[32]).to.equal(0); // gone with the look, as it must
  });

  it("composes the exit fade with an entry still running on its raws, like its colours", () => {
    const { show, dmx, advance } = setup();
    show.looks.put(sceneLook("scene", { entryFade: 2, exitFade: 2 }, [{ fixture: "bar-l", offset: 3 }], [[255]]));
    show.go("scene");
    advance(2); // 1 s: mid-entry, weight 0.5
    expect(dmx()[3]).to.equal(128);
    show.stop("scene"); // stopped mid-entry, with an exit fade: the entry keeps its course inside it
    advance(1); // 1.5 s: entry ease(0.75) × exit 1 − ease(0.25)
    expect(dmx()[3]).to.equal(Math.round(255 * 0.84375 * 0.84375));
    advance(1); // 2 s: the entry is done, the exit half way
    expect(dmx()[3]).to.equal(128);
    advance(2); // 3 s: the fade is over
    expect(dmx()[3]).to.equal(0); // everything dropped
  });

  it("cuts a fading look's raw channels at once with stopAll, and leaves no state behind", () => {
    const { show, dmx, advance } = setup();
    show.looks.put(sceneLook("scene", { exitFade: 2 }, [{ fixture: "bar-l", offset: 0 }, { fixture: "bar-l", offset: 2 }, { fixture: "bar-l", offset: 3 }], [[255, 200, 128]]));
    show.go("scene");
    advance(4);
    show.stop("scene");
    advance(2); // half way through the fade
    expect(dmx()[3]).to.equal(64);
    show.stopAll(); // the Panic's path: nothing fades out
    const b = dmx();
    expect([b[0], b[2], b[3]]).to.deep.equal([255, 0, 0]); // no intermediate state left behind
  });

  it("fades a coloured look exactly as before, its raw channels on the same ramp", () => {
    const { show, dmx, advance } = setup();
    show.looks.put(sceneLook("scene", { entryFade: 2, exitFade: 2 }, [{ fixture: "bar-l", offset: 0 }], [[255]], { kind: "plat", color: "#ffffff" }));
    show.go("scene");
    expect([dmx()[0], dmx()[3]]).to.deep.equal([255, 0]); // the colour from black; its raw dimmer 255 over the held 255
    advance(2); // 1 s of the 2 s entry
    let b = dmx();
    expect(b[3]).to.be.within(100, 155); // the head colour, at the same mid-point as ever
    expect(b[0]).to.equal(255); // one dose, by the colour: the dimmer does not fade it a second time
    advance(2);
    expect([dmx()[0], dmx()[3]]).to.deep.equal([255, 255]);
    show.stop("scene");
    advance(2); // 1 s of the exit
    b = dmx();
    expect(b[3]).to.be.within(100, 155);
    expect(b[0]).to.equal(255);
    advance(4);
    b = dmx();
    expect([b[0], b[3]]).to.deep.equal([255, 0]); // colours at rest; the dimmer at the byte the show holds it at
  });
});

describe("dashboards", () => {
  it("generates a default dashboard from the show", async () => {
    const { defaultDashboard } = await import("../../../src/plugins/light/dashboards/dashboards.js");
    const looks = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ] as never[];
    const groups = [
      { id: "sec", name: "Sections", exclusive: true, members: { looks: ["a", "b"], fixtures: [], groups: [] } },
      { id: "amb", name: "Ambiance", exclusive: false, master: { level: 1, mute: false }, members: { looks: [], fixtures: [], groups: [] } },
    ] as never[];
    const d = defaultDashboard(looks, groups);
    expect(d.widgets.filter((w) => w.kind === "look").map((w) => w.target)).to.deep.equal(["a", "b", "c"]);
    expect(d.widgets.filter((w) => w.kind === "label").map((w) => w.label)).to.deep.equal(["Sections", "Looks"]);
    expect(d.widgets.find((w) => w.kind === "group-fader")!.target).to.equal("amb");
    expect(d.widgets.some((w) => w.kind === "panic")).to.equal(true);
  });
});
