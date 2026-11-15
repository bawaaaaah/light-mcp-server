import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { PositionPresetSchema } from "../../../src/plugins/light/show/model.js";
import { basisOf, fillBasis, legacyBasisOf, positionStale, type BasisSource, type HeadNow } from "../../../src/plugins/light/show/position-presets.js";
import { ShowRuntime } from "../../../src/plugins/light/show/runtime.js";
import { beyondStops } from "../../../src/plugins/light/venue/stops-check.js";
import { Venue } from "../../../src/plugins/light/venue/venue.js";

/**
 * Named positions (T32, lot 1; docs/specs/venue-fixtures-stage.md, « Positions nommées »): the schema (pan/tilt or a
 * point, never both), the basis that makes a position stale field by field (and only on the geometry), and the
 * runtime's capture (`positionNow`: the manual position, else what the motion layer gave on the last frame).
 */
describe("named positions: schema and staleness (T32)", () => {
  const head: BasisSource = {
    patch: { manufacturer: "Test", model: "Spot 7", position: { x: 1, y: 2, z: 5 }, mount: "hung", orientation: { yaw: 0, invertPan: false, invertTilt: false, swapPanTilt: false, panOffset: 0, tiltOffset: 0 } },
    panMax: 540,
    tiltMax: 270,
  };
  const with_ = (patch: Partial<BasisSource["patch"]>, more: Partial<BasisSource> = {}): BasisSource => ({ ...head, ...more, patch: { ...head.patch, ...patch } });
  const turned = (o: object): BasisSource => with_({ orientation: { ...head.patch.orientation!, ...o } });

  it("takes pan/tilt per head or a point, one of the two", () => {
    expect(PositionPresetSchema.parse({ id: "a", name: "Avant-scène", values: { spot: { pan: 0.2, tilt: 0.7 } } }).basis).to.deep.equal({});
    expect(PositionPresetSchema.parse({ id: "b", name: "Douche", point: { x: 0, y: 2, z: 0 } }).values).to.deep.equal({});
    expect(PositionPresetSchema.safeParse({ id: "c", name: "Les deux", values: { spot: { pan: 0.2, tilt: 0.7 } }, point: { x: 0, y: 0, z: 0 } }).success).to.equal(false);
    expect(PositionPresetSchema.safeParse({ id: "d", name: "Rien" }).success).to.equal(false);
    expect(PositionPresetSchema.safeParse({ id: "e", name: "Hors course", values: { spot: { pan: 1.2, tilt: 0.5 } } }).success).to.equal(false);
    // the point a pan/tilt position was aimed at, never with a point position
    expect(PositionPresetSchema.safeParse({ id: "f", name: "Visée", values: { spot: { pan: 0.2, tilt: 0.7 } }, aim: { x: 0, y: 2, z: 1.5 } }).success).to.equal(true);
    expect(PositionPresetSchema.safeParse({ id: "g", name: "Visée", point: { x: 0, y: 2, z: 0 }, aim: { x: 0, y: 2, z: 1.5 } }).success).to.equal(false);
  });

  it("the basis changes with the geometry, the travel and the definition, field by field, each in its part", () => {
    const base = basisOf(head);
    expect(base).to.match(/^[0-9a-f]{12}\.[0-9a-f]{12}\.[0-9a-f]{12}$/);
    const part = (b: string, i: number) => b.split(".")[i];
    // geometry: where the same bytes send the beam
    const geometry: [string, BasisSource][] = [
      ["moved", with_({ position: { x: 1.5, y: 2, z: 5 } })],
      ["placed nowhere", with_({ position: undefined })],
      ["rehung", with_({ mount: "floor" })],
      ["turned upside up", turned({ pitch: 90 })],
      ["pan inverted", turned({ invertPan: true })],
      ["tilt inverted", turned({ invertTilt: true })],
      ["axes swapped", turned({ swapPanTilt: true })],
      ["another model", with_({ model: "Spot 9" })],
    ];
    for (const [why, f] of geometry) expect(part(basisOf(f), 0), why).to.not.equal(part(base, 0));
    // aiming: only the angles a pan/tilt is read as
    const aiming: [string, BasisSource][] = [
      ["turned", turned({ yaw: 90 })],
      ["recalibrated pan", turned({ panOffset: 3 })],
      ["recalibrated tilt", turned({ tiltOffset: -2 })],
      ["another pan travel", with_({}, { panMax: 360 })],
      ["another tilt travel", with_({}, { tiltMax: 180 })],
    ];
    for (const [why, f] of aiming) {
      expect(part(basisOf(f), 0), why).to.equal(part(base, 0));
      expect(part(basisOf(f), 1), why).to.not.equal(part(base, 1));
    }
    const stopped = basisOf(turned({ limits: { pan: [-30, 30] } }));
    expect([part(stopped, 0), part(stopped, 1)]).to.deep.equal([part(base, 0), part(base, 1)]);
    expect(part(stopped, 2)).to.not.equal(part(base, 2));
  });

  it("the basis ignores what does not turn the beam: a name, an address, a roll, defaults written out", () => {
    const base = basisOf(head);
    const patch = { ...head.patch, name: "Renamed", universe: 2, address: 101, color: "#ff0000", roll: 90 } as BasisSource["patch"];
    expect(basisOf({ ...head, patch })).to.equal(base);
    expect(basisOf(turned({ roll: 45 }))).to.equal(base);
    // an orientation absent is the same as one at its defaults
    expect(basisOf(with_({ orientation: undefined }))).to.equal(base);
  });

  it("the basis reads the mount as the aiming does (hung or not), the heading modulo 360, never the DMX mode (P2)", () => {
    const base = basisOf(head);
    // a truss and a hook both hang the head; a pitch towards the floor says hung as well
    expect(basisOf(with_({ mount: "truss" }))).to.equal(base);
    expect(basisOf(turned({ pitch: -90 }))).to.equal(base);
    expect(basisOf(with_({ mount: "floor" }))).to.equal(basisOf(with_({ mount: "stand" })));
    expect(basisOf(with_({ mount: "floor" }))).to.not.equal(base);
    expect(basisOf(turned({ yaw: 360 }))).to.equal(base);
    expect(basisOf(turned({ yaw: -90 }))).to.equal(basisOf(turned({ yaw: 270 })));
    // switching between the 8-bit and 16-bit modes (T6) keeps the position fresh: the travel is already in it
    const patch = { ...head.patch, mode: "Basic" } as BasisSource["patch"];
    expect(basisOf({ ...head, patch })).to.equal(base);
  });

  it("positionStale lists the covered heads whose basis changed; a point never, an unpatched head apart", () => {
    const p = { values: { a: { pan: 0.1, tilt: 0.2 }, b: { pan: 0.3, tilt: 0.4 }, c: { pan: 0.5, tilt: 0.5 }, d: { pan: 0.5, tilt: 0.5 } }, basis: { a: "g.a.s", b: "g.a.s", c: "g.a.s" } };
    const at = (basis: string): HeadNow => ({ basis, legacy: "old", beyondStops: () => false });
    const now: Record<string, HeadNow> = { a: at("g.a.s"), b: at("moved.a.s"), d: at("g.a.s") };
    // c is no longer patched (said apart), d was saved without a basis (cannot be judged)
    expect(positionStale(p, (f) => now[f])).to.deep.equal(["b"]);
    expect(positionStale({ values: {}, basis: {} }, () => at("x.y.z"))).to.deep.equal([]);
  });

  it("positionStale: a correction of the calibration or the travel stales only the heads aimed at a point (2026-11-15)", () => {
    const values = { pad: { pan: 0.3, tilt: 0.4 }, aimed: { pan: 0.6, tilt: 0.7 } };
    const basis = { pad: "g.a.s", aimed: "g.a.s" };
    const recalibrated = (): HeadNow => ({ basis: "g.recal.s", legacy: "old", beyondStops: () => false });
    // set at the pad: its bytes are kept, never stale for a calibration; aimed at the point: stale
    expect(positionStale({ values, basis, aim: { x: 0, y: 3, z: 0 }, aimed: ["aimed"] }, recalibrated)).to.deep.equal(["aimed"]);
    // without `aimed`, an aim covers every head; without an aim, none is aimed
    expect(positionStale({ values, basis, aim: { x: 0, y: 3, z: 0 } }, recalibrated)).to.deep.equal(["pad", "aimed"]);
    expect(positionStale({ values, basis }, recalibrated)).to.deep.equal([]);
  });

  it("positionStale: new useful stops stale only a head whose stored pan/tilt reaches beyond them", () => {
    const values = { inside: { pan: 0.5, tilt: 0.5 }, beyond: { pan: 0.9, tilt: 0.5 } };
    const now = (): HeadNow => ({ basis: "g.a.stops", legacy: "old", beyondStops: (v) => v.pan > 0.6 });
    expect(positionStale({ values, basis: { inside: "g.a.s", beyond: "g.a.s" } }, now)).to.deep.equal(["beyond"]);
    // beyond stops it was saved with (unchanged since): not stale (« Vérifier le show » says the clipping apart)
    expect(positionStale({ values, basis: { inside: "g.a.stops", beyond: "g.a.stops" } }, now)).to.deep.equal([]);
  });

  it("positionStale: a basis saved before the parts is compared whole, with the legacy fingerprint", () => {
    const real = basisOf(head);
    const legacy = legacyBasisOf(head);
    // the single fingerprint `basisOf` gave this head before the parts (1bfb57c^): bases saved then must still match
    expect(legacy).to.equal("e1f759514d3a");
    const now = (f: BasisSource) => (): HeadNow => ({ basis: basisOf(f), legacy: legacyBasisOf(f), beyondStops: () => false });
    const p = { values: { a: { pan: 0.3, tilt: 0.4 } }, basis: { a: legacy } };
    expect(positionStale(p, now(head))).to.deep.equal([]);
    expect(positionStale(p, now(turned({ panOffset: 2 })))).to.deep.equal(["a"]);
    expect(positionStale({ ...p, basis: { a: real } }, now(turned({ panOffset: 2 })))).to.deep.equal([]);
    // the stops are not in the legacy fingerprint
    expect(legacyBasisOf(turned({ limits: { pan: [-30, 30] } }))).to.equal(legacy);
  });

  /** A head as `positionStale` judges it, from a real fixture: its bases now and its own stops (stops-check.ts). */
  const judged = (f: BasisSource): HeadNow => ({ basis: basisOf(f), legacy: legacyBasisOf(f), beyondStops: (v) => beyondStops({ panMax: f.panMax!, tiltMax: f.tiltMax!, limits: f.patch.orientation?.limits }, v) });

  it("positionStale: a correction of the travel that takes a pad position past an unchanged stop stales it", () => {
    // pan stop ± 100°: 0.68 of a 540° travel is 97.2°, inside; of a 630° travel, 113.4°, beyond
    const stopped = turned({ limits: { pan: [-100, 100] } });
    const p = { values: { a: { pan: 0.68, tilt: 0.5 } }, basis: { a: basisOf(stopped) } };
    expect(positionStale(p, () => judged(stopped))).to.deep.equal([]);
    const corrected: BasisSource = { ...stopped, panMax: 630 };
    expect(basisOf(corrected).split(".")[2]).to.equal(basisOf(stopped).split(".")[2]);
    expect(positionStale(p, () => judged(corrected))).to.deep.equal(["a"]);
    // still within the stop after the correction: a pad position keeps its bytes, fresh
    expect(positionStale({ ...p, values: { a: { pan: 0.6, tilt: 0.5 } } }, () => judged(corrected))).to.deep.equal([]);
  });

  it("positionStale: a basis saved before the parts is stale beyond the stops, even when the legacy fingerprint is unchanged", () => {
    const p = { values: { a: { pan: 0.68, tilt: 0.5 } }, basis: { a: legacyBasisOf(head) } };
    // the stops are not in the legacy fingerprint: it matches, yet the stored pan/tilt reaches beyond the new stop
    const stopped = turned({ limits: { pan: [-30, 30] } });
    expect(legacyBasisOf(stopped)).to.equal(legacyBasisOf(head));
    expect(positionStale(p, () => judged(stopped))).to.deep.equal(["a"]);
    expect(positionStale({ ...p, values: { a: { pan: 0.52, tilt: 0.5 } } }, () => judged(stopped))).to.deep.equal([]);
  });

  it("fillBasis keeps a given basis, the stored one for an unchanged head, else takes the head's basis now", () => {
    const stored = { values: { a: { pan: 0.1, tilt: 0.2 }, b: { pan: 0.3, tilt: 0.4 } }, basis: { a: "old-a", b: "old-b" } };
    const now = (f: string) => (f === "gone" ? undefined : `now-${f}`);
    const next = { values: { a: { pan: 0.1, tilt: 0.2 }, b: { pan: 0.35, tilt: 0.4 }, c: { pan: 0.5, tilt: 0.5 }, given: { pan: 0.5, tilt: 0.5 }, gone: { pan: 0.5, tilt: 0.5 } }, basis: { given: "mine" } };
    expect(fillBasis(next, stored, now)).to.deep.equal({ a: "old-a", b: "now-b", c: "now-c", given: "mine" });
    expect(fillBasis({ values: {}, basis: { a: "x" }, point: { x: 0, y: 0, z: 0 } }, stored, now)).to.deep.equal({});
  });
});

