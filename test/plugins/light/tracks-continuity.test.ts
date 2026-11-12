import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { Venue } from "../../../src/plugins/light/venue/venue.js";
import { ShowRuntime } from "../../../src/plugins/light/show/runtime.js";
import { dominantLayer, overSheets } from "../../../src/plugins/light/venue/tracks.js";

/**
 * Fadeable tracks (T5): the ticked channels of a fixture with tracks never jump, frame by frame, through sequences of
 * launches and stops found by a random search (docs/specs/engine-effects-timing.md, « Pistes fondables »). One bar
 * bar4 (0 Dimmer, 1 Strobe, 2 Program — a mode channel —, 3.. four RGB heads); one frame every 20 ms.
 */
const LIGHT = ["Dimmer", "R1", "G1", "B1", "R2", "G2", "B2", "R3", "G3", "B3", "R4", "G4", "B4"];
const COLOURS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
interface LookSpec {
  id: string;
  color?: string;
  raw?: [number, number][];
  /** Entry and exit fades, seconds. */
  fades: [number, number];
}
interface Scenario {
  merge?: "last" | "highest";
  ticked?: string[];
  looks: LookSpec[];
  /** One exclusive group (look ids), or several. */
  exclusive?: string[] | string[][];
  /** A rule that refuses rather than clamps: launches are checked first (strictBounds). */
  strictRule?: boolean;
  /** A channel fader on these offsets, at this level. */
  fader?: { offsets: number[]; level: number };
  /** [ms, "go" | "stop" | "check" (strictBounds alone, as a refused launch) | "checked-go" (strictBounds then go, as look.go), look], in time order. */
  events: [number, "go" | "stop" | "check" | "checked-go", string][];
  /** How long after the last event the frames go on, ms (4000 by default). */
  tail?: number;
}
/** Plays a scenario; the first 15 bytes of every frame, from 0 ms. */
function play(s: Scenario, tracks = true): Uint8Array[] {
  const dir = mkdtempSync(join(tmpdir(), "light-tracks-cont-"));
  const defs = join(dir, "fixtures");
  mkdirSync(defs);
  copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(defs, "bar4.qxf"));
  const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
  venue.fixtures.put({ id: "bar", name: "Bar", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1, ...(tracks ? { overrides: { tracks: { enabled: true, fade: s.ticked ?? LIGHT } } } : {}) });
  venue.canvases.put({ id: "all", name: "All", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "bar" }] }] });
  let beats = 0;
  let now = 0;
  const show = new ShowRuntime(new FolderStore(join(dir, "show")), venue, { state: () => ({ beats }) }, () => now);
  show.saveSettings({ looksMerge: s.merge ?? "last" });
  for (const l of s.looks)
    show.looks.put({
      id: l.id,
      name: l.id,
      canvas: "all",
      technique: l.color ? { kind: "plat", color: l.color } : { kind: "aucune" },
      timing: { entryFade: l.fades[0], exitFade: l.fades[1] },
      ...(l.raw?.length ? { channels: { targets: l.raw.map(([offset]) => ({ fixture: "bar", offset })), steps: [l.raw.map(([, v]) => v)] } } : {}),
    });
  const groups = s.exclusive === undefined ? [] : s.exclusive.every((x) => typeof x === "string") ? [s.exclusive as string[]] : (s.exclusive as string[][]);
  groups.forEach((looks, i) => show.groups.put({ id: `ex${i}`, name: `Ex${i}`, exclusive: true, members: { looks } }));
  if (s.strictRule) show.rules.put({ id: "max-red", name: "Max red", level: "show", target: { color: "red" }, max: 254, onViolation: "reject" });
  if (s.fader) show.faders.put({ id: "f", name: "F", channels: s.fader.offsets.map((offset) => ({ fixture: "bar", offset })), level: s.fader.level });
  const render = () => {
    const b = [new Uint8Array(512)];
    show.render(b);
    return b[0]!.slice(0, 15);
  };
  const step = () => {
    now += 20;
    beats += 0.04;
  };
  // the faders glide to their level before anything plays
  for (let i = 0; i < 100; i++) {
    render();
    step();
  }
  const frames: Uint8Array[] = [];
  const end = s.events.at(-1)![0] + (s.tail ?? 4000);
  let e = 0;
  for (let ms = 0; ms <= end; ms += 20) {
    for (; e < s.events.length && s.events[e]![0] <= ms; e++) {
      const [, op, id] = s.events[e]!;
      if (op === "check" || op === "checked-go") show.strictBounds(id);
      if (op === "go" || op === "checked-go") show.go(id);
      else if (op === "stop") show.stop(id);
    }
    frames.push(render());
    step();
  }
  return frames;
}
/** The largest change from one frame to the next of the dimmer byte and of the light (dimmer × colour) of any colour channel, from `from` ms on. */
function steepest(frames: Uint8Array[], from = 0): { dimmer: number; light: number } {
  let dimmer = 0;
  let light = 0;
  for (let f = Math.max(1, from / 20); f < frames.length; f++) {
    const a = frames[f - 1]!;
    const b = frames[f]!;
    dimmer = Math.max(dimmer, Math.abs(a[0]! - b[0]!));
    for (const o of COLOURS) light = Math.max(light, Math.abs((a[0]! * a[o]!) / 255 - (b[0]! * b[o]!) / 255));
  }
  return { dimmer, light };
}
/** The values a channel takes, in order, without repeats. */
const path = (frames: Uint8Array[], offset: number): number[] => frames.map((b) => b[offset]!).filter((v, i, all) => i === 0 || v !== all[i - 1]);
const at = (frames: Uint8Array[], ms: number) => [...frames[ms / 20]!];
/** Two fades of 2 s running together move at most 9 steps a frame (⌈2 × 1.5 × 0.02 / 2 × 255⌉ + 1); twice that leaves room for a product of two. */
const SMOOTH = 18;
const painted = (id: string, color: string, raw: [number, number][] = [], fades: [number, number] = [2, 2]): LookSpec => ({ id, color, raw, fades });

