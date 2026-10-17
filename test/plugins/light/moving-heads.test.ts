import { expect } from "chai";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQxf, findMode } from "../../../src/plugins/light/venue/qxf-import.js";
import { MoveSchema, movePosition } from "../../../src/plugins/light/engine/move.js";
import { aimAt, calibrate, type AimSetup, type CalibrationSample } from "../../../src/plugins/light/venue/aim.js";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { Venue, type ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";
import { ShowRuntime } from "../../../src/plugins/light/show/runtime.js";
import { DmxEngine } from "../../../src/plugins/light/engine/dmx-engine.js";

const spotXml = readFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), "utf8");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "light-heads-"));
  const defs = join(dir, "fixtures");
  mkdirSync(defs);
  copyFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), join(defs, "spot.qxf"));
  const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
  venue.fixtures.put({ id: "spot-l", name: "Lyre jardin", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: -2, y: 2, z: 5 }, mount: "hung" });
  venue.fixtures.put({ id: "spot-r", name: "Lyre cour", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 11, position: { x: 2, y: 2, z: 5 }, mount: "hung", orientation: { yaw: 0, invertPan: true, invertTilt: false, swapPanTilt: false, panOffset: 0, tiltOffset: 0 } });
  venue.canvases.put({ id: "lyres", name: "Lyres", topology: "line", cells: 2, render: [{ from: 0, to: 0, targets: [{ fixture: "spot-l", head: -1 }] }, { from: 1, to: 1, targets: [{ fixture: "spot-r", head: -1 }] }] });
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
  /** pan, tilt (16-bit) of the fixture at `address`. */
  const pos = (b: Uint8Array, address: number) => [(b[address - 1]! << 8) | b[address]!, (b[address + 1]! << 8) | b[address + 2]!];
  return { venue, show, dmx, advance, pos };
}

