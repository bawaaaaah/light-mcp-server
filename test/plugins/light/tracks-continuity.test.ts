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
  exclusive?: string[];
  /** A channel fader on these offsets, at this level. */
  fader?: { offsets: number[]; level: number };
  /** [ms, "go" | "stop", look], in time order. */
  events: [number, "go" | "stop", string][];
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
  if (s.exclusive) show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: s.exclusive } });
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
      if (s.events[e]![1] === "go") show.go(s.events[e]![2]);
      else show.stop(s.events[e]![2]);
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
