import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { Venue, type ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";
import { composeTracks, dominantLayer, overSheets, trackChannels, tracksOf, type ResolvedTracks, type TrackLayer } from "../../../src/plugins/light/venue/tracks.js";
import type { WheelFrame } from "../../../src/plugins/light/venue/color-wheel.js";

/** A venue with a mixed bar (bar4: Dimmer, Strobe, Program, then four RGB heads), a 16-bit spot and a lamp with a wheel. */
function venue(): Venue {
  const dir = mkdtempSync(join(tmpdir(), "light-tracks-"));
  const defs = join(dir, "fixtures");
  mkdirSync(defs);
  for (const f of ["bar4.qxf", "spot.qxf", "wheel-spot.qxf"]) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(defs, f));
  const v = new Venue(new FolderStore(join(dir, "venue")), [defs]);
  v.fixtures.put({ id: "bar", name: "Bar", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1 });
  v.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 100 });
  v.fixtures.put({ id: "lamp", name: "Lamp", manufacturer: "Test", model: "Wheel Spot", mode: "Standard", universe: 1, address: 200 });
  return v;
}
const resolved = (v: Venue, id: string) => v.resolve(id) as ResolvedFixture;
const tracks = (r: ResolvedFixture, fade: string[]): ResolvedTracks => tracksOf(r.def, r.mode, { enabled: true, fade })!;
const layer = (sheet: string, weight: number, o: { colors?: [number, Record<string, number>][]; raw?: [number, number][]; level?: [number, number][] } = {}): TrackLayer => ({
  look: sheet,
  sheet,
  weight,
  raw: new Map(o.raw ?? []),
  ...(o.colors ? { colors: new Map(o.colors) } : {}),
  ...(o.level ? { level: new Map(o.level) } : {}),
});
const LIGHT = ["Dimmer", "R1", "G1", "B1", "R2", "G2", "B2", "R3", "G3", "B3", "R4", "G4", "B4"];
const opts = { merge: "last" as const, intensity: 1 };
// bar: 0 Dimmer, 1 Strobe, 2 Program, 3-5 R1 G1 B1
const RED = [-1, { red: 1 }] as [number, Record<string, number>];
const BLUE = [-1, { blue: 1 }] as [number, Record<string, number>];

describe("fadeable tracks: names to offsets (tracksOf)", () => {
  it("is nothing unless enabled on the fixture", () => {
    const r = resolved(venue(), "bar");
    expect(tracksOf(r.def, r.mode, undefined)).to.equal(undefined);
    expect(tracksOf(r.def, r.mode, { fade: ["Dimmer"] })).to.equal(undefined);
    expect(tracksOf(r.def, r.mode, { enabled: false, fade: ["Dimmer"] })).to.equal(undefined);
    expect([...tracksOf(r.def, r.mode, { enabled: true })!.fade]).to.deep.equal([]);
  });

  it("names channels as the definition does, a fine channel following its coarse one, an unknown name ignored", () => {
    const v = venue();
    const bar = resolved(v, "bar");
    expect([...tracks(bar, ["Dimmer", "R1", "nope"]).fade]).to.deep.equal([0, 3]);
    const spot = resolved(v, "spot");
    // Standard: Pan, Pan fine, Tilt, Tilt fine…: ticking Pan ticks its fine channel
    const t = tracks(spot, ["Pan"]);
    expect([...t.fade]).to.deep.equal([0, 1]);
    expect(t.motion).to.deep.equal({ pan: "glide", tilt: "cut" });
    expect(tracks(spot, []).motion).to.deep.equal({ pan: "cut", tilt: "cut" });
  });

  it("lists the channels a user ticks by kind, fine ones left out", () => {
    const v = venue();
    expect(trackChannels(resolved(v, "bar")).slice(0, 4).map((c) => [c.name, c.kind])).to.deep.equal([
      ["Dimmer", "dimmer"],
      ["Strobe", "other"],
      ["Program", "other"],
      ["R1", "colour"],
    ]);
    expect(trackChannels(resolved(v, "spot")).map((c) => c.name)).to.not.include("Pan fine");
    expect(trackChannels(resolved(v, "lamp")).map((c) => [c.name, c.kind])).to.deep.equal([
      ["Pan", "position"],
      ["Tilt", "position"],
      ["Color Wheel", "wheel"],
      ["Dimmer", "dimmer"],
    ]);
  });
});

