import { expect } from "chai";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { Venue } from "../../../src/plugins/light/venue/venue.js";
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

  it("restarts a look that is fading out, from scratch", () => {
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
    /** A red look A playing, then B (colour `b`) started over it; A and B in one exclusive group. */
    function pair(opts: { a?: object; b?: object; bColor?: string; aColor?: string } = {}) {
      const t = setup();
      t.show.looks.put({ id: "a", name: "A", canvas: "mur", technique: { kind: "plat", color: opts.aColor ?? "#ff0000" }, timing: { ...opts.a } });
      t.show.looks.put({ id: "b", name: "B", canvas: "mur", technique: { kind: "plat", color: opts.bColor ?? "#00ff00" }, timing: { ...opts.b } });
      t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
      t.show.go("a");
      t.show.go("b");
      return t;
    }
    const rg = (b: Uint8Array) => [b[3]!, b[4]!];

    it("is the weighted mix of both while B comes in and A goes, then B alone", () => {
      const { dmx, advance } = pair({ b: { entryFade: 2 } }); // A has no exit fade: it follows B's entry
      expect(rg(dmx())).to.deep.equal([255, 0]); // nothing of B yet, and A did not drop out
      advance(2); // 1 s of 2: both at half
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
      advance(3); // 1.5 s: A is gone, B is at half
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

    it("starting A again during the crossfade starts it fresh and ends the one under B", () => {
      const { show, dmx, advance } = pair({ b: { entryFade: 2 } });
      advance(1);
      show.go("a"); // B is released by A (same group), A starts over from black... a plain start: no entry fade for A
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

    it("is not changed by strictBounds, which samples the future", () => {
      const { show, dmx, advance } = pair({ b: { entryFade: 2 } });
      advance(1);
      const before = rg(dmx());
      show.strictBounds("b");
      show.strictBounds("a");
      expect(rg(dmx())).to.deep.equal(before);
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