describe("fadeable tracks: a look leaving through a crossfade stays under the looks launched after it (T5)", () => {
  it("lays every layer at its own rank with « last »: next to each other the layers of a sheet give its mean, apart they keep their place", () => {
    const c = (sheet: string, weight: number, value: number, order: number) => ({ sheet, weight, value, order });
    // a crossfade alone: the weighted mean, whatever the weights add up to
    expect(overSheets([c("x", 0.25, 100, 0), c("x", 0.75, 200, 1)], "last", 0).value).to.be.closeTo(175, 1e-9);
    expect(overSheets([c("x", 0.3, 100, 0), c("x", 0.3, 200, 1)], "last", 50).value).to.be.closeTo(50 * 0.4 + 30 + 60, 1e-9);
    expect(overSheets([c("x", 1, 100, 0), c("x", 1, 200, 1)], "last", 0).value).to.be.closeTo(150, 1e-9);
    // another look launched between the two: the leaving one stays under it, the incoming one comes over it
    expect(overSheets([c("x", 1, 60, 0), c("c", 1, 255, 1), c("x", 0, 255, 2)], "last", 0).value).to.equal(255);
    expect(overSheets([c("x", 0.5, 60, 0), c("c", 1, 250, 1), c("x", 0.5, 10, 2)], "last", 0).value).to.be.closeTo(130, 1e-9);
    expect(overSheets([c("x", 0, 60, 0), c("c", 1, 250, 1), c("x", 1, 10, 2)], "last", 0).value).to.equal(10);
  });

  it("crosses A to B under a look C launched in between without lifting A over C: no jump of the dimmer nor of the light", () => {
    const frames = play({
      looks: [painted("a", "#ff0000", [[0, 60]]), painted("c", "#00ff00"), painted("b", "#0000ff")],
      exclusive: ["a", "b"],
      events: [
        [0, "go", "a"],
        [3000, "go", "c"],
        [6000, "go", "b"],
      ],
    });
    expect(at(frames, 5980).slice(0, 6)).to.deep.equal([255, 0, 0, 0, 255, 0]);
    expect(at(frames, 6000).slice(0, 6)).to.deep.equal([255, 0, 0, 0, 255, 0]);
    expect(steepest(frames).dimmer).to.be.at.most(SMOOTH);
    expect(steepest(frames).light).to.be.at.most(SMOOTH);
    expect(at(frames, 10000).slice(0, 6)).to.deep.equal([255, 0, 0, 0, 0, 255]);
  });

  it("switches a jumping channel once in that crossfade: from C's value to B's, never back to A's", () => {
    const frames = play({
      looks: [painted("a", "#ff0000", [[2, 10]]), painted("c", "#00ff00", [[2, 20]]), painted("b", "#0000ff", [[2, 30]])],
      exclusive: ["a", "b"],
      events: [
        [0, "go", "a"],
        [3000, "go", "c"],
        [6000, "go", "b"],
      ],
    });
    expect(path(frames, 2)).to.deep.equal([10, 20, 30]);
    // at mid-fade (2 s from 6000 ms)
    expect(at(frames, 6980)[2]).to.equal(20);
    expect(at(frames, 7040)[2]).to.equal(30);
    const c = (sheet: string, weight: number, value: number, order: number) => ({ sheet, weight, value, order });
    expect(dominantLayer([c("x", 0.8, 10, 0), c("c", 1, 20, 1), c("x", 0.2, 30, 2)], "last")!.value).to.equal(20);
    expect(dominantLayer([c("x", 0.4, 10, 0), c("c", 1, 20, 1), c("x", 0.6, 30, 2)], "last")!.value).to.equal(30);
  });
});

