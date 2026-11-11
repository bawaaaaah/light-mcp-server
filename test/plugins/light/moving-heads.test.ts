import { expect } from "chai";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQxf, findMode } from "../../../src/plugins/light/venue/qxf-import.js";
import { MoveSchema, movePosition } from "../../../src/plugins/light/engine/move.js";
import { aimAt, calibrate, type AimSetup, type CalibrationSample } from "../../../src/plugins/light/venue/aim.js";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { emptyFrame, Venue, type ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";
import { ShowRuntime } from "../../../src/plugins/light/show/runtime.js";
import { DmxEngine } from "../../../src/plugins/light/engine/dmx-engine.js";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

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
  return { venue, show, dmx, advance, pos, defs };
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
      expect(venue.beams([buf]).s!.angle).to.equal(40);
      venue.absent = new Set(["s"]);
      expect(venue.beams([buf])).to.deep.equal({}); // not installed for this show: no light, no beam
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

    it("« aléatoire »: each head glides to a new point drawn in the box every cycle, the same way every time", () => {
      const m = move({ shape: "aleatoire", center: { pan: 0.5, tilt: 0.5 }, size: { pan: 0.2, tilt: 0.1 } });
      const path = Array.from({ length: 400 }, (_, i) => movePosition(m, i / 40, 0, 4)); // 10 cycles
      for (const p of path) {
        expect(p.pan).to.be.within(0.3 - 1e-9, 0.7 + 1e-9);
        expect(p.tilt).to.be.within(0.4 - 1e-9, 0.6 + 1e-9);
      }
      // gliding, never jumping
      for (let i = 1; i < path.length; i++) expect(Math.abs(path[i]!.pan - path[i - 1]!.pan)).to.be.below(0.04);
      // a different point every cycle, and for every head
      const at = (c: number, i: number) => { const p = movePosition(m, c, i, 4); return [p.pan, p.tilt].map((v) => v.toFixed(3)).join(); };
      expect(new Set([1, 2, 3, 4].map((c) => at(c, 0))).size).to.equal(4);
      expect(new Set([0, 1, 2, 3].map((i) => at(2, i))).size).to.equal(4);
      expect(movePosition(m, 2.3, 1, 4)).to.deep.equal(movePosition(m, 2.3, 1, 4));
      // wings: a mirrored pair shares its points
      const wings = move({ shape: "aleatoire", size: { pan: 0.2, tilt: 0.1 }, wings: true });
      expect(movePosition(wings, 1.6, 0, 4)).to.deep.equal(movePosition(wings, 1.6, 3, 4));
    });

    it("shuffles the order the heads take their phase in", () => {
      const along = move({ shape: "tapis", size: { tilt: 0.2 }, spread: 1 });
      const mixed = move({ shape: "tapis", size: { tilt: 0.2 }, spread: 1, shuffle: true });
      const tilts = (m: typeof along) => [0, 1, 2, 3, 4, 5].map((i) => movePosition(m, 0.1, i, 6).tilt.toFixed(4));
      // the same phases, given out in another order, the same every time
      expect([...tilts(mixed)].sort()).to.deep.equal([...tilts(along)].sort());
      expect(tilts(mixed)).to.not.deep.equal(tilts(along));
      expect(tilts(mixed)).to.deep.equal(tilts(mixed));
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
      expect(b[4]).to.equal(24); // red slot of the wheel (16..31), at its middle: it holds when the DMX drifts
      expect(b[5]).to.equal(255); // dimmer
      expect(pos(b, 11)[0]).to.equal(Math.round(0.75 * 65535)); // spot-r: pan inverted
    });

    it("keeps a lamp's dimmer up while another look's wheel channel fades in and out", () => {
      const { show, dmx, advance } = setup();
      show.looks.put({ id: "rouge", name: "Rouge", canvas: "lyres", technique: { kind: "plat", color: "#ff0000" } });
      show.looks.put({ id: "ambre", name: "Ambre", canvas: "lyres", technique: { kind: "aucune" }, timing: { entryFade: 2, exitFade: 2 }, channels: { targets: [{ fixture: "spot-l", offset: 4 }], steps: [[64]] } });
      show.go("rouge");
      advance(4);
      expect(dmx()[5]).to.equal(255);
      show.go("ambre");
      const levels: number[] = [];
      for (let i = 0; i < 10; i++) {
        levels.push(dmx()[5]!);
        advance(1);
      }
      show.stop("ambre");
      for (let i = 0; i < 10; i++) {
        levels.push(dmx()[5]!);
        advance(1);
      }
      expect(levels.every((v) => v === 255), levels.join(",")).to.equal(true); // the painting look doses this lamp, at full: the wheel look's weight leaves it alone
    });

    it("fades a lamp once when the look that paints it also holds its wheel", () => {
      const { show, dmx, advance } = setup();
      show.looks.put({ id: "blanc", name: "Blanc", canvas: "lyres", technique: { kind: "plat", color: "#ffffff" }, timing: { exitFade: 2 }, channels: { targets: [{ fixture: "spot-l", offset: 4 }], steps: [[64]] } });
      show.go("blanc");
      advance(4);
      expect([dmx()[4], dmx()[5]]).to.deep.equal([64, 255]);
      show.stop("blanc");
      advance(2); // 1 s of the 2 s fade: weight 0.5
      expect(dmx()[4]).to.equal(64); // the wheel holds its slot
      expect(dmx()[5]).to.equal(128); // the painted level carries the look's weight once, not twice (64)
    });

    describe("a colour wheel under the real runtime (T18)", () => {
      const RED = 15;
      const BLUE = 65; // the middles of their slots
      /** A lamp with a ten-colour wheel (test/fixtures/wheel-spot.qxf: wheel offset 2, dimmer 3) alone on a canvas, looks A red and B blue (B rising over 2 s). */
      function spot(wheel?: object) {
        const t = setup();
        copyFileSync(new URL("../../fixtures/wheel-spot.qxf", import.meta.url), join(t.defs, "wheel-spot.qxf"));
        t.venue.refreshDefinitions();
        t.venue.fixtures.put({ id: "roue", name: "Roue", manufacturer: "Test", model: "Wheel Spot", mode: "Standard", universe: 1, address: 30, ...(wheel ? { overrides: { wheel } } : {}) });
        t.venue.canvases.put({ id: "seule", name: "Seule", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "roue", head: -1 }] }] });
        t.show.looks.put({ id: "a", name: "A", canvas: "seule", technique: { kind: "plat", color: "#ff0000" } });
        t.show.looks.put({ id: "b", name: "B", canvas: "seule", technique: { kind: "plat", color: "#0000ff" }, timing: { entryFade: 2 } });
        /** The wheel and the dimmer of the real output, `count` frames `ms` apart. */
        const sample = (count: number, ms = 50) => {
          const frames: { wheel: number; dimmer: number }[] = [];
          for (let i = 0; i < count; i++) {
            const b = t.dmx();
            frames.push({ wheel: b[29 + 2]!, dimmer: b[29 + 3]! });
            t.advance(ms / 500);
          }
          return frames;
        };
        return { ...t, sample };
      }
      /** A and B in one exclusive group: B comes in over A, a crossfade of 2 s sampled every 100 ms. */
      function crossfade(wheel?: object) {
        const t = spot(wheel);
        t.show.groups.put({ id: "ex", name: "Ex", exclusive: true, members: { looks: ["a", "b"] } });
        t.show.go("a");
        t.advance(4);
        t.show.go("b");
        return t.sample(21, 100);
      }
      const wheels = (frames: { wheel: number }[]) => [...new Set(frames.map((f) => f.wheel))];

      it("crossfade: turns the wheel once, at mid-fade, never through the colours between (magenta)", () => {
        const frames = crossfade();
        expect(wheels(frames)).to.deep.equal([RED, BLUE]);
        const turn = frames.findIndex((f) => f.wheel === BLUE);
        expect(turn).to.equal(10); // 1 s of the 2 s fade: B lights as much as A
        expect(frames[turn - 1]!.dimmer).to.be.above(120); // the lamp dips to half (its level is that of the mixed colour), never to black
      });

      it("a look started over another (« last »): the wheel follows the colour that wins, from the first frame, in the dark", () => {
        const t = spot();
        t.show.go("a");
        t.advance(4);
        expect(t.sample(1)[0]).to.deep.equal({ wheel: RED, dimmer: 255 });
        t.show.go("b"); // no exclusive group: B covers A where it paints, rising from black
        const frames = t.sample(60); // 3 s, every 50 ms
        expect(wheels(frames)).to.deep.equal([BLUE]); // never red under B's rising light
        expect(frames[0]!.dimmer).to.equal(0);
        expect(frames.every((f, i, all) => i === 0 || f.dimmer >= all[i - 1]!.dimmer)).to.equal(true);
        expect(frames[59]!.dimmer).to.equal(255);
      });

      it("a blue / black chase over a red background (« last »): the wheel stays on blue through the black steps", () => {
        const t = spot();
        t.show.looks.put({ id: "chase", name: "Chase", canvas: "seule", technique: { kind: "pas", steps: [["#0000ff"], ["#000000"]] }, timing: { every: { beats: 1 }, attack: 0 } });
        t.show.go("a");
        t.advance(4);
        t.show.go("chase");
        const frames = t.sample(160, 25); // 4 s at 120 bpm: 8 steps
        expect(wheels(frames)).to.deep.equal([BLUE]);
        expect(wheels(frames.filter((f) => f.dimmer === 0))).to.deep.equal([BLUE]); // the black steps are there, and the wheel does not move
        expect(frames.some((f) => f.dimmer === 0) && frames.some((f) => f.dimmer === 255)).to.equal(true);
      });

      it("« highest »: the look painting the most light holds the wheel (black never darkens: red shows on the chase's black step)", () => {
        const t = spot();
        t.show.settings = { ...t.show.settings, looksMerge: "highest" };
        t.show.looks.put({ id: "chase", name: "Chase", canvas: "seule", technique: { kind: "pas", steps: [["#0000ff"], ["#000000"]] }, timing: { every: { beats: 1 }, attack: 0 } });
        t.show.go("a");
        t.advance(4);
        t.show.go("chase");
        const frames = t.sample(80, 25);
        expect(frames.every((f) => f.dimmer === 255)).to.equal(true);
        expect(wheels(frames)).to.deep.equal([BLUE, RED]); // blue on its step (the later look on equal levels), red on the black one
      });

      it("pre-positions the wheel in the dark: a look rising from black, and one whose master is at zero", () => {
        const t = spot();
        t.show.go("a");
        t.advance(4);
        t.show.stop("a");
        t.show.go("b");
        const frames = t.sample(4, 25);
        expect(frames[0]).to.deep.equal({ wheel: BLUE, dimmer: 0 }); // the first frame of the rise: already on blue
        expect(wheels(frames)).to.deep.equal([BLUE]);
        // a master at zero: the look still asks its colour
        const m = spot();
        m.show.groups.put({ id: "g", name: "G", master: { level: 0, mute: false }, members: { looks: ["a"] }, presets: { included: ["a"], excluded: [] } });
        m.show.go("a");
        expect(m.sample(1)[0]).to.deep.equal({ wheel: RED, dimmer: 0 });
      });

      it("« au noir »: dark while the wheel turns (changeMs), lit again after — two looks painting the fixture do not keep it dark", () => {
        const t = spot({ change: "black" });
        t.show.go("a");
        t.advance(4);
        expect(t.sample(1)[0]).to.deep.equal({ wheel: RED, dimmer: 255 }); // the first slot taken is no change
        t.show.looks.put({ id: "c", name: "C", canvas: "seule", technique: { kind: "plat", color: "#00ff00" } });
        t.show.go("c"); // at once over A, both at weight 1 from now on
        const frames = t.sample(40, 25); // 1 s
        expect(wheels(frames)).to.deep.equal([45]); // green
        expect(frames.slice(0, 12).every((f) => f.dimmer === 0), "dark for 300 ms").to.equal(true);
        expect(frames.slice(12).every((f) => f.dimmer === 255), "then lit, for good").to.equal(true);
        // the time is the model's
        const quick = spot({ change: "black", changeMs: 100 });
        quick.show.looks.put({ id: "c", name: "C", canvas: "seule", technique: { kind: "plat", color: "#00ff00" } });
        quick.show.go("a");
        quick.advance(4);
        quick.sample(1);
        quick.show.go("c");
        expect(quick.sample(8, 25).map((f) => f.dimmer)).to.deep.equal([0, 0, 0, 0, 255, 255, 255, 255]);
      });

      it("« au noir » in a crossfade: down to black ahead of the change, dark while the wheel turns, then back up", () => {
        const frames = crossfade({ change: "black" });
        expect(wheels(frames)).to.deep.equal([RED, BLUE]);
        expect(frames[0]!.dimmer).to.equal(255);
        expect(frames[9]!.dimmer).to.be.below(frames[8]!.dimmer);
        expect(frames.slice(10, 13).map((f) => f.dimmer)).to.deep.equal([0, 0, 0]); // the change at 1 s, then 300 ms
        expect(frames.slice(0, 11).every((f, i, all) => i === 0 || f.dimmer <= all[i - 1]!.dimmer)).to.equal(true);
        expect(frames.slice(12).every((f, i, all) => i === 0 || f.dimmer >= all[i - 1]!.dimmer)).to.equal(true);
        expect(frames[20]!.dimmer).to.equal(255);
      });

      it("forgets what was asked once nothing is painted, and the wheel of a fixture deleted", () => {
        const t = spot();
        t.show.go("a");
        t.sample(1);
        expect(t.show.explainChannel(1, 32).wheel).to.deep.include({ slot: "Red", asked: "#ff0000", gap: 0 });
        t.show.stop("a");
        t.sample(1);
        expect(t.show.explainChannel(1, 32).wheel).to.deep.equal({ slot: "Red", color: "#ff0000", gap: 0 }); // the slot held, no colour asked any more
        const held = new Map([["roue", { slot: 10, gap: 0 }], ["gone", { slot: 10, gap: 0 }]]);
        t.venue.toDmx(emptyFrame(), [new Uint8Array(512)], held);
        expect([...held.keys()]).to.deep.equal(["roue"]);
      });
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

    it("moves a head no faster than its speed rule, toward what is asked", () => {
      const { show, dmx, advance, pos } = setup();
      show.rules.put({ id: "doux", name: "Doux", level: "venue", scope: { fixture: "spot-l" }, target: {}, maxDegPerSecond: 90, locked: false });
      const guarded = () => {
        const b = dmx();
        show.guard([b]);
        return pos(b, 1)[0]! / 65535;
      };
      expect(guarded()).to.be.closeTo(0.5, 1e-4); // at rest, the centre
      show.setPosition(["spot-l"], { pan: 1, tilt: 0.5 }); // the far end: 270° of pan away
      advance(1); // half a second
      expect(guarded()).to.be.closeTo(0.5 + 45 / 540, 1e-3); // 45° in half a second
      advance(4);
      expect(guarded()).to.be.closeTo(0.5 + 225 / 540, 1e-3);
      advance(2);
      expect(guarded()).to.be.closeTo(1, 1e-4); // there, not beyond
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
      // the slot is found by its range: a raw look writing its first or last value shows it too
      for (const v of [16, 31]) {
        const b = dmx();
        b[4] = v;
        expect(venue.displayColors([b])["spot-l"], String(v)).to.deep.equal(["#ff0000"]);
      }
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

    it("keeps no slot of an absent head on Blackout: there an installed fixture may hold its dimmer", () => {
      const { venue, show } = setup();
      expect(venue.positionSlots().get(1)).to.include.members([0, 1, 2, 3, 10]);
      show.saveSettings({ absentFixtures: ["spot-r"] });
      expect(venue.positionSlots().get(1)).to.deep.equal([0, 1, 2, 3]); // spot-l's pan/tilt only
    });
  });
});

