import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { PositionPresetSchema } from "../../../src/plugins/light/show/model.js";
import { basisOf, fillBasis, positionStale, type BasisSource } from "../../../src/plugins/light/show/position-presets.js";
import { ShowRuntime } from "../../../src/plugins/light/show/runtime.js";
import { Venue } from "../../../src/plugins/light/venue/venue.js";

/**
 * Named positions (T32, lot 1; docs/specs/venue-fixtures-stage.md, « Positions nommées »): the schema (pan/tilt or a
 * point, never both), the basis that makes a position stale field by field (and only on the geometry), and the
 * runtime's capture (`positionNow`: the manual position, else what the motion layer gave on the last frame).
 */
describe("named positions: schema and staleness (T32)", () => {
  const head: BasisSource = {
    patch: { manufacturer: "Test", model: "Spot 7", mode: "Standard", position: { x: 1, y: 2, z: 5 }, mount: "hung", orientation: { yaw: 0, invertPan: false, invertTilt: false, swapPanTilt: false, panOffset: 0, tiltOffset: 0 } },
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

  it("the basis changes with the geometry, the travel and the definition, field by field", () => {
    const base = basisOf(head);
    expect(base).to.match(/^[0-9a-f]{12}$/);
    const changes: [string, BasisSource][] = [
      ["moved", with_({ position: { x: 1.5, y: 2, z: 5 } })],
      ["placed nowhere", with_({ position: undefined })],
      ["rehung", with_({ mount: "floor" })],
      ["turned", turned({ yaw: 90 })],
      ["tilted", turned({ pitch: -90 })],
      ["pan inverted", turned({ invertPan: true })],
      ["tilt inverted", turned({ invertTilt: true })],
      ["axes swapped", turned({ swapPanTilt: true })],
      ["recalibrated pan", turned({ panOffset: 3 })],
      ["recalibrated tilt", turned({ tiltOffset: -2 })],
      ["another pan travel", with_({}, { panMax: 360 })],
      ["another tilt travel", with_({}, { tiltMax: 180 })],
      ["another mode", with_({ mode: "Basic" })],
      ["another model", with_({ model: "Spot 9" })],
    ];
    for (const [why, f] of changes) expect(basisOf(f), why).to.not.equal(base);
  });

  it("the basis ignores what does not turn the beam: a name, an address, a roll, defaults written out", () => {
    const base = basisOf(head);
    const patch = { ...head.patch, name: "Renamed", universe: 2, address: 101, color: "#ff0000", roll: 90 } as BasisSource["patch"];
    expect(basisOf({ ...head, patch })).to.equal(base);
    expect(basisOf(turned({ roll: 45 }))).to.equal(base);
    // an orientation absent is the same as one at its defaults
    expect(basisOf(with_({ orientation: undefined }))).to.equal(base);
  });

  it("positionStale lists the covered heads whose basis changed; a point never, an unpatched head apart", () => {
    const p = { values: { a: { pan: 0.1, tilt: 0.2 }, b: { pan: 0.3, tilt: 0.4 }, c: { pan: 0.5, tilt: 0.5 }, d: { pan: 0.5, tilt: 0.5 } }, basis: { a: "1", b: "2", c: "3" } };
    const now: Record<string, string> = { a: "1", b: "changed", d: "4" };
    // c is no longer patched (said apart), d was saved without a basis (cannot be judged)
    expect(positionStale(p, (f) => now[f])).to.deep.equal(["b"]);
    expect(positionStale({ values: {}, basis: {}, point: { x: 0, y: 0, z: 0 } }, () => "x")).to.deep.equal([]);
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
    expect(before).to.match(/^[0-9a-f]{12}$/);
    venue.fixtures.put({ ...venue.fixtures.get("spot")!, name: "Spot renamed" });
    expect(show.positionBasis("spot")).to.equal(before);
    venue.fixtures.put({ ...venue.fixtures.get("spot")!, position: { x: 0, y: 2, z: 5 } });
    expect(show.positionBasis("spot")).to.not.equal(before);
    expect(show.positionBasis("ghost")).to.equal(undefined);
  });
});