describe("fadeable tracks: jumping light channels with « highest » (T5)", () => {
  it("keeps the highest value on equal weights, so the steady state is the one without tracks", () => {
    const s: Scenario = {
      merge: "highest",
      ticked: ["Dimmer"],
      looks: [painted("a", "#ffff00", [], [1, 1]), painted("b", "#0000ff", [], [1, 1])],
      events: [
        [0, "go", "a"],
        [2000, "go", "b"],
      ],
    };
    const withTracks = play(s);
    expect(at(withTracks, 6000).slice(0, 6)).to.deep.equal([255, 0, 0, 255, 255, 255]);
    expect(at(withTracks, 6000)).to.deep.equal(at(play(s, false), 6000));
    // each colour still jumps once, never through a value between
    expect(path(withTracks, 5)).to.deep.equal([0, 255]);
    const c = (sheet: string, weight: number, value: number, order: number) => ({ sheet, weight, value, order });
    expect(dominantLayer([c("a", 1, 200, 0), c("b", 1, 100, 1)], "highest", "value")!.value).to.equal(200);
    // a machine channel keeps the later look on equal weights
    expect(dominantLayer([c("a", 1, 200, 0), c("b", 1, 100, 1)], "highest")!.value).to.equal(100);
  });
});

describe("fadeable tracks: a look started again while it leaves (T5)", () => {
  for (const merge of ["last", "highest"] as const) {
    it(`comes back over a look launched in between without a jump (« ${merge} »)`, () => {
      for (const raw of [[], [[0, 60]]] as [number, number][][]) {
        const frames = play({
          merge,
          looks: [painted("a", "#ff0000", raw), painted("b", "#00ff00")],
          events: [
            [0, "go", "a"],
            [3000, "go", "b"],
            [6000, "stop", "a"],
            [6100, "go", "a"],
          ],
        });
        expect(steepest(frames, 3000).dimmer, `dimmer, raw ${JSON.stringify(raw)}`).to.be.at.most(SMOOTH);
        expect(steepest(frames, 3000).light, `light, raw ${JSON.stringify(raw)}`).to.be.at.most(SMOOTH);
        // once back, the look started last is on top (« last ») or both add up (« highest »)
        expect(at(frames, 10000).slice(3, 6)).to.deep.equal(merge === "last" ? [255, 0, 0] : [255, 255, 0]);
      }
    });

    it(`keeps sharing the sheet of the crossfade it was stopped in when it starts again (« ${merge} »)`, () => {
      const frames = play({
        merge,
        looks: [painted("b", "#0000ff"), painted("c", "#ff0000")],
        exclusive: ["b", "c"],
        events: [
          [0, "go", "b"],
          [3000, "go", "c"],
          [4000, "stop", "c"],
          [4400, "go", "c"],
        ],
      });
      expect(steepest(frames, 20).dimmer).to.be.at.most(SMOOTH);
      expect(steepest(frames, 20).light).to.be.at.most(SMOOTH);
    });

    it(`does not part from that sheet when its own entry ends before the others have left (« ${merge} »)`, () => {
      const frames = play({
        merge,
        looks: [painted("a", "#ffffff", [], [2, 1]), { id: "b", raw: [[0, 100]], fades: [0.5, 1] }],
        exclusive: ["a", "b"],
        events: [
          [0, "go", "b"],
          [720, "go", "a"],
          [1280, "stop", "a"],
          [1420, "go", "b"],
        ],
      });
      // b's entry ends at 1920 ms while a still leaves until 2280 ms
      const around = frames.slice(1880 / 20, 1980 / 20);
      expect(steepest(around).dimmer).to.be.at.most(4);
    });

    it(`releases the look launched meanwhile without a jump, and is stopped again without one (« ${merge} »)`, () => {
      // a leaves alone, b comes in on its own, a comes back and releases b: what a still had stays where it was
      const apart = play({
        merge,
        looks: [painted("a", "#c040ff", [[0, 255]]), painted("b", "#00ff00", [], [1, 1])],
        exclusive: ["a", "b"],
        events: [
          [0, "go", "a"],
          [4880, "stop", "a"],
          [4980, "go", "b"],
          [5460, "go", "a"],
        ],
      });
      expect(steepest(apart, 2000).dimmer).to.be.at.most(SMOOTH);
      expect(steepest(apart, 2000).light).to.be.at.most(SMOOTH);
      // a and b were crossing: b comes back, then is stopped while it comes back
      const together = play({
        merge,
        looks: [painted("a", "#202020"), painted("b", "#ff0000", [], [0.5, 2])],
        exclusive: ["a", "b"],
        events: [
          [0, "go", "b"],
          [2400, "go", "a"],
          [2640, "go", "b"],
          [2840, "stop", "b"],
        ],
      });
      // (entry fades of 0.5 s: steeper; the dimmer goes back to its rest, at full, once everything has left)
      expect(steepest(together.slice(1000 / 20, 4000 / 20)).dimmer).to.be.at.most(2 * SMOOTH);
      expect(steepest(together, 1000).light).to.be.at.most(2 * SMOOTH);
    });
  }
});