describe("fadeable tracks: composition (composeTracks)", () => {
  it("doses a painted look alone once: the fading dimmer carries its weight, its colour stays at full", () => {
    const r = resolved(venue(), "bar");
    const out = composeTracks(r, tracks(r, LIGHT), [layer("look:a", 0.5, { colors: [RED] })], opts);
    expect(out.get(0)).to.be.closeTo(127.5, 1e-9); // the dimmer: the weight
    expect(out.get(3)).to.equal(255); // the red at full: light = 0.5, not 0.25
    expect(out.get(4)).to.equal(0);
  });

  it("makes the colour carry the fade when the dimmer is not ticked (the dimmer jumps to full)", () => {
    const r = resolved(venue(), "bar");
    const out = composeTracks(r, tracks(r, LIGHT.slice(1)), [layer("look:a", 0.5, { colors: [RED] })], opts);
    expect(out.get(0)).to.equal(255);
    expect(out.get(3)).to.be.closeTo(127.5, 1e-9);
  });

  it("jumps on everything when nothing is ticked: the values at once", () => {
    const r = resolved(venue(), "bar");
    const out = composeTracks(r, tracks(r, []), [layer("look:a", 0.1, { colors: [RED], raw: [[2, 200]] })], opts);
    expect([out.get(0), out.get(2), out.get(3)]).to.deep.equal([255, 200, 255]);
  });

  it("switches a jumping channel at mid-fade in a crossfade (one sheet: the heaviest; on equal weights the later)", () => {
    const r = resolved(venue(), "bar");
    const at = (w: number) => composeTracks(r, tracks(r, LIGHT), [layer("x:b", 1 - w, { colors: [RED], raw: [[2, 0]] }), layer("x:b", w, { colors: [BLUE], raw: [[2, 200]] })], opts).get(2);
    expect(at(0.4)).to.equal(0);
    expect(at(0.5)).to.equal(200);
    expect(at(0.6)).to.equal(200);
  });

  it("crossfades the ticked channels without a dip and without a jump", () => {
    const r = resolved(venue(), "bar");
    let prev: Map<number, number> | undefined;
    for (let w = 0; w <= 1.0001; w += 0.05) {
      const out = composeTracks(r, tracks(r, LIGHT), [layer("x:b", 1 - w, { colors: [RED] }), layer("x:b", w, { colors: [BLUE] })], opts);
      expect(out.get(0)).to.be.closeTo(255, 1e-9); // the dimmer never dips
      expect(out.get(3)! + out.get(5)!).to.be.closeTo(255, 1e-6); // red goes to blue
      if (prev) for (const o of [3, 5]) expect(Math.abs(out.get(o)! - prev.get(o)!)).to.be.at.most(255 * 0.05 + 1e-6);
      prev = out;
    }
  });

  it("starts a look over another at once on its jumping channels (« last »: the latest sheet)", () => {
    const r = resolved(venue(), "bar");
    const out = composeTracks(r, tracks(r, LIGHT), [layer("look:a", 1, { colors: [RED], raw: [[2, 50]] }), layer("look:b", 0, { colors: [BLUE], raw: [[2, 200]] })], opts);
    expect(out.get(2)).to.equal(200);
    expect(out.get(3)).to.equal(255); // the colours still A's: B weighs nothing yet
  });

  it("keeps the heaviest across sheets with « highest »", () => {
    const r = resolved(venue(), "bar");
    const out = composeTracks(r, tracks(r, LIGHT), [layer("look:a", 1, { raw: [[2, 50]] }), layer("look:b", 0.3, { raw: [[2, 200]] })], { ...opts, merge: "highest" });
    expect(out.get(2)).to.equal(50);
  });

  it("glides another ticked channel from one value to the other and holds it while a look leaves alone", () => {
    const r = resolved(venue(), "bar");
    const t = tracks(r, [...LIGHT, "Program"]);
    expect(composeTracks(r, t, [layer("x:b", 0.5, { raw: [[2, 100]] }), layer("x:b", 0.5, { raw: [[2, 200]] })], opts).get(2)).to.be.closeTo(150, 1e-9);
    expect(composeTracks(r, t, [layer("exit:a", 0.2, { raw: [[2, 100]] })], opts).get(2)).to.be.closeTo(100, 1e-9);
  });

  it("rests at the show's values without a layer, and never divides by a light of 0", () => {
    const r = resolved(venue(), "bar");
    const t = tracks(r, LIGHT);
    const none = composeTracks(r, t, [], opts);
    expect([none.get(0), none.get(3)]).to.deep.equal([255, 0]); // the dimmer held (dark under no colour), no colour
    const zero = composeTracks(r, t, [layer("look:a", 0, { colors: [RED] })], opts);
    expect([zero.get(0), zero.get(3)]).to.deep.equal([0, 0]);
  });

  it("applies the fixture's intensity on the dimmer, and the groups' level of a look on its own light", () => {
    const r = resolved(venue(), "bar");
    const t = tracks(r, LIGHT);
    expect(composeTracks(r, t, [layer("look:a", 1, { colors: [RED] })], { ...opts, intensity: 0.5 }).get(0)).to.be.closeTo(127.5, 1e-9);
    // a look its group doses at 50 % keeps that level through its fade: half of its weight
    const half = composeTracks(r, t, [layer("look:a", 0.5, { colors: [RED], level: [[0, 0.5]] })], opts);
    expect(half.get(0)).to.be.closeTo(63.75, 1e-9);
    expect(half.get(3)).to.equal(255);
  });

  it("writes no pan/tilt offset, coarse or fine, even raw or ticked", () => {
    const r = resolved(venue(), "spot");
    const out = composeTracks(r, tracks(r, ["Pan", "Tilt", "Dimmer"]), [layer("look:a", 0.5, { colors: [RED], raw: [[0, 10], [1, 20], [2, 30], [3, 40]] })], opts);
    for (const o of [0, 1, 2, 3]) expect(out.has(o), `offset ${o}`).to.equal(false);
  });

  it("takes the wheel's slot and « au noir » factor from its frame, ticked or not", () => {
    const r = resolved(venue(), "lamp");
    const wheel = { pick: { slot: r.wheel!.slots[1]!, value: 15, gap: 0 }, asked: "#ff0000", dim: 0.5, changedAt: undefined } as WheelFrame;
    for (const fade of [["Dimmer"], ["Dimmer", "Color Wheel"]]) {
      const out = composeTracks(r, tracks(r, fade), [layer("look:a", 0.5, { colors: [RED] })], { ...opts, wheel });
      expect(out.get(2)).to.equal(15);
      expect(out.get(3)).to.be.closeTo(255 * 0.5 * 0.5, 1e-9);
    }
  });

  it("lays sheets over each other (« last ») and keeps the highest (« highest »)", () => {
    const c = (sheet: string, weight: number, value: number, order: number) => ({ sheet, weight, value, order });
    expect(overSheets([c("a", 1, 100, 0), c("b", 0.5, 200, 1)], "last", 0)).to.deep.equal({ value: 150, opacity: 1 });
    expect(overSheets([c("a", 1, 200, 0), c("b", 0.5, 100, 1)], "highest", 0).value).to.equal(200);
    expect(dominantLayer([c("a", 1, 1, 0), c("b", 0, 2, 1)], "last")!.value).to.equal(2);
    expect(dominantLayer([c("a", 1, 1, 0), c("b", 0, 2, 1)], "highest")!.value).to.equal(1);
  });
});
