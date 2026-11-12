import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { Venue, type ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";
import { ShowRuntime } from "../../../src/plugins/light/show/runtime.js";
import { modelKey } from "../../../src/plugins/light/venue/overrides.js";

/**
 * Fadeable tracks in the engine (T5, docs/specs/engine-effects-timing.md, « Pistes fondables »). Two bars bar4 (0
 * Dimmer, 1 Strobe, 2 Program — a mode channel —, 3.. four RGB heads), a 16-bit spot and a lamp with a wheel. Time:
 * one beat = 500 ms; samples every 20 ms.
 */
function setup(opts: { tracks?: { fade: string[] }; on?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "light-tracks-show-"));
  const defs = join(dir, "fixtures");
  mkdirSync(defs);
  for (const f of ["bar4.qxf", "spot.qxf", "wheel-spot.qxf"]) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(defs, f));
  const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
  const on = new Set(opts.on ?? ["bar-l"]);
  const overrides = (id: string) => (opts.tracks && on.has(id) ? { overrides: { tracks: { enabled: true, fade: opts.tracks.fade } } } : {});
  venue.fixtures.put({ id: "bar-l", name: "Bar L", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1, ...overrides("bar-l") });
  venue.fixtures.put({ id: "bar-r", name: "Bar R", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 16, ...overrides("bar-r") });
  venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 100, ...overrides("spot") });
  venue.fixtures.put({ id: "lamp", name: "Lamp", manufacturer: "Test", model: "Wheel Spot", mode: "Standard", universe: 1, address: 200, ...overrides("lamp") });
  venue.canvases.put({ id: "mur", name: "Mur", topology: "line", cells: 8, render: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ from: i, to: i, targets: [{ fixture: i < 4 ? "bar-l" : "bar-r", head: i % 4 }] })) });
  venue.canvases.put({ id: "both", name: "Both", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "bar-l" }, { fixture: "bar-r" }] }] });
  venue.canvases.put({ id: "spot", name: "Spot", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "spot" }] }] });
  venue.canvases.put({ id: "lamp", name: "Lamp", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "lamp" }] }] });
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
type Setup = ReturnType<typeof setup>;
const LIGHT = ["Dimmer", "R1", "G1", "B1", "R2", "G2", "B2", "R3", "G3", "B3", "R4", "G4", "B4"];
/** A look painting `color` on `canvas`, with raw channels `raw` (offset → value) on bar-l. */
const look = (id: string, color: string | undefined, timing: object, raw: [number, number][] = [], canvas = "mur") => ({
  id,
  name: id,
  canvas,
  technique: color ? { kind: "plat" as const, color } : { kind: "aucune" as const },
  timing,
  ...(raw.length ? { channels: { targets: raw.map(([offset]) => ({ fixture: "bar-l", offset })), steps: [raw.map(([, v]) => v)] } } : {}),
});
/** Samples `channels` every 20 ms over `ms`, running `at(i)` before sample i. */
function sample(t: Setup, ms: number, channels: number[], at?: (i: number) => void): number[][] {
  const out: number[][] = [];
  for (let i = 0; i * 20 <= ms; i++) {
    at?.(i);
    const b = t.dmx();
    out.push(channels.map((c) => b[c]!));
    t.advance(0.04);
  }
  return out;
}
/** The largest change of each channel from one sample to the next. */
const steepest = (rows: number[][]) => rows[0]!.map((_, c) => Math.max(...rows.slice(1).map((r, i) => Math.abs(r[c]! - rows[i]![c]!))));
/** The bound of plan T5 S0: per 20 ms, ⌈Σ 1.5 × 0.02 / T × 255⌉ + 1 DMX steps for the fades `T` (s) running together. */
const bound = (...fades: number[]) => Math.ceil(fades.reduce((s, T) => s + (1.5 * 0.02 * 255) / T, 0)) + 1;

