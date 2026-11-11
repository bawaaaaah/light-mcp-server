import { expect } from "chai";
import { copyFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { mergeColors, Venue, type AttributeFrame } from "../../../src/plugins/light/venue/venue.js";
import { ShowRuntime } from "../../../src/plugins/light/show/runtime.js";

/** Zones 1-3 (RGBW) at offsets 2-13, the halo (RGB) at 14-16 (test/fixtures/wash-zones.qxf, patched at 1). */
const ZONE = (z: number) => [2 + 4 * (z - 1), 3 + 4 * (z - 1), 4 + 4 * (z - 1)];
const HALO = [14, 15, 16];
/** Bar 4 (declared heads, no accent), patched at 30: head h's RGB. */
const BAR = (h: number) => [29 + 3 + 3 * h, 29 + 4 + 3 * h, 29 + 5 + 3 * h];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "light-heads-fades-"));
  const defs = join(dir, "fixtures");
  mkdirSync(defs);
  copyFileSync(new URL("../../fixtures/wash-zones.qxf", import.meta.url), join(defs, "wash-zones.qxf"));
  copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(defs, "bar4.qxf"));
  const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
  venue.fixtures.put({ id: "wash", name: "Wash", manufacturer: "Test", model: "Wash Zones", mode: "18 Channel", universe: 1, address: 1 });
  venue.fixtures.put({ id: "bar", name: "Bar", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 30 });
  const canvas = (id: string, targets: { fixture: string; head: number }[]) => venue.canvases.put({ id, name: id, topology: "line", cells: targets.length, render: targets.map((t, i) => ({ from: i, to: i, targets: [t] })) });
  canvas("whole", [{ fixture: "wash", head: -1 }]);
  canvas("zone1", [{ fixture: "wash", head: 0 }]);
  canvas("zones", [0, 1, 2].map((head) => ({ fixture: "wash", head })));
  canvas("halo", [{ fixture: "wash", head: 3 }]);
  canvas("bar-whole", [{ fixture: "bar", head: -1 }]);
  canvas("bar-heads", [0, 1, 2, 3].map((head) => ({ fixture: "bar", head })));
  let now = 0;
  const show = new ShowRuntime(new FolderStore(join(dir, "show")), venue, { state: () => ({ beats: now / 500 }) }, () => now);
  const look = (id: string, canvasId: string, color: string, timing: { entryFade?: number; exitFade?: number } = {}) => show.looks.put({ id, name: id, canvas: canvasId, technique: { kind: "plat", color }, timing });
  const dmx = () => {
    const buffers = [new Uint8Array(512)];
    show.render(buffers);
    return buffers[0]!;
  };
  /** Every 50 ms for `ms`: the largest step of each listed channel between two frames, and the last frame. */
  const sample = (ms: number, channels: number[]) => {
    let prev = dmx();
    let step = 0;
    for (let t = 0; t < ms; t += 50) {
      now += 50;
      const cur = dmx();
      for (const c of channels) step = Math.max(step, Math.abs(cur[c]! - prev[c]!));
      prev = cur;
    }
    return { step, last: prev };
  };
  return { venue, show, look, dmx, sample, advance: (ms: number) => void (now += ms) };
}
const at = (b: Uint8Array, offsets: number[]) => offsets.map((o) => b[o]);
/** A 2 s fade sampled every 50 ms moves no channel by more than this (eased: about 1.6 times the linear 6.4). */
const SMOOTH = 16;

