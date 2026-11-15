import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { aimAt, aimNear, correctionOf, type AimSetup, type Correction } from "../../../src/plugins/light/venue/aim.js";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { Venue, type ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";
import { MoveSchema } from "../../../src/plugins/light/engine/move.js";
import { moveBeyondStops } from "../../../src/plugins/light/venue/stops-check.js";

const fixtureFile = new URL("../../fixtures/spot.qxf", import.meta.url);
/** A hung head turned 30°, as the reviewer's scenarios have it. */
const HUNG = { yaw: 30, pitch: -90, roll: 0, invertPan: false, invertTilt: false, swapPanTilt: false, panOffset: 0, tiltOffset: 0 };

/** A plugin with one moving head « lyre » (16-bit, 540° / 270°), the frame `calibration.*` waits for rendered on demand. */
async function withHead(orientation: object) {
  const dataRoot = join(mkdtempSync(join(tmpdir(), "light-stops-")), "data");
  mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
  copyFileSync(fixtureFile, join(dataRoot, "fixtures", "spot.qxf"));
  const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
  const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  await run("venue.fixture.put", { fixture: { id: "lyre", name: "Lyre", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: 2, y: 3, z: 5 }, mount: "hung", orientation } });
  const hooks = { beforeFrame: () => {} };
  (plugin as unknown as { nextFrame: () => Promise<boolean> }).nextFrame = () => {
    hooks.beforeFrame();
    plugin.engine.render();
    return Promise.resolve(true);
  };
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) plugin.engine.render();
  };
  const bytes = () => [...plugin.engine.output.get(1).slice(0, 4)];
  return { plugin, run, frames, bytes, hooks };
}

/** A refusal's message. */
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => expect.fail("refused expected"),
    (e: Error) => e.message,
  );