describe("a head driven by the command layer (the pad's path)", () => {
  let plugin: LightPlugin;
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  const render = () => plugin.engine.render()[0]!;
  /** 16-bit value of a channel (1-based coarse address). */
  const at = (b: Uint8Array, channel: number) => (b[channel - 1]! << 8) | b[channel]!;

  before(async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-heads-cmd-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), join(dataRoot, "fixtures", "spot.qxf"));
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    copyFileSync(new URL("../../fixtures/wheel-spot.qxf", import.meta.url), join(dataRoot, "fixtures", "wheel-spot.qxf"));
    writeFileSync(
      join(dataRoot, "fixtures", "cheap-head.qxf"),
      `<?xml version="1.0" encoding="UTF-8"?>
<FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition">
 <Manufacturer>Test</Manufacturer>
 <Model>Cheap Head</Model>
 <Type>Moving Head</Type>
 <Channel Name="Pan"><Group Byte="0">Pan</Group></Channel>
 <Channel Name="Tilt"><Group Byte="0">Tilt</Group></Channel>
 <Channel Name="Dimmer" Preset="IntensityMasterDimmer"/>
 <Mode Name="Standard">
  <Channel Number="0">Pan</Channel>
  <Channel Number="1">Tilt</Channel>
  <Channel Number="2">Dimmer</Channel>
 </Mode>
</FixtureDefinition>
`,
    );
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    await run("venue.fixture.put", { fixture: { id: "spot", name: "Lyre", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: 0, y: 2, z: 5 }, mount: "hung" } });
    await run("venue.fixture.put", { fixture: { id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 30 } });
    await run("venue.fixture.put", { fixture: { id: "cheap", name: "Lyre à pas cher", manufacturer: "Test", model: "Cheap Head", mode: "Standard", universe: 1, address: 40 } });
    await run("venue.fixture.put", { fixture: { id: "roue", name: "Lyre à roue", manufacturer: "Test", model: "Wheel Spot", mode: "Standard", universe: 1, address: 60 } });
  });

  it("finds or creates the fader of one channel at its first touch (the fixture panel's path)", async () => {
    // on a colour fixture's master dimmer the fader doses what the show holds: created at 1, it changes
    // nothing — even with the dimmer at half by the grand master (a fader at 0.5 would halve it again)
    await run("grandmaster.set", { level: 0.5 });
    const before = render()[29];
    expect(before).to.be.within(120, 135);
    const master = (await run("fader.channel", { fixture: "bar", offset: 0 })) as { id: string; level: number };
    expect(master.level).to.equal(1);
    expect(render()[29]).to.equal(before);
    await run("grandmaster.set", { level: 1 });
    render();
    const now = (plugin.engine.output.get(1)[41] ?? 0) / 255; // the cheap head's dimmer as it goes out
    await run("fader.put", { fader: { id: "panel-cheap-2", name: "Deux canaux", channels: [{ fixture: "cheap", offset: 2 }, { fixture: "bar", offset: 0 }], level: 0 } });
    const made = (await run("fader.channel", { fixture: "cheap", offset: 2 })) as { id: string; level: number; created: boolean; channels: unknown[] };
    expect(made.created).to.equal(true);
    expect(made.id).to.equal("panel-cheap-2-2"); // the id in the way is not this one channel's: another one
    expect(made.channels).to.deep.equal([{ fixture: "cheap", offset: 2 }]);
    expect(made.level).to.be.closeTo(now, 0.001); // created at what the channel has now: nothing switches off
    const again = (await run("fader.channel", { fixture: "cheap", offset: 2, level: 0.2 })) as { id: string; level: number; created: boolean };
    expect([again.id, again.created, again.level]).to.deep.equal([made.id, false, made.level]); // found, left as it is
    // a fader narrowed to a function of the channel (T12) is not the channel's own: another one is made
    await run("fader.put", { fader: { id: "roue-verte", name: "Roue verte", channels: [{ fixture: "spot", offset: 4 }], level: 0, range: { min: 32, max: 47 } } });
    const free = (await run("fader.channel", { fixture: "spot", offset: 4 })) as { id: string; created: boolean };
    expect([free.id, free.created]).to.deep.equal(["panel-spot-4", true]);
    for (const id of ["roue-verte", "panel-spot-4"]) await run("fader.delete", { id, force: true });
    const asked = (await run("fader.channel", { fixture: "cheap", offset: 1, level: 0.4 })) as { level: number };
    expect(asked.level).to.equal(0.4);
    let refused = "";
    await run("fader.channel", { fixture: "nope", offset: 0 }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("nope");
    for (const id of [made.id, master.id, "panel-cheap-1", "panel-cheap-2"]) await run("fader.delete", { id, force: true });
  });

  it("inverts the DMX it sends per axis through venue.fixture.orient, and points the same read back both ways", async () => {
    const pointed = () => plugin.venue.pointingOf(plugin.venue.resolve("spot") as ResolvedFixture, render());
    await run("position.set", { fixtures: ["spot"], pan: 0.25, tilt: 0.75 });
    expect(at(render(), 1)).to.be.closeTo(0.25 * 65535, 1);
    expect(at(render(), 3)).to.be.closeTo(0.75 * 65535, 1);
    await run("venue.fixture.orient", { id: "spot", invertPan: true });
    expect(at(render(), 1)).to.be.closeTo(0.75 * 65535, 1); // pan flipped on its output channel
    expect(at(render(), 3)).to.be.closeTo(0.75 * 65535, 1); // tilt untouched
    const whileInverted = pointed();
    await run("venue.fixture.orient", { id: "spot", invertPan: false, invertTilt: true });
    expect(at(render(), 1)).to.be.closeTo(0.25 * 65535, 1);
    expect(at(render(), 3)).to.be.closeTo(0.25 * 65535, 1); // tilt flipped as well now
    expect(pointed()).to.deep.equal(whileInverted); // the read-back undoes whatever the wiring flips
    await run("venue.fixture.orient", { id: "spot", invertTilt: false });
    expect(at(render(), 3)).to.be.closeTo(0.75 * 65535, 1);
    expect(pointed()).to.deep.equal(whileInverted);
    await run("position.release", { fixtures: ["spot"] });
    expect(at(render(), 1)).to.be.closeTo(0.5 * 65535, 1); // back to the centre
  });

  it("doses a fixture's dimmer through fader.put then fader.level, one channel, never a DCA", async () => {
    await run("fader.put", { fader: { id: "panel-bar-0", name: "Panneau Barre · Dimmer", channels: [{ fixture: "bar", offset: 0 }], level: 0.4 } });
    expect(render()[29]).to.equal(Math.round(0.4 * 255)); // the Bar's dimmer (channel 30): the fader doses it
    await run("fader.level", { id: "panel-bar-0", level: 0.8 });
    expect(render()[29]).to.equal(Math.round(0.8 * 255));
  });

  it("sets a wheel's colour → slot correspondence per model, overridable per fixture (venue.wheel.*)", async () => {
    const venue = plugin.runtime.venue;
    venue.canvases.put({ id: "roue", name: "Roue", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "roue", head: -1 }] }] });
    plugin.runtime.looks.put({ id: "roue-rouge", name: "Roue rouge", canvas: "roue", technique: { kind: "plat", color: "#ff0000" } });
    plugin.runtime.go("roue-rouge");
    const wheel = () => render()[60 - 1 + 2];
    try {
      expect(wheel()).to.equal(15); // the red slot (10..19), at its middle
      await run("venue.wheel.put", { id: "roue", scope: "model", wheel: { slots: { "20": { answers: ["#FF0000"] } } } });
      expect(wheel()).to.equal(25); // red answered by the orange slot, for every fixture of the model, at once
      await run("venue.wheel.put", { id: "roue", scope: "fixture", wheel: { slots: { "70": { answers: ["#ff0000"] } } } });
      expect(wheel()).to.equal(75); // this fixture's own settings replace the model's
      const got = (await run("venue.wheel.get", { id: "roue" })) as { applies: string; model: unknown; own: unknown; slots: { min: number; value: number; name: string; color?: string; color2?: string; open?: boolean; colorless?: boolean }[] };
      expect(got.applies).to.equal("fixture");
      expect(got.model).to.deep.equal({ slots: { "20": { answers: ["#ff0000"] } } });
      expect(got.slots[0]).to.deep.include({ min: 0, value: 5, color: "#ffffff", open: true });
      expect(got.slots.find((s) => s.min === 100)).to.deep.include({ color: "#ff0000", color2: "#00ff00" });
      // every range of the wheel channel is listed, the one without colour marked: it can be given one
      expect(got.slots.find((s) => s.min === 110)).to.deep.include({ name: "Rainbow", colorless: true });
      await run("venue.wheel.put", { id: "roue", scope: "fixture", wheel: { slots: { "70": { answers: ["#ff0000"] }, "110": { color: "#8000FF" } } } });
      expect((plugin.runtime.venue.resolve("roue") as ResolvedFixture).wheel!.slots.find((s) => s.min === 110)).to.include({ name: "Rainbow" });
      await run("venue.wheel.put", { id: "roue", scope: "fixture", wheel: { slots: { "016": { off: true } } } }).then(
        () => expect.fail("a key with a leading zero is refused"),
        () => undefined,
      );
      const explained = (await run("dmx.explain", { universe: 1, channel: 62 })) as { wheel?: { slot: string; asked?: string; gap: number } };
      expect(explained.wheel).to.deep.include({ slot: "Magenta", asked: "#ff0000" });
      expect(explained.wheel!.gap).to.be.above(0.1); // what the stage shows (magenta) is far from what was asked
      await run("venue.wheel.clear", { id: "roue", scope: "fixture" });
      expect(wheel()).to.equal(25);
      await run("venue.wheel.clear", { id: "roue", scope: "model" });
      expect(wheel()).to.equal(15);
      expect(venue.models.list()).to.deep.equal([]); // nothing left of the model's overrides
      await run("venue.wheel.put", { id: "roue", scope: "model", wheel: { slots: { "21": { off: true } } } }).then(
        () => expect.fail("an unknown slot is refused"),
        (e: Error) => expect(e.message).to.match(/21/),
      );
      expect(await run("venue.wheel.get", { id: "bar" })).to.equal(null); // a bar has no wheel: nothing to set (the menu shows no entry)
      await run("venue.wheel.clear", { id: "bar", scope: "model" }).then(
        () => expect.fail("a bar has no wheel"),
        (e: Error) => expect(e.message).to.match(/roue|wheel/),
      );
    } finally {
      plugin.runtime.stop("roue-rouge");
    }
  });

  it("says which fixtures carry pan or tilt: the invert switches live on these only", async () => {
    const rows = (await run("venue.fixture.list")) as { id: string; movable?: boolean }[];
    expect(rows.find((r) => r.id === "spot")!.movable).to.equal(true); // a moving head (PositionPan presets)
    expect(rows.find((r) => r.id === "cheap")!.movable).to.equal(true); // a head whose Pan/Tilt are named channels in groups, without a preset
    expect(rows.find((r) => r.id === "bar")).to.not.have.property("movable"); // a bar without pan/tilt
  });
});