describe("heads: the halo fades and merges like any head", () => {
  it("crossfades a whole red wash into a zone-1 green look of an exclusive group without a jump on the halo", () => {
    const { show, look, sample } = setup();
    look("a", "whole", "#ff0000");
    look("b", "zone1", "#00ff00", { entryFade: 2 });
    show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
    show.go("a");
    show.go("b");
    const { step, last } = sample(3000, [...HALO, ...ZONE(1), ...ZONE(2)]);
    expect(step).to.be.at.most(SMOOTH);
    expect([at(last, HALO), at(last, ZONE(1)), at(last, ZONE(2))]).to.deep.equal([
      [0, 255, 0],
      [0, 255, 0],
      [0, 0, 0],
    ]); // the halo follows B's zone 1
  });

  it("fades out a whole red wash on its exit while a zone-1 green look comes in, the halo included", () => {
    const { show, look, sample } = setup();
    look("a", "whole", "#ff0000", { exitFade: 2 });
    look("b", "zone1", "#00ff00", { entryFade: 2 });
    show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
    show.go("a");
    show.go("b");
    expect(sample(3000, [...HALO, ...ZONE(1)]).step).to.be.at.most(SMOOTH);
  });

  it("brings a halo-only look in over red zones and takes it out again, smoothly both ways", () => {
    const { show, look, sample } = setup();
    look("a", "zones", "#ff0000");
    look("b", "halo", "#0000ff", { entryFade: 2, exitFade: 2 });
    show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
    show.go("a");
    sample(200, []);
    show.go("b");
    const entering = sample(3000, HALO);
    expect(entering.step).to.be.at.most(SMOOTH);
    expect(at(entering.last, HALO)).to.deep.equal([0, 0, 255]);
    show.go("a"); // back to the red zones: the halo follows them again
    const leaving = sample(3000, HALO);
    expect(leaving.step).to.be.at.most(SMOOTH);
    expect(at(leaving.last, HALO)).to.deep.equal([255, 0, 0]);
  });

  it("keeps the brightest on the halo with looksMerge « highest », like on the zones", () => {
    const { show, look, dmx } = setup();
    show.saveSettings({ looksMerge: "highest" });
    look("a", "whole", "#ff0000");
    look("b", "zone1", "#00ff00");
    show.go("a");
    show.go("b");
    const b = dmx();
    expect([at(b, ZONE(1)), at(b, HALO)]).to.deep.equal([
      [255, 255, 0],
      [255, 255, 0],
    ]);
  });
});

describe("heads: « last » covers every head the latest look reaches", () => {
  const sheet = (entries: [string, [number, Record<string, number>][]][]): AttributeFrame["colors"] => new Map(entries.map(([f, heads]) => [f, new Map(heads)]));
  const plain = (c: AttributeFrame["colors"]) => Object.fromEntries([...c].map(([f, heads]) => [f, Object.fromEntries(heads)]));

  it("lets a later whole-fixture colour replace the heads an earlier look painted", () => {
    const into = sheet([["bar", [[0, { red: 1 }], [1, { red: 1 }]]]]);
    mergeColors(into, sheet([["bar", [[-1, { blue: 1 }]]]]), "last");
    expect(plain(into)).to.deep.equal({ bar: { "-1": { blue: 1 } } });
  });

  it("on a declared-heads bar: heads first then whole, and whole first then heads", () => {
    const { show, look, dmx } = setup();
    look("heads", "bar-heads", "#ff0000");
    look("whole", "bar-whole", "#0000ff");
    show.go("heads");
    show.go("whole");
    expect([0, 1, 2, 3].map((h) => at(dmx(), BAR(h)))).to.deep.equal(Array(4).fill([0, 0, 255]));
    show.stop("heads");
    show.stop("whole");
    show.go("whole");
    show.go("heads");
    expect([0, 1, 2, 3].map((h) => at(dmx(), BAR(h)))).to.deep.equal(Array(4).fill([255, 0, 0]));
  });

  it("on a zoned wash: the later look covers the zones and the halo, whichever paints whole", () => {
    const { show, look, dmx } = setup();
    look("zones", "zones", "#ff0000");
    look("whole", "whole", "#0000ff");
    show.go("zones");
    show.go("whole");
    expect([at(dmx(), ZONE(1)), at(dmx(), ZONE(3)), at(dmx(), HALO)]).to.deep.equal(Array(3).fill([0, 0, 255]));
    show.stop("zones");
    show.stop("whole");
    show.go("whole");
    show.go("zones");
    expect([at(dmx(), ZONE(1)), at(dmx(), ZONE(3)), at(dmx(), HALO)]).to.deep.equal(Array(3).fill([255, 0, 0])); // not the older look's halo
  });

  it("leaves an older halo paint alone when the later whole colour does not reach the halo (follow false)", () => {
    const { venue, show, look, dmx } = setup();
    venue.fixtures.put({ ...venue.fixtures.get("wash")!, overrides: { heads: { follow: false } } });
    look("halo", "halo", "#00ff00");
    look("whole", "whole", "#0000ff");
    show.go("halo");
    show.go("whole");
    expect([at(dmx(), ZONE(1)), at(dmx(), HALO)]).to.deep.equal([
      [0, 0, 255],
      [0, 255, 0],
    ]);
  });
});