describe("useful stops and manual calibration: review fixes (T8)", () => {
  it("« Vérifier le show » does not fail on a look whose move names a canvas or a group gone", async () => {
    const { plugin, run } = await withHead({ ...HUNG, limits: { pan: [-30, 30] } });
    // stored as an older show could have them: the references are said by the unknown-reference checks
    plugin.runtime.looks.put({ id: "l1", name: "L1", canvas: "gone", technique: { kind: "aucune" }, move: MoveSchema.parse({ shape: "cercle", size: { pan: 0.3, tilt: 0.1 } }) } as never);
    const issues = ((await run("show.lint")) as { issues: { where: string; message: string }[] }).issues;
    expect(issues.some((i) => i.where === "look l1")).to.equal(true);
    plugin.runtime.looks.put({ id: "l1", name: "L1", canvas: "gone", technique: { kind: "aucune" }, move: MoveSchema.parse({ shape: "cercle", size: { pan: 0.3, tilt: 0.1 }, group: "nope" }) } as never);
    expect(await run("show.lint")).to.have.property("issues");
  });

  it("records and corrects on a head the pad pushed against a stop: arrived at the stop, said so", async () => {
    const { plugin, run, frames } = await withHead({ ...HUNG, limits: { pan: [-30, 30] } });
    await run("position.set", { fixtures: ["lyre"], pan: 0.9, tilt: 0.6 });
    frames(50);
    expect(plugin.runtime.sentPosition("lyre")!.pan).to.be.closeTo(30 / 540 + 0.5, 1 / 65535);
    const recorded = (await run("calibration.record", { fixture: "lyre", point: { x: 0, y: 1, z: 0 } })) as { samples: number; note?: string };
    expect(recorded.samples).to.equal(1);
    expect(recorded.note).to.match(/au-delà de la butée/);
    const corrected = (await run("calibration.correct", { fixture: "lyre", point: { x: 0, y: 1, z: 0 } })) as { note?: string };
    expect(corrected.note).to.match(/au-delà de la butée/);
    // within the stops: no note
    await run("position.set", { fixtures: ["lyre"], pan: 0.52, tilt: 0.6 });
    frames(50);
    expect(await run("calibration.record", { fixture: "lyre", point: { x: 0, y: 1, z: 0 } })).to.not.have.property("note");
  });

  it("refuses the precise reason when a look holds the head", async () => {
    const { run, frames } = await withHead(HUNG);
    await run("venue.canvas.put", { canvas: { id: "c1", name: "C1", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "lyre", head: -1 }] }] } });
    await run("look.put", { look: { id: "fixe", name: "Fixe", canvas: "c1", technique: { kind: "aucune" }, move: { shape: "fixe", center: { pan: 0.4, tilt: 0.6 }, fade: { seconds: 0 } } } });
    await run("look.go", { id: "fixe" });
    frames(5);
    expect(await refusal(run("calibration.correct", { fixture: "lyre", point: { x: 0, y: 1, z: 0 } }))).to.match(/un look la déplace/);
    expect(await refusal(run("calibration.record", { fixture: "lyre", point: { x: 0, y: 1, z: 0 } }))).to.match(/un look la déplace/);
  });

  it("aims the mark again from where the hand holds the head: no half turn after apply (reviewer's scenario)", async () => {
    const { run } = await withHead(HUNG);
    const believed: AimSetup = { position: { x: 2, y: 3, z: 5 }, hung: true, yaw: 30, panMax: 540, tiltMax: 270, panOffset: 0, tiltOffset: 0 };
    const truth = { ...believed, yaw: 38 };
    const mark = { x: -6, y: -3.25, z: 0 };
    const first = aimAt(believed, mark) as { pan: number; tilt: number };
    const held = aimNear(truth, mark, first) as { pan: number; tilt: number };
    const c = correctionOf(believed, mark, held) as Correction;
    // the solution closest to the centre with the new offsets is half a turn away: the trap
    const centred = aimAt({ ...believed, panOffset: c.panOffset, tiltOffset: c.tiltOffset }, mark) as { pan: number };
    expect(Math.abs(centred.pan - held.pan) * 540).to.be.above(90);
    await run("position.aim", { fixtures: ["lyre"], point: mark });
    await run("position.set", { fixtures: ["lyre"], pan: held.pan, tilt: held.tilt });
    const done = (await run("calibration.correct", { fixture: "lyre", point: mark, apply: true })) as { aimed: { pan: number; tilt: number } };
    expect(Math.abs(done.aimed.pan - held.pan) * 540).to.be.below(0.5);
    expect(Math.abs(done.aimed.tilt - held.tilt) * 270).to.be.below(0.5);
  });

  it("computes the correction on the patch as it is once the frame is rendered", async () => {
    const { plugin, run, hooks } = await withHead(HUNG);
    const mark = { x: 0, y: 1, z: 0 };
    await run("position.aim", { fixtures: ["lyre"], point: mark });
    // the tilt offset changes while the command waits for its frame (another client)
    hooks.beforeFrame = () => {
      const f = plugin.venue.fixtures.get("lyre")!;
      plugin.venue.fixtures.put({ ...f, orientation: { ...f.orientation!, tiltOffset: 5 } });
      hooks.beforeFrame = () => {};
    };
    const c = (await run("calibration.correct", { fixture: "lyre", point: mark, apply: true })) as Correction;
    expect(c.tiltOffsetDelta).to.be.closeTo(-5, 0.01); // measured from 5, the offset now stored
    expect(c.tiltOffset).to.be.closeTo(0, 0.01);
    expect(plugin.venue.fixtures.get("lyre")!.orientation!.tiltOffset).to.be.closeTo(0, 0.01);
  });

  it("bounds what a channel fader writes on pan after the motion layer, the DMX console excepted", async () => {
    const { run, frames, bytes } = await withHead({ ...HUNG, limits: { pan: [-30, 30] } });
    await run("position.set", { fixtures: ["lyre"], pan: 0.5, tilt: 0.5 });
    frames(5);
    await run("fader.put", { fader: { id: "pan-brut", name: "Pan brut", channels: [{ fixture: "lyre", offset: 0 }], level: 1 } });
    frames(5);
    const hi = Math.round((30 / 540 + 0.5) * 65535);
    const [c, f] = bytes();
    expect((c! << 8) | f!).to.be.at.most(hi);
  });

  it("refuses a stop given beyond the travel, and the show check names one left there by a travel corrected since", async () => {
    const { run } = await withHead(HUNG);
    expect(await refusal(run("venue.fixture.orient", { id: "lyre", limits: { pan: [-300, 0] } }))).to.match(/hors de la course/);
    await run("venue.fixture.orient", { id: "lyre", limits: { pan: [-260, 260] } });
    await run("venue.fixture.travel.set", { fixture: "lyre", scope: "fixture", panMax: 500 });
    const issues = ((await run("show.lint")) as { issues: { where: string; message: string }[] }).issues;
    expect(issues.filter((i) => i.where === "lyre lyre" && /hors de la course/.test(i.message))).to.have.length(1);
  });
});