describe("fadeable tracks in the engine (T5)", () => {
  it("resolves the list from the model, overridden by the fixture, only where the fixture enables it", () => {
    const t = setup();
    const r = () => t.venue.resolve("bar-l") as ResolvedFixture;
    t.venue.models.put({ id: modelKey("Test", "Bar 4"), manufacturer: "Test", model: "Bar 4", overrides: { tracks: { enabled: true, fade: ["Dimmer"] } } });
    expect(r().tracks).to.equal(undefined); // a model's `enabled` is ignored: the fixture enables
    t.venue.fixtures.put({ ...t.venue.fixtures.get("bar-l")!, overrides: { tracks: { enabled: true } } });
    expect([...r().tracks!.fade]).to.deep.equal([0]); // the model's list
    t.venue.fixtures.put({ ...t.venue.fixtures.get("bar-l")!, overrides: { tracks: { enabled: true, fade: ["R1"] } } });
    expect([...r().tracks!.fade]).to.deep.equal([3]); // the fixture's own list wins
    expect((t.venue.resolve("bar-r") as ResolvedFixture).tracks).to.equal(undefined); // not enabled there
  });

  it("leaves a fixture without tracks byte for byte as before, even in a cell it shares with one that has them", () => {
    const run = (tracks?: { fade: string[] }) => {
      const t = setup(tracks ? { tracks } : {});
      t.show.looks.put(look("a", "#ff0000", { exitFade: 1 }, [], "both"));
      t.show.looks.put(look("b", "#0000ff", { entryFade: 2 }, [], "mur"));
      t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
      t.show.go("a");
      t.advance(2);
      return sample(t, 3000, [15, 16, 17, 18, 19, 20, 21, 22], (i) => i === 0 && t.show.go("b"));
    };
    expect(run({ fade: LIGHT })).to.deep.equal(run());
  });

  it("doses a painted look once: at mid-entry the light is its weight, not its square", () => {
    const t = setup({ tracks: { fade: LIGHT } });
    t.show.looks.put(look("a", "#ff0000", { entryFade: 2 }));
    t.show.go("a");
    t.advance(2); // 1 s of 2: weight 0.5
    const b = t.dmx();
    expect(b[0]).to.be.within(126, 129); // the dimmer carries the fade
    expect(b[3]).to.equal(255); // the colour stays at full
    t.advance(4);
    expect([t.dmx()[0], t.dmx()[3]]).to.deep.equal([255, 255]);
  });

  it("switches a jumping channel once, at mid-fade, while the ticked ones cross without a jump", () => {
    const t = setup({ tracks: { fade: LIGHT } });
    t.show.looks.put(look("a", "#ff0000", {}, [[2, 0]]));
    t.show.looks.put(look("b", "#0000ff", { entryFade: 2 }, [[2, 200]]));
    t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
    t.show.go("a");
    t.advance(2);
    const rows = sample(t, 2500, [0, 2, 3, 5], (i) => i === 0 && t.show.go("b"));
    const program = rows.map((r) => r[1]!);
    const switched = program.findIndex((v) => v === 200);
    expect(program.slice(switched).every((v) => v === 200), "a single switch").to.equal(true);
    expect(switched * 20).to.be.within(960, 1040); // at mid-fade (1 s of 2)
    const [dimmer, , red, blue] = steepest(rows);
    for (const s of [dimmer!, red!, blue!]) expect(s).to.be.at.most(bound(2, 2));
    expect(Math.min(...rows.map((r) => r[0]!))).to.be.at.least(250); // the dimmer never dips
  });

  it("jumps on every channel when nothing is ticked: at once on entry, at mid-fade in a crossfade, at the end on exit", () => {
    const t = setup({ tracks: { fade: [] } });
    t.show.looks.put(look("a", "#ff0000", { entryFade: 2, exitFade: 2 }));
    t.show.go("a");
    expect([t.dmx()[0], t.dmx()[3]]).to.deep.equal([255, 255]); // at once
    t.show.stop("a");
    t.advance(3.8); // 1.9 s of 2
    expect(t.dmx()[3]).to.equal(255); // held to the end
    t.advance(0.4);
    expect(t.dmx()[3]).to.equal(0);
  });

  it("starts a machine look and a painted look together without the dimmer jumping (L1 is gone with tracks)", () => {
    const measure = (tracks?: { fade: string[] }) => {
      const t = setup(tracks ? { tracks } : {});
      t.show.looks.put(look("m", undefined, { entryFade: 2 }, [[2, 200]])); // a mode channel only: a machine look
      t.show.looks.put(look("p", "#ff0000", { entryFade: 2 }));
      const rows = sample(t, 2500, [0, 3], (i) => {
        if (i === 0) {
          t.show.go("m");
          t.show.go("p");
        }
      });
      return steepest(rows)[0]!;
    };
    expect(measure(), "the known jump without tracks (machineFade at its origin)").to.be.greaterThan(60);
    expect(measure({ fade: LIGHT })).to.be.at.most(bound(2, 2));
  });

  it("keeps a DCA's level and a group's level of a look through the fades (T35)", () => {
    const t = setup({ tracks: { fade: LIGHT } });
    t.show.groups.put({ id: "dca", name: "DCA", members: { fixtures: ["bar-l"] }, master: { level: 0.5 } });
    t.show.looks.put(look("a", "#ff0000", { entryFade: 2 }));
    t.show.go("a");
    t.advance(2);
    expect(t.dmx()[0]).to.be.within(62, 66); // half of half
    t.advance(4);
    expect(t.dmx()[0]).to.be.within(127, 128);
    // a group including the look (not covering the fixture) doses it once, by its level, on its colours
    const u = setup({ tracks: { fade: LIGHT } });
    u.show.groups.put({ id: "dose", name: "Dose", master: { level: 0.5 }, presets: { included: ["a"] } });
    u.show.looks.put(look("a", "#ff0000", { entryFade: 2 }));
    u.show.go("a");
    u.advance(2);
    const mid = u.dmx();
    expect((mid[0]! * mid[3]!) / 255).to.be.within(62, 66); // half of half
    u.advance(4);
    const end = u.dmx();
    expect([end[0], end[3]]).to.deep.equal([255, 128]);
  });

  it("never touches pan/tilt, coarse or fine: the same bytes as a spot without tracks", () => {
    const run = (tracks?: { fade: string[] }) => {
      const t = setup(tracks ? { tracks, on: ["spot"] } : {});
      t.show.looks.put({ id: "a", name: "A", canvas: "spot", technique: { kind: "plat", color: "#ffffff" }, timing: { entryFade: 1 }, move: { shape: "fixe", center: { pan: 0.25, tilt: 0.75 } } });
      t.show.looks.put({ id: "b", name: "B", canvas: "spot", technique: { kind: "plat", color: "#ffffff" }, timing: { entryFade: 1 }, move: { shape: "fixe", center: { pan: 0.7, tilt: 0.3 } } });
      t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
      return sample(t, 2000, [99, 100, 101, 102], (i) => {
        if (i === 0) t.show.go("a");
        if (i === 40) t.show.go("b");
      });
    };
    const plain = run();
    expect(run({ fade: ["Pan", "Tilt", "Dimmer"] })).to.deep.equal(plain);
    expect(run({ fade: [] })).to.deep.equal(plain);
  });

  it("turns a lamp's wheel at mid-fade, or through black with « au noir »", () => {
    const run = (change?: "black") => {
      const t = setup({ tracks: { fade: ["Dimmer"] }, on: ["lamp"] });
      if (change) t.venue.fixtures.put({ ...t.venue.fixtures.get("lamp")!, overrides: { tracks: { enabled: true, fade: ["Dimmer"] }, wheel: { change } } });
      t.show.looks.put({ id: "a", name: "A", canvas: "lamp", technique: { kind: "plat", color: "#ff0000" } });
      t.show.looks.put({ id: "b", name: "B", canvas: "lamp", technique: { kind: "plat", color: "#0000ff" }, timing: { entryFade: 2 } });
      t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
      t.show.go("a");
      t.advance(2);
      return sample(t, 2500, [201, 202], (i) => i === 0 && t.show.go("b"));
    };
    const mid = run();
    const wheel = mid.map((r) => r[0]!);
    const at = wheel.findIndex((v) => v === 65); // blue's slot
    expect(wheel[0]).to.equal(15); // red's slot
    expect(at * 20).to.be.within(900, 1100);
    expect(Math.min(...mid.map((r) => r[1]!))).to.be.greaterThan(0); // never through black
    const black = run("black");
    expect(Math.min(...black.map((r) => r[1]!))).to.equal(0);
  });

  it("replays the same path when a launch checks the rules (strictBounds)", () => {
    const t = setup({ tracks: { fade: LIGHT } });
    t.show.rules.put({ id: "max-red", name: "Max red", level: "show", target: { color: "red" }, max: 200, onViolation: "reject" });
    t.show.looks.put(look("a", "#ff0000", {}));
    expect(t.show.strictBounds("a")).to.have.length(1);
  });

  it("switches a mode channel only one of two crossing looks writes at mid-fade, both ways", () => {
    for (const writer of ["a", "b"]) {
      const t = setup({ tracks: { fade: LIGHT } });
      t.show.looks.put(look("a", "#ff0000", {}, writer === "a" ? [[2, 200]] : []));
      t.show.looks.put(look("b", "#0000ff", { entryFade: 2 }, writer === "b" ? [[2, 200]] : []));
      t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
      t.show.go("a");
      t.advance(2);
      const program = sample(t, 2500, [2], (i) => i === 0 && t.show.go("b")).map((r) => r[0]!);
      const [from, to] = writer === "a" ? [200, 0] : [0, 200];
      const switched = program.findIndex((v) => v === to);
      expect(program[0], writer).to.equal(from);
      expect(program.slice(switched).every((v) => v === to), `${writer}: a single switch`).to.equal(true);
      expect(switched * 20, writer).to.be.within(960, 1040);
    }
  });

  it("keeps a group's level on its own look when two looks share the fixture, in both merges and both orders (T35)", () => {
    /** A paints heads 0-1 red and is in a group at `level`; B paints heads 2-3 green; the light of R1 and G3 once settled. */
    const settled = (opts: { tracks: boolean; merge: "last" | "highest"; aFirst: boolean; level: number }) => {
      const t = setup(opts.tracks ? { tracks: { fade: LIGHT } } : {});
      t.show.saveSettings({ looksMerge: opts.merge });
      const heads = (id: string, from: number) => t.venue.canvases.put({ id, name: id, topology: "line", cells: 2, render: [0, 1].map((i) => ({ from: i, to: i, targets: [{ fixture: "bar-l", head: from + i }] })) });
      heads("front", 0);
      heads("back", 2);
      t.show.looks.put(look("a", "#ff0000", {}, [], "front"));
      t.show.looks.put(look("b", "#00ff00", {}, [], "back"));
      t.show.groups.put({ id: "g", name: "G", master: { level: opts.level }, presets: { included: ["a"] } });
      for (const id of opts.aFirst ? ["a", "b"] : ["b", "a"]) t.show.go(id);
      t.advance(1);
      const b = t.dmx();
      return [b[0]! * b[3]!, b[0]! * b[10]!].map((v) => Math.round(v / 255));
    };
    for (const merge of ["last", "highest"] as const)
      for (const aFirst of [true, false])
        for (const level of [1, 0.5, 0.02, 0]) {
          const plain = settled({ tracks: false, merge, aFirst, level });
          expect(settled({ tracks: true, merge, aFirst, level }), `${merge}, ${aFirst ? "A then B" : "B then A"}, ${level}`).to.deep.equal(plain);
          expect(plain[1]).to.equal(255); // B is never dosed by A's group
        }
  });

  it("matches the fixture without tracks once the fades are over, for random looks, groups and merges", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    for (let round = 0; round < 40; round++) {
      const plan = {
        merge: pick(["last", "highest"] as const),
        looks: [0, 1, 2].map((i) => ({ id: `l${i}`, color: pick(["#ff0000", "#00ff00", "#ffffff", "#ff8000", "#0000ff"]), from: pick([0, 1, 2]), level: pick([1, 0.5, 0.25]) })),
        order: pick([[0, 1, 2], [2, 1, 0], [1, 0, 2]]),
      };
      const settled = (tracks: boolean) => {
        const t = setup(tracks ? { tracks: { fade: LIGHT } } : {});
        t.show.saveSettings({ looksMerge: plan.merge });
        for (const l of plan.looks) {
          t.venue.canvases.put({ id: `c-${l.id}`, name: l.id, topology: "line", cells: 2, render: [0, 1].map((i) => ({ from: i, to: i, targets: [{ fixture: "bar-l", head: l.from + i }] })) });
          t.show.looks.put(look(l.id, l.color, { entryFade: 1 }, [], `c-${l.id}`));
          if (l.level < 1) t.show.groups.put({ id: `g-${l.id}`, name: `G ${l.id}`, master: { level: l.level }, presets: { included: [l.id] } });
        }
        for (const k of plan.order) t.show.go(plan.looks[k]!.id);
        t.advance(4); // 2 s: every entry over
        const b = t.dmx();
        return [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((o) => Math.round((b[0]! * b[o]!) / 255));
      };
      const plain = settled(false);
      settled(true).forEach((v, i) => expect(Math.abs(v - plain[i]!), `round ${round} (${JSON.stringify(plan)}), channel ${i + 3}`).to.be.at.most(1));
    }
  });

  it("does not raise the dimmer over another look's raw dimmer with a look writing machine channels only", () => {
    const t = setup({ tracks: { fade: LIGHT } });
    t.show.looks.put(look("d", "#ff0000", {}, [[0, 60]]));
    t.show.looks.put(look("m", undefined, {}, [[2, 200]])); // a mode channel only, launched after
    t.show.go("d");
    t.show.go("m");
    const b = t.dmx();
    expect([b[0], b[2]]).to.deep.equal([60, 200]);
  });

  it("doses a colour a channel fader linked to the look's group holds once, as without tracks (T35)", () => {
    const lit = (tracks?: { fade: string[] }) => {
      const t = setup(tracks ? { tracks } : {});
      t.show.groups.put({ id: "g", name: "G", master: { level: 0.5 }, presets: { included: ["w"] } });
      t.show.faders.put({ id: "f", name: "F", channels: [{ fixture: "bar-l", offset: 3 }], level: 0, dca: "g" });
      t.show.looks.put(look("w", "#ffffff", {}));
      t.show.go("w");
      const b = t.dmx();
      return [(b[0]! * b[3]!) / 255, (b[0]! * b[4]!) / 255].map(Math.round);
    };
    expect(lit({ fade: LIGHT })).to.deep.equal(lit());
  });

  it("leaves the neighbour's addresses a look reaches past a fixture with tracks as they were", () => {
    const run = (tracks?: { fade: string[] }) => {
      const t = setup(tracks ? { tracks } : {});
      t.show.looks.put(look("a", "#ff0000", { entryFade: 2 }, [[16, 180], [2, 200]])); // offset 16: bar-r's Strobe
      return sample(t, 2500, [15, 16, 17, 18], (i) => i === 0 && t.show.go("a"));
    };
    expect(run({ fade: LIGHT })).to.deep.equal(run());
  });

  /** The light of head 0 (dimmer × red), sample by sample. */
  const light = (rows: number[][]) => rows.map((r) => (r[0]! * r[1]!) / 255);
  const steepestLight = (rows: number[][]) => Math.max(...light(rows).slice(1).map((v, i) => Math.abs(v - light(rows)[i]!)));

  it("lets a look over a painted one leave in its place: no jump at the stop nor at the end (the leaving look stays on top)", () => {
    const t = setup({ tracks: { fade: LIGHT } });
    t.show.looks.put(look("p", "#ff0000", {}));
    t.show.looks.put(look("d", undefined, { exitFade: 2 }, [[0, 100], [2, 200]]));
    t.show.go("p");
    t.show.go("d");
    const rows = sample(t, 3000, [0, 3], (i) => i === 5 && t.show.stop("d"));
    expect(rows[0]![0]).to.equal(100); // d covers p's dimmer while it plays (« last »)
    expect(steepest(rows)[0]).to.be.at.most(bound(2));
    expect(rows.at(-1)![0]).to.equal(255);
  });

  it("takes the light of a scene look arriving on a painting in fade, or crossing it, without a jump (L2, L3 are gone with tracks)", () => {
    const l2 = (tracks?: { fade: string[] }) => {
      const t = setup(tracks ? { tracks } : {});
      t.show.looks.put(look("p", "#ff0000", { entryFade: 2 }));
      t.show.looks.put(look("d", undefined, { entryFade: 2 }, [[0, 150], [2, 200]]));
      return steepestLight(sample(t, 4000, [0, 3], (i) => (i === 0 ? t.show.go("p") : i === 50 && t.show.go("d"))));
    };
    const l3 = (tracks?: { fade: string[] }) => {
      const t = setup(tracks ? { tracks } : {});
      t.show.looks.put(look("c", "#ff0000", { entryFade: 2 }, [[0, 255]]));
      t.show.looks.put(look("d", undefined, { entryFade: 2 }, [[0, 100], [2, 200]]));
      t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["c", "d"] } });
      return steepestLight(sample(t, 4000, [0, 3], (i) => (i === 0 ? t.show.go("c") : i === 25 && t.show.go("d"))));
    };
    expect(l2(), "L2 without tracks").to.be.greaterThan(40);
    expect(l2({ fade: LIGHT })).to.be.at.most(bound(2, 2));
    expect(l3(), "L3 without tracks").to.be.greaterThan(15);
    expect(l3({ fade: LIGHT })).to.be.at.most(bound(2, 2));
  });
});