describe("fadeable tracks: a channel fader holding a colour up (T5)", () => {
  const fader = { offsets: [3], level: 0.5 };
  for (const merge of ["last", "highest"] as const) {
    it(`keeps that colour lit while a painted look fades in and out, the look's own light fading as ever (« ${merge} »)`, () => {
      const s: Scenario = {
        merge,
        looks: [painted("a", "#0000ff")],
        fader,
        events: [
          [1000, "go", "a"],
          [5000, "stop", "a"],
        ],
      };
      const frames = play(s);
      // the fader's red never dips: 128 under a dimmer that stays at full
      for (const b of frames) expect([b[0], b[3]]).to.deep.equal([255, 128]);
      expect(steepest(frames).light).to.be.at.most(SMOOTH);
      expect(at(frames, 2000)[5]).to.be.within(120, 135);
      expect(at(frames, 4000)[5]).to.equal(255);
      expect(at(frames, 8000)[5]).to.equal(0);
      // the same light as on a fixture without tracks, frame by frame
      const plain = play(s, false);
      frames.forEach((b, f) => COLOURS.forEach((o) => expect((b[0]! * b[o]!) / 255, `frame ${f} offset ${o}`).to.be.closeTo((plain[f]![0]! * plain[f]![o]!) / 255, 2)));
    });

    it(`brings a look's raw dimmer down from full, not up from black, under that colour (« ${merge} »)`, () => {
      const frames = play({
        merge,
        looks: [painted("a", "#0000ff", [[0, 100]])],
        fader,
        events: [
          [1000, "go", "a"],
          [5000, "stop", "a"],
        ],
      });
      expect(at(frames, 980)[0]).to.equal(255);
      expect(at(frames, 4000)[0]).to.equal(100);
      expect(at(frames, 8000)[0]).to.equal(255);
      expect(steepest(frames).dimmer).to.be.at.most(SMOOTH);
      expect(steepest(frames).light).to.be.at.most(SMOOTH);
    });
  }

  it("lets a look writing machine channels only come in at once there: no dimmer is left to fade it", () => {
    const frames = play({
      looks: [{ id: "m", raw: [[2, 200]], fades: [2, 2] }],
      fader,
      events: [
        [1000, "go", "m"],
        [5000, "stop", "m"],
      ],
    });
    for (const b of frames) expect([b[0], b[3]]).to.deep.equal([255, 128]);
    expect(path(frames, 2)).to.deep.equal([0, 200, 0]);
  });

  it("known limit: with a colour that jumps, only the dimmer fades the look, and the fader's colour goes dark with it", () => {
    const frames = play({
      ticked: ["Dimmer"],
      looks: [painted("a", "#0000ff")],
      fader,
      events: [
        [1000, "go", "a"],
        [5000, "stop", "a"],
      ],
    });
    expect(at(frames, 980).slice(0, 4)).to.deep.equal([255, 0, 0, 128]);
    expect(at(frames, 1000)[0]).to.equal(0);
    expect(at(frames, 4000)[0]).to.equal(255);
  });
});