describe("useful stops at the output (T8): inversion, swap, 8-bit", () => {
  function venueWith(orientation: object, mode = "Standard") {
    const dir = mkdtempSync(join(tmpdir(), "light-stops-out-"));
    const defs = join(dir, "fixtures");
    mkdirSync(defs);
    copyFileSync(fixtureFile, join(defs, "spot.qxf"));
    const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
    venue.fixtures.put({ id: "h", name: "H", manufacturer: "Test", model: "Spot 7", mode, universe: 1, address: 1, orientation: { yaw: 0, invertPan: false, invertTilt: false, swapPanTilt: false, panOffset: 0, tiltOffset: 0, ...orientation } });
    const r = venue.resolve("h") as ResolvedFixture;
    const write = (p: { pan: number; tilt: number }) => {
      const out = new Map<number, number>();
      venue.writePosition(r, p, (o, v) => out.set(o, v));
      return out;
    };
    return { venue, r, write };
  }
  const v16 = (m: Map<number, number>, coarse: number) => (m.get(coarse)! << 8) | m.get(coarse + 1)!;

  it("bounds before inverting: an asymmetric stop on an inverted pan", () => {
    const { write } = venueWith({ invertPan: true, limits: { pan: [-30, 120] } });
    expect(v16(write({ pan: 1, tilt: 0.5 }), 0)).to.equal(65535 - Math.round((120 / 540 + 0.5) * 65535));
    expect(v16(write({ pan: 0, tilt: 0.5 }), 0)).to.equal(65535 - Math.round((-30 / 540 + 0.5) * 65535));
  });

  it("bounds the logical axes, then swaps: the pan stop holds on the tilt channel", () => {
    const { write } = venueWith({ swapPanTilt: true, limits: { pan: [-30, 30] } });
    const out = write({ pan: 1, tilt: 0.25 });
    expect(v16(out, 2)).to.equal(Math.round((30 / 540 + 0.5) * 65535)); // the logical pan, on the tilt channel
    expect(v16(out, 0)).to.equal(Math.round(0.25 * 65535)); // the logical tilt, untouched
  });

  it("keeps an 8-bit axis inside its stops: the byte is brought back in rather than truncated past the low stop", () => {
    for (const invertPan of [false, true]) {
      const { venue, r, write } = venueWith({ invertPan, limits: { pan: [-100.3, 100.3] } }, "Basic");
      for (const pan of [0, 1]) {
        const read = venue.readPosition(r, (o) => write({ pan, tilt: 0.5 }).get(o)).pan!;
        const deg = (read - 0.5) * 360;
        expect(deg, `invertPan ${invertPan}, pan ${pan}`).to.be.within(-100.3, 100.3);
        expect(Math.abs(Math.abs(deg) - 100.3)).to.be.below(360 / 255 + 1e-9); // and within one step of it
      }
    }
  });
});

describe("show check of a move against the stops (T8): the box of the move", () => {
  const stops = { panMax: 540, tiltMax: 270, limits: { pan: [-54, 54] as const } }; // ± 0.1 of the travel
  const move = (m: object) => MoveSchema.parse(m);

  it("« aléatoire »: within the box is fine, a box past a stop is named whatever the cycles drawn", () => {
    expect(moveBeyondStops(move({ shape: "aleatoire", size: { pan: 0.09, tilt: 0.4 } }), [stops])).to.deep.equal([]);
    expect(moveBeyondStops(move({ shape: "aleatoire", size: { pan: 0.11, tilt: 0 } }), [stops])).to.deep.equal([0]);
    // with a spread and a fan: the last head's box is shifted past the stop, the first is not
    expect(moveBeyondStops(move({ shape: "aleatoire", size: { pan: 0.05, tilt: 0 }, spread: 0.5, fan: 0.06 }), [stops, stops, stops])).to.deep.equal([0, 2]);
  });

  it("a drawn shape is sampled when its box passes a stop: a pan wave leaves the tilt alone", () => {
    const tiltStops = { panMax: 540, tiltMax: 270, limits: { tilt: [-27, 27] as const } };
    expect(moveBeyondStops(move({ shape: "pan", size: { pan: 0.3, tilt: 0.4 } }), [tiltStops])).to.deep.equal([]);
    expect(moveBeyondStops(move({ shape: "cercle", size: { pan: 0.3, tilt: 0.4 } }), [tiltStops])).to.deep.equal([0]);
    expect(moveBeyondStops(move({ shape: "fixe", size: { pan: 0.4, tilt: 0.4 } }), [stops])).to.deep.equal([]);
  });
});

describe("correctionOf (T8): the held position on the other solution", () => {
  const believed: AimSetup = { position: { x: 2, y: 3, z: 5 }, hung: true, yaw: 30, panMax: 540, tiltMax: 270, panOffset: 0, tiltOffset: 0 };
  const truth: AimSetup = { ...believed, yaw: 37, tiltOffset: 3 };
  for (const mark of [{ x: 0, y: 1, z: 0 }, { x: 5, y: 6, z: 0 }, { x: -3, y: -2, z: 0 }])
    it(`a head held on the other solution (pan ± 180°, −tilt) at ${JSON.stringify(mark)}: the nearest candidate, the pan offset wrapped`, () => {
      const one = aimAt(truth, mark) as { panDeg: number; tiltDeg: number };
      // the same direction, from the other side: (pan ± 180°, −tilt), physical angles then back to logical ones
      const physPan = one.panDeg + truth.panOffset;
      const physTilt = one.tiltDeg + truth.tiltOffset;
      const otherPan = physPan > 0 ? physPan - 180 : physPan + 180;
      const held = { pan: otherPan / 540 + 0.5, tilt: (-physTilt - truth.tiltOffset) / 270 + 0.5 };
      expect(Math.sign(held.tilt - 0.5)).to.equal(-Math.sign(one.tiltDeg)); // the other side of the base axis
      const c = correctionOf(believed, mark, held) as Correction;
      expect(c.afterDeg).to.be.below(0.2);
      expect(c.beforeDeg).to.be.above(2);
      expect(Math.abs(c.panOffsetDelta)).to.be.closeTo(7, 0.05);
      expect(c.panOffset).to.be.within(-180, 180);
      expect(c.tiltOffsetDelta).to.be.closeTo(3, 0.05); // the same offset, whichever side it holds
    });
});