describe("moving heads", () => {
  describe("definition import", () => {
    it("reads pan/tilt with their fine channels, the travel and the colour wheel", () => {
      const def = parseQxf(spotXml);
      expect(def.channels.get("Pan")).to.include({ attribute: "pan", fine: false });
      expect(def.channels.get("Pan fine")).to.include({ attribute: "pan", fine: true });
      expect(def.channels.get("Tilt fine")).to.include({ attribute: "tilt", fine: true });
      expect([def.panMax, def.tiltMax]).to.deep.equal([540, 270]);
      const basic = findMode(def, "Basic")!;
      expect([basic.panMax, basic.tiltMax]).to.deep.equal([360, 180]); // the mode's own physical section wins
      expect(def.beamAngle).to.equal(undefined); // a lens of 0° says nothing
      const zoom = parseQxf(spotXml.replace('<Lens Name="Other" DegreesMin="0" DegreesMax="0"/>', '<Lens Name="Other" DegreesMin="12" DegreesMax="30"/>'));
      expect(zoom.beamAngle).to.equal(30); // the widest of the zoom
      expect(zoom.beamAngleMin).to.equal(12);
      const wheel = def.channels.get("Color Wheel")!;
      expect(wheel.attribute).to.equal("colorWheel");
      expect(wheel.capabilities.map((c) => c.color)).to.deep.equal(["#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffbf00", undefined]);
    });

    it("opens the beam on the plan as its zoom channel says, within the lens' range", () => {
      const dir = mkdtempSync(join(tmpdir(), "light-zoom-"));
      mkdirSync(join(dir, "fixtures"));
      const xml = spotXml
        .replace('<Lens Name="Other" DegreesMin="0" DegreesMax="0"/>', '<Lens Name="Other" DegreesMin="10" DegreesMax="40"/>')
        .replace('<Channel Name="Dimmer" Preset="IntensityMasterDimmer"/>', '<Channel Name="Dimmer" Preset="IntensityMasterDimmer"/>\n <Channel Name="Zoom" Preset="BeamZoomSmallBig"/>')
        .replace('  <Channel Number="6">Shutter</Channel>\n </Mode>', '  <Channel Number="6">Shutter</Channel>\n  <Channel Number="7">Zoom</Channel>\n </Mode>');
      writeFileSync(join(dir, "fixtures", "spot.qxf"), xml);
      const venue = new Venue(new FolderStore(join(dir, "venue")), [join(dir, "fixtures")]);
      venue.fixtures.put({ id: "s", name: "S", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: 0, y: 2, z: 5 }, mount: "hung" });
      const r = venue.resolve("s") as ResolvedFixture;
      expect(r.zoom).to.deep.equal({ offset: 7, opens: true });
      const buf = new Uint8Array(512);
      expect(venue.openingOf(r, buf)).to.equal(10); // zoom at 0: the narrowest
      buf[7] = 255;
      expect(venue.openingOf(r, buf)).to.equal(40);
      expect(venue.beams([buf])["s"]!.angle).to.equal(40);
    });
  });

  describe("Move FX", () => {
    const move = (m: unknown) => MoveSchema.parse(m);

    it("holds a static position, fanned across the row", () => {
      const m = move({ shape: "fixe", center: { pan: 0.5, tilt: 0.6 }, fan: 0.2 });
      expect(movePosition(m, 3.7, 0, 3)).to.deep.equal({ pan: 0.3, tilt: 0.6 });
      expect(movePosition(m, 0, 1, 3).pan).to.be.closeTo(0.5, 1e-9);
      expect(movePosition(m, 0, 2, 3).pan).to.be.closeTo(0.7, 1e-9);
    });

    it("draws a circle, one turn per cycle", () => {
      const m = move({ shape: "cercle", size: { pan: 0.2, tilt: 0.1 } });
      expect(movePosition(m, 0, 0, 1)).to.deep.equal({ pan: 0.5, tilt: 0.6 });
      const quarter = movePosition(m, 0.25, 0, 1);
      expect(quarter.pan).to.be.closeTo(0.7, 1e-9);
      expect(quarter.tilt).to.be.closeTo(0.5, 1e-9);
      const full = movePosition(m, 1, 0, 1);
      expect(full.pan).to.be.closeTo(0.5, 1e-9);
    });

    it("spreads the phase along the row; « tapis » rolls a full wave by default", () => {
      const tapis = move({ shape: "tapis", size: { tilt: 0.2 } });
      const row = [0, 1, 2, 3, 4].map((i) => movePosition(tapis, 0.25, i, 5).tilt);
      expect(row[0]).to.be.closeTo(0.7, 1e-9); // first fixture at the top of the wave
      expect(row[2]).to.be.closeTo(0.3, 1e-9); // half a cycle later in the row
      expect(row[4]).to.be.closeTo(0.7, 1e-9); // a full cycle: back in phase
      const together = move({ shape: "tilt", size: { tilt: 0.2 } });
      expect(new Set([0, 1, 2].map((i) => movePosition(together, 0.25, i, 3).tilt)).size).to.equal(1);
    });

    it("stays inside the travel", () => {
      const p = movePosition(move({ shape: "pan", center: { pan: 0.95 }, size: { pan: 0.5 } }), 0.25, 0, 1);
      expect(p.pan).to.equal(1);
    });
  });

  describe("aiming", () => {
    const base: AimSetup = { position: { x: 0, y: 0, z: 0 }, hung: false, yaw: 0, panMax: 540, tiltMax: 270, panOffset: 0, tiltOffset: 0 };

    it("points a standing head up, toward the audience and to the side", () => {
      expect(aimAt(base, { x: 0, y: 0, z: 5 })).to.deep.include({ pan: 0.5, tilt: 0.5 });
      const front = aimAt(base, { x: 0, y: -5, z: 0 }) as { panDeg: number; tiltDeg: number };
      expect(front.panDeg).to.be.closeTo(0, 1e-9);
      expect(front.tiltDeg).to.be.closeTo(90, 1e-9);
      const side = aimAt(base, { x: 5, y: 0, z: 0 }) as { panDeg: number; tilt: number };
      expect(side.panDeg).to.be.closeTo(90, 1e-9);
    });

    it("points a hung head down at the floor and forward at an angle", () => {
      const hung = { ...base, hung: true, position: { x: 0, y: 0, z: 6 } };
      expect(aimAt(hung, { x: 0, y: 0, z: 0 })).to.deep.include({ pan: 0.5, tilt: 0.5 });
      const forward = aimAt(hung, { x: 0, y: -6, z: 0 }) as { panDeg: number; tiltDeg: number };
      expect(Math.abs(forward.panDeg) % 180).to.be.closeTo(0, 1e-9);
      expect(Math.abs(forward.tiltDeg)).to.be.closeTo(45, 1e-9);
    });

    it("applies the yaw and calibration offsets, and reports what is out of reach", () => {
      const turned = aimAt({ ...base, yaw: 90 }, { x: 5, y: 0, z: 0 }) as { panDeg: number; tiltDeg: number };
      expect(turned.panDeg).to.be.closeTo(0, 1e-9);
      const offset = aimAt({ ...base, panOffset: 10 }, { x: 0, y: -5, z: 0 }) as { panDeg: number };
      expect(offset.panDeg).to.be.closeTo(-10, 1e-9);
      expect(aimAt({ ...base, panMax: 90, tiltMax: 90 }, { x: 0, y: 5, z: -1 })).to.have.property("error");
    });
  });

  describe("guided calibration", () => {
    // A flown head, turned 30°, tilt 4° off, pan wired backwards: what the operator records when
    // aiming it by hand at three floor marks (output values, inversion included).
    const truth: AimSetup = { position: { x: 2, y: 3, z: 5 }, hung: true, yaw: 30, panMax: 540, tiltMax: 270, panOffset: 0, tiltOffset: 4 };
    const marks = [{ x: 0, y: 1, z: 0 }, { x: 4, y: 2, z: 0 }, { x: 2, y: 5.5, z: 0 }];
    const record = (noise = 0): CalibrationSample[] =>
      marks.map((target, i) => {
        const a = aimAt(truth, target) as { pan: number; tilt: number };
        const jitter = noise * (i % 2 ? 1 : -1);
        return { target, pan: 1 - a.pan + jitter, tilt: a.tilt - jitter };
      });

    it("finds the yaw, tilt offset and inversions from three marks", () => {
      const c = calibrate(truth, record()) as { yaw: number; tiltOffset: number; invertPan: boolean; invertTilt: boolean; errorDeg: number };
      expect(c).to.include({ invertPan: true, invertTilt: false });
      expect(c.yaw).to.be.closeTo(30, 0.1);
      expect(c.tiltOffset).to.be.closeTo(4, 0.1);
      expect(c.errorDeg).to.be.below(0.1);
    });

    it("stays close with hand-aiming imprecision, and reports the error", () => {
      const c = calibrate(truth, record(0.002)) as { yaw: number; errorDeg: number; errors: number[] };
      expect(c.yaw).to.be.closeTo(30, 1.5);
      expect(c.errorDeg).to.be.above(0).and.below(2);
      expect(c.errors).to.have.length(3);
    });

    it("then aims right: the calibrated setup reproduces the recorded output", () => {
      const c = calibrate(truth, record()) as { yaw: number; tiltOffset: number };
      const target = { x: 3, y: 4, z: 0 };
      const calibrated = aimAt({ ...truth, yaw: c.yaw, tiltOffset: c.tiltOffset }, target) as { pan: number; tilt: number };
      const real = aimAt(truth, target) as { pan: number; tilt: number };
      expect(calibrated.pan).to.be.closeTo(real.pan, 0.002);
      expect(calibrated.tilt).to.be.closeTo(real.tilt, 0.002);
    });

    it("needs at least two marks", () => {
      expect(calibrate(truth, record().slice(0, 1))).to.have.property("error");
    });
  });

  describe("output", () => {
    it("rests at the centre, dark, with the shutter open", () => {
      const { dmx, pos } = setup();
      const b = dmx();
      expect(pos(b, 1)).to.deep.equal([32768, 32768]);
      expect(b[5]).to.equal(0); // dimmer: nothing painted on a lamp-only head
      expect(b[6]).to.equal(0); // shutter « open » value
    });

    it("plays a look's colour on the wheel and its position in 16 bits, with inversion", () => {
      const { show, dmx, pos } = setup();
      show.looks.put({ id: "rouge", name: "Rouge", canvas: "lyres", technique: { kind: "plat", color: "#ff0000" }, move: { shape: "fixe", center: { pan: 0.25, tilt: 0.75 } } });
      show.go("rouge");
      const b = dmx();
      expect(pos(b, 1)).to.deep.equal([16384, 49151]);
      expect(b[4]).to.equal(16); // red slot of the wheel
      expect(b[5]).to.equal(255); // dimmer
      expect(pos(b, 11)[0]).to.equal(Math.round(0.75 * 65535)); // spot-r: pan inverted
    });

    it("reads back where each head points from the output, for the 2D preview (inversions undone)", () => {
      const { venue, show, dmx } = setup();
      const target = { x: 0.5, y: 0, z: 0 };
      expect(show.aim(["spot-l", "spot-r"], target).every((r) => !r.error)).to.equal(true);
      const beams = venue.beams([dmx()]);
      for (const id of ["spot-l", "spot-r"]) {
        const p = venue.fixtures.get(id)!.position!;
        const v = { x: target.x - p.x, y: target.y - p.y, z: target.z - p.z };
        const len = Math.hypot(v.x, v.y, v.z);
        const d = beams[id]!;
        expect((d.x * v.x + d.y * v.y + d.z * v.z) / len, id).to.be.closeTo(1, 1e-3); // 16-bit pan/tilt, rounded to 1/1000
      }
    });

    it("dims a head while its beam crosses a zone no head may point into, whoever aimed it", () => {
      const { show, dmx } = setup();
      show.zones.put({ id: "pupitre", name: "Pupitre", type: "riser", polygon: [[0, -0.5], [1, -0.5], [1, 0.5], [0, 0.5]], floorHeight: 0.2, noAim: true });
      show.looks.put({ id: "rouge", name: "Rouge", canvas: "lyres", technique: { kind: "plat", color: "#ff0000" } });
      show.go("rouge");
      const guarded = () => {
        const b = dmx();
        show.guard([b]);
        return b;
      };
      show.aim(["spot-l"], { x: 0.5, y: 0, z: 1.7 }); // the speaker's face
      expect(guarded()[5]).to.equal(0); // spot-l's dimmer, cut
      expect(show.lastClamps.some((c) => c.fixture === "spot-l" && c.rule === "zone:pupitre")).to.equal(true);
      show.aim(["spot-l"], { x: -2, y: 3, z: 0 }); // the stage floor, away from it
      expect(guarded()[5]).to.equal(255);
      // a look allowed into it opens the zone while it plays
      show.zones.put({ ...show.zones.get("pupitre")!, allowLooks: ["rouge"] });
      show.aim(["spot-l"], { x: 0.5, y: 0, z: 1.7 });
      expect(guarded()[5]).to.equal(255);
    });

    it("shows a lamp head in its wheel colour for the 2D preview", () => {
      const { venue, show, dmx } = setup();
      show.looks.put({ id: "rouge", name: "Rouge", canvas: "lyres", technique: { kind: "plat", color: "#ff0000" } });
      show.go("rouge");
      expect(venue.displayColors([dmx()])["spot-l"]).to.deep.equal(["#ff0000"]);
      show.stop("rouge");
      expect(venue.displayColors([dmx()])["spot-l"]).to.deep.equal(["#000000"]); // dimmer at 0
    });

    it("moves with the beat; a position-only look leaves the colour alone", () => {
      const { show, dmx, advance, pos } = setup();
      show.looks.put({ id: "pan", name: "Balayage", canvas: "lyres", technique: { kind: "aucune" }, move: { shape: "pan", size: { pan: 0.25 }, every: { beats: 4 } } });
      show.go("pan");
      expect(pos(dmx(), 1)[0]).to.equal(32768);
      advance(1); // a quarter of a cycle
      const b = dmx();
      expect(pos(b, 1)[0]).to.equal(Math.round(0.75 * 65535));
      expect(b[5]).to.equal(0); // not painted: dark
    });

    it("lets a manual position win over the looks until it is released", () => {
      const { show, dmx, pos } = setup();
      show.looks.put({ id: "fixe", name: "Fixe", canvas: "lyres", technique: { kind: "aucune" }, move: { shape: "fixe", center: { pan: 0.25, tilt: 0.25 } } });
      show.go("fixe");
      show.setPosition(["spot-l"], { tilt: 1 });
      expect(pos(dmx(), 1)).to.deep.equal([32768, 65535]); // pan defaults to the centre
      expect(show.releasePositions()).to.deep.equal(["spot-l"]);
      expect(pos(dmx(), 1)).to.deep.equal([16384, 16384]);
    });

    it("moves only a group's heads when the look names one", () => {
      const { show, dmx, pos } = setup();
      show.groups.put({ id: "jardin", name: "Jardin", members: { fixtures: ["spot-l"] } });
      show.looks.put({ id: "g", name: "G", canvas: "lyres", technique: { kind: "aucune" }, move: { shape: "fixe", center: { pan: 0 }, group: "jardin" } });
      show.go("g");
      const b = dmx();
      expect(pos(b, 1)[0]).to.equal(0);
      expect(pos(b, 11)[0]).to.equal(32768);
    });

    it("aims a hung head at a point of the stage", () => {
      const { show, dmx, pos } = setup();
      const [res] = show.aim(["spot-l"], { x: -2, y: 2, z: 0 }); // straight down
      expect(res).to.deep.include({ fixture: "spot-l", pan: 0.5, tilt: 0.5 });
      expect(pos(dmx(), 1)).to.deep.equal([32768, 32768]);
      expect(show.aim(["spot-r"], { x: 2, y: 2, z: 5 })[0]).to.have.property("error"); // on the fixture itself
    });

    it("keeps the heads in place on Blackout", () => {
      const { venue, show } = setup();
      show.setPosition(["spot-l"], { pan: 0.25, tilt: 0.25 });
      show.looks.put({ id: "rouge", name: "Rouge", canvas: "lyres", technique: { kind: "plat", color: "#ff0000" } });
      show.go("rouge");
      const engine = new DmxEngine(1);
      engine.setRenderer((buffers) => show.render(buffers));
      engine.setBlackoutKeep(() => venue.positionSlots());
      engine.setBlackout(true);
      const b = engine.render()[0]!;
      expect([b[0], b[2]]).to.deep.equal([64, 64]); // pan/tilt kept
      expect([b[4], b[5]]).to.deep.equal([0, 0]); // wheel and dimmer out
    });
  });
});