describe("fadeable tracks: a look coming back in two layers is still one look (T5)", () => {
  // a comes back while it leaves under b: its weight is laid at two ranks, and the whole of it is what a jumping channel weighs
  const back = (ms: number, entry: number, exit: number, ticked?: string[]): Scenario => ({
    ...(ticked ? { ticked } : {}),
    looks: [painted("a", "#ff0000", [[2, 50]], [entry, 2]), painted("b", "#00ff00", [[2, 200]], [2, exit])],
    exclusive: ["a", "b"],
    events: [
      [0, "go", "a"],
      [3000, "go", "b"],
      [3000 + ms, "go", "a"],
    ],
    tail: 7000,
  });
  for (const merge of ["last", "highest"] as const) {
    it(`never gives a jumping channel to the look it releases while it is still the heavier (« ${merge} »)`, () => {
      // back before mid-fade: a never stopped being the heavier, nothing switches — whatever the fades
      for (const [entry, exit] of [
        [0.5, 5],
        [1, 2],
        [2, 3],
        [1, 1],
      ] as [number, number][]) {
        for (const ticked of [undefined, ["Dimmer"], []]) {
          const frames = play({ ...back(900, entry, exit, ticked), merge });
          expect(path(frames, 2), `Program, entry ${entry} exit ${exit}, ticked ${ticked?.join("+") ?? "light"}`).to.deep.equal([50]);
          if (ticked) expect([path(frames, 3), path(frames, 4)], `colours, entry ${entry} exit ${exit}`).to.deep.equal([[255], [0]]);
        }
      }
    });

    it(`switches a jumping channel once each way when it comes back past mid-fade, with no chatter (« ${merge} »)`, () => {
      for (const [entry, exit] of [
        [1, 1],
        [2, 0],
        [0.5, 2],
      ] as [number, number][])
        for (const ms of [1000, 1100, 1500]) {
          const program = path(play({ ...back(ms, entry, exit), merge }), 2);
          // right at mid-fade the weights are equal: b may not have taken the channel yet
          expect(program, `entry ${entry} exit ${exit}, back after ${ms} ms`).to.deep.equal(ms === 1000 && program.length === 1 ? [50] : [50, 200, 50]);
        }
    });
  }
});