describe("named positions: capture in the runtime (T32)", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "light-presets-rt-"));
    const defs = join(dir, "fixtures");
    mkdirSync(defs);
    copyFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), join(defs, "spot.qxf"));
    const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
    venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: -1, y: 2, z: 5 }, mount: "hung" });
    venue.canvases.put({ id: "lyres", name: "Lyres", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "spot", head: -1 }] }] });
    const clock = { now: 0, beats: 0 };
    const show = new ShowRuntime(new FolderStore(join(dir, "show")), venue, { state: () => ({ beats: clock.beats, bpm: 120 }) }, () => clock.now);
    const frame = () => {
      const buf = new Uint8Array(512);
      show.render([buf]);
      show.guard([buf]);
      clock.now += 20;
      clock.beats += 0.04;
    };
    return { venue, show, clock, frame };
  }

  it("a new show has an empty positions collection", () => {
    const { show } = setup();
    expect(show.positionPresets.list()).to.deep.equal([]);
  });

  it("captures the centre before any frame, the manual position when set, else what a look shows at that instant", () => {
    const { show, frame } = setup();
    expect(show.positionNow("spot")).to.deep.equal({ pan: 0.5, tilt: 0.5 });
    show.looks.put({ id: "cercle", name: "Cercle", canvas: "lyres", technique: { kind: "aucune" }, move: { shape: "cercle", center: { pan: 0.4, tilt: 0.6 }, size: { pan: 0.1, tilt: 0.1 }, every: { seconds: 2 }, fade: { seconds: 0 } } } as never);
    show.go("cercle");
    for (let k = 0; k < 10; k++) frame();
    // the shape at the instant of the last frame: the layer's value, not the centre
    const shown = show.motionStatus().get("spot")!;
    const now = show.positionNow("spot");
    expect(now.pan).to.be.closeTo(shown.pan.position, 1e-9);
    expect(now.tilt).to.be.closeTo(shown.tilt.position, 1e-9);
    expect(Math.hypot(now.pan - 0.4, now.tilt - 0.6)).to.be.closeTo(0.1, 0.02);
    // the pad: where it asked the head to go, even before the head got there
    show.setPosition(["spot"], { pan: 0.2, tilt: 0.8 }, "glide");
    frame();
    expect(show.positionNow("spot")).to.deep.equal({ pan: 0.2, tilt: 0.8 });
    // one axis by hand: the other is the look's
    show.releasePositions();
    show.setPosition(["spot"], { pan: 0.3 });
    frame();
    const mixed = show.positionNow("spot");
    expect(mixed.pan).to.equal(0.3);
    expect(mixed.tilt).to.be.closeTo(show.motionStatus().get("spot")!.tilt.position, 1e-9);
  });

  it("positionBasis follows the patch: moved, the basis changes; unknown, none", () => {
    const { show, venue } = setup();
    const before = show.positionBasis("spot");
    expect(before).to.match(/^[0-9a-f]{12}\.[0-9a-f]{12}\.[0-9a-f]{12}$/);
    venue.fixtures.put({ ...venue.fixtures.get("spot")!, name: "Spot renamed" });
    expect(show.positionBasis("spot")).to.equal(before);
    venue.fixtures.put({ ...venue.fixtures.get("spot")!, position: { x: 0, y: 2, z: 5 } });
    expect(show.positionBasis("spot")).to.not.equal(before);
    expect(show.positionBasis("ghost")).to.equal(undefined);
  });
});
