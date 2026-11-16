import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import type { Position } from "../../../src/plugins/light/engine/move.js";
import { PositionPresetSchema } from "../../../src/plugins/light/show/model.js";
import { usesOf } from "../../../src/plugins/light/show/references.js";
import { ShowRuntime } from "../../../src/plugins/light/show/runtime.js";
import { speedLimits } from "../../../src/plugins/light/rules/rules.js";
import { ZoneSchema, zoneAimPoint } from "../../../src/plugins/light/venue/stage.js";
import { Venue, type ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";

/**
 * Looks aimed at a zone and looks along a path in the engine (T28; docs/specs/engine-effects-timing.md, « Parcours »):
 * claims of the look layer like any move (manual and targets above), one stop per step reached and held, no jump, a
 * stop a head cannot reach holding that head alone, the same look replaying the same bytes, and the warnings said ahead.
 *
 * Two hung heads: « spot16 » (540°/270°, 16-bit, at x −2) and « spot8 » (360°/180°, 8-bit, at x +2). One frame every 20 ms.
 */
interface Frame {
  buf: Uint8Array;
  spot16: Position;
  spot8: Position;
}
type Head = "spot16" | "spot8";
const HEADS: Head[] = ["spot16", "spot8"];
const ZONES = [
  ZoneSchema.parse({ id: "jardin", name: "Estrade gauche", polygon: [[-3, 3], [-2, 3], [-2, 4], [-3, 4]], aim: { height: 1 } }),
  ZoneSchema.parse({ id: "cour", name: "Estrade droite", polygon: [[2, 3], [3, 3], [3, 4], [2, 4]], aim: {} }),
  ZoneSchema.parse({ id: "fond", name: "Fond de scène", polygon: [[-0.5, 5], [0.5, 5], [0.5, 6], [-0.5, 6]] }),
];

function setup(dir = mkdtempSync(join(tmpdir(), "light-path-rt-"))) {
  const defs = join(dir, "fixtures");
  mkdirSync(defs);
  for (const f of ["spot.qxf", "par-rgb.qxf"]) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(defs, f));
  const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
  venue.fixtures.put({ id: "spot16", name: "Spot 16", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: -2, y: 2, z: 5 }, mount: "hung" });
  venue.fixtures.put({ id: "spot8", name: "Spot 8", manufacturer: "Test", model: "Spot 7", mode: "Basic", universe: 1, address: 11, position: { x: 2, y: 2, z: 5 }, mount: "hung" });
  venue.canvases.put({ id: "lyres", name: "Lyres", topology: "line", cells: 2, render: [{ from: 0, to: 0, targets: [{ fixture: "spot16", head: -1 }] }, { from: 1, to: 1, targets: [{ fixture: "spot8", head: -1 }] }] });
  const clock = { now: 0, beats: 0, bpm: 120 };
  const show = new ShowRuntime(new FolderStore(join(dir, "show")), venue, { state: () => ({ beats: clock.beats, bpm: clock.bpm }) }, () => clock.now);
  for (const z of ZONES) show.zones.put(z);
  const place = (id: string, move: object, technique: object = { kind: "aucune" }) => show.looks.put({ id, name: id, canvas: "lyres", technique, move } as never);
  const at = (id: string, buf: Uint8Array): Position => venue.sentPosition(venue.resolve(id) as ResolvedFixture, buf) as Position;
  const frame = (): Frame => {
    const buf = new Uint8Array(512);
    show.render([buf]);
    show.guard([buf]);
    return { buf, spot16: at("spot16", buf), spot8: at("spot8", buf) };
  };
  /** Frames every 20 ms for `ms`; frame k is at `start + 20 k` ms. */
  const run = (ms: number): Frame[] => {
    const frames: Frame[] = [];
    for (let t = 0; t <= ms; t += 20) {
      frames.push(frame());
      clock.now += 20;
      clock.beats += (0.02 * clock.bpm) / 60;
    }
    return frames;
  };
  /** How far (degrees) the beam a head is sent points from the point. */
  const offBy = (head: Head, f: Frame, p: { x: number; y: number; z: number }): number => {
    const r = venue.resolve(head) as ResolvedFixture;
    const d = venue.pointingOf(r, f.buf);
    const o = r.patch.position!;
    const v = { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z };
    const cos = (d.x * v.x + d.y * v.y + d.z * v.z) / (Math.hypot(d.x, d.y, d.z) * Math.hypot(v.x, v.y, v.z));
    return (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
  };
  return { dir, venue, show, clock, place, frame, run, offBy };
}

const aimOf = (id: string) => zoneAimPoint(ZONES.find((z) => z.id === id)!);
const steepest = (frames: Frame[], head: Head): number => Math.max(0, ...frames.slice(1).flatMap((f, i) => (["pan", "tilt"] as const).map((a) => Math.abs(f[head][a] - frames[i]![head][a]))));
const bytes = (frames: Frame[]) => frames.map((f) => [...f.buf.slice(0, 24)].join(","));
/** The zone a head points at in a frame (within 1.5°), else null. */
const zoneOfFrame = (t: ReturnType<typeof setup>, head: Head, f: Frame): string | null => ZONES.find((z) => t.offBy(head, f, aimOf(z.id)) < 1.5)?.id ?? null;
const loop3 = (more: object = {}) => ({ shape: "fixe", every: { seconds: 1 }, fade: { seconds: 0.2 }, at: { path: { stops: [{ zone: "jardin" }, { zone: "cour" }, { zone: "fond" }], ...more } } });

describe("zones and paths in the engine (T28)", () => {
  it("a look aimed at a zone (move.at.zone + fixe) holds every head on the zone's aiming point, head by head", () => {
    const t = setup();
    t.place("z", { shape: "fixe", at: { zone: "cour" } });
    t.show.go("z");
    const frames = t.run(1500);
    // the entry is the motion layer's glide (the show's moveFade, 1 s): never a jump
    for (const h of HEADS) expect(steepest(frames, h)).to.be.below(0.05);
    for (const h of HEADS) expect(t.offBy(h, frames.at(-1)!, aimOf("cour"))).to.be.below(0.6);
    expect(t.show.motionStatus().get("spot16")!.pan.owner).to.match(/^look:z/);
    // `height` over the zone's own aiming height
    t.place("z", { shape: "fixe", at: { zone: "cour", height: 0 } });
    t.show.go("z");
    const low = t.run(1500).at(-1)!;
    expect(t.offBy("spot8", low, zoneAimPoint(ZONES[1]!, 0))).to.be.below(0.6);
  });

  it("a zone gone holds the heads where they are and says so", () => {
    const t = setup();
    t.place("z", { shape: "fixe", at: { zone: "cour" } });
    t.show.go("z");
    const before = t.run(1500).at(-1)!;
    t.show.zones.delete("cour");
    const after = t.run(400);
    expect(after.at(-1)!.spot16).to.deep.equal(before.spot16);
    expect(t.show.lastErrors.join(" ")).to.match(/zone inconnue|unknown zone/);
  });

  it("a path in loop goes through its stops in order, resting on each, with no jump", () => {
    const t = setup();
    t.place("p", loop3());
    t.show.go("p");
    const frames = t.run(6000);
    // step k (1 s) travels its first half from stop k−1, then rests on stop k: sampled at k s + 800 ms
    const want = ["jardin", "cour", "fond", "jardin", "cour", "fond"];
    want.forEach((z, k) => {
      for (const h of HEADS) expect(zoneOfFrame(t, h, frames[(k * 1000 + 800) / 20]!), `${h} step ${k}`).to.equal(z);
    });
    for (const h of HEADS) expect(steepest(frames, h)).to.be.below(0.05);
    expect(t.show.motionStatus().get("spot8")!.pan.animated).to.equal(true);
  });

  it("the same look replays the same bytes (random order, deterministic), and another order draws differently", () => {
    const play = (order: string) => {
      const t = setup();
      t.place("p", loop3({ order }));
      t.show.go("p");
      return bytes(t.run(8000));
    };
    expect(play("random")).to.deep.equal(play("random"));
    expect(play("random")).to.not.deep.equal(play("loop"));
  });

  it("random: all heads together by default; « chacune » gives each its own sequence", () => {
    const seq = (heads: string) => {
      const t = setup();
      t.place("p", loop3({ order: "random", heads }));
      t.show.go("p");
      const frames = t.run(12000);
      return HEADS.map((h) => Array.from({ length: 12 }, (_, k) => zoneOfFrame(t, h, frames[(k * 1000 + 800) / 20]!)));
    };
    const [a, b] = seq("ensemble");
    expect(a).to.deep.equal(b);
    expect(a).to.not.include(null);
    for (let k = 1; k < a!.length; k++) expect(a![k]).to.not.equal(a![k - 1]);
    const [c, d] = seq("chacune");
    expect(c).to.not.deep.equal(d);
    expect(seq("chacune")).to.deep.equal([c, d]);
  });

  it("a stop one head cannot reach holds that head alone during the steps to and from it, and says why", () => {
    const t = setup();
    // a named position that covers spot16 only: spot8 cannot go there
    t.show.positionPresets.put(PositionPresetSchema.parse({ id: "pp", name: "Position A", values: { spot16: { pan: 0.3, tilt: 0.7 } } }));
    t.place("p", { shape: "fixe", every: { seconds: 1 }, fade: { seconds: 0.2 }, at: { path: { stops: [{ zone: "fond" }, { position: "pp" }] } } });
    t.show.go("p");
    const frames = t.run(4000);
    // step 1 (1–2 s) goes to the position, step 2 (2–3 s) leaves it: spot8 holds on « fond », spot16 moves
    const s8 = frames.slice(1000 / 20, 3000 / 20).map((f) => f.spot8);
    for (const p of s8) expect(p).to.deep.equal(s8[0]);
    expect(zoneOfFrame(t, "spot8", frames[2500 / 20]!)).to.equal("fond");
    const s16 = frames[1800 / 20]!.spot16;
    expect(s16.pan).to.be.closeTo(0.3, 0.01);
    expect(s16.tilt).to.be.closeTo(0.7, 0.01);
    // why it holds rides on the hold: said as the head's error (pads, position.list), the stop named
    expect(t.show.motionStatus().get("spot8")!.pan.error).to.match(/arrêt 2 \(position « Position A »\)/);
    expect(t.show.lastErrors.join(" ")).to.match(/spot8: .*arrêt 2/);
    // no jump either: a head holding, then placed again, glides
    for (const h of HEADS) expect(steepest(frames, h)).to.be.below(0.05);
  });

  it("cedes to a manual position (R1) and to an engaged target (R2), and takes the head back when released", () => {
    const t = setup();
    t.place("p", loop3());
    t.show.go("p");
    t.run(1500);
    t.show.setPosition(["spot16"], { pan: 0.2, tilt: 0.2 });
    const held = t.run(1000);
    expect(held.at(-1)!.spot16.pan).to.be.closeTo(0.2, 0.01);
    expect(t.show.motionStatus().get("spot8")!.pan.owner).to.match(/^look:p/);
    t.show.targets.put({ id: "c", name: "Cible", fixtures: ["spot8"], point: { x: 0, y: 3, z: 0 } } as never);
    t.show.engageTarget("c", true);
    t.run(1500);
    expect(t.show.motionStatus().get("spot8")!.pan.layer).to.equal("target");
    t.show.releasePositions(["spot16"]);
    const back = t.run(1500);
    expect(t.show.motionStatus().get("spot16")!.pan.owner).to.match(/^look:p/);
    expect(steepest(back, "spot16")).to.be.below(0.05);
  });

  it("pathReport: stops resolved head by head, a speed rule that applies, a no-aim zone a trip crosses", () => {
    const t = setup();
    t.place("p", loop3({ travel: 0.1 }));
    const look = t.show.looks.get("p")!;
    const quiet = t.show.pathReport(look)!;
    expect(quiet.heads).to.deep.equal(["spot16", "spot8"]);
    expect(quiet.stops.map((s) => s.name)).to.deep.equal(["zone « Estrade gauche »", "zone « Estrade droite »", "zone « Fond de scène »"]);
    expect(quiet.warnings).to.deep.equal([]);
    // a slow rule on spot16 only: said for spot16 alone
    t.show.rules.put({ id: "lent", name: "Lent", level: "show", scope: { fixture: "spot16" }, target: {}, maxDegPerSecond: 20, locked: false } as never);
    const slow = t.show.pathReport(look)!.warnings;
    expect(slow.length).to.be.greaterThan(0);
    expect(slow.every((w) => w.kind === "speed" && w.heads[0] === "spot16")).to.equal(true);
    t.show.rules.delete("lent");
    // a lectern between the two risers: crossed going from one to the other
    t.show.zones.put(ZoneSchema.parse({ id: "pupitre", name: "Pupitre", polygon: [[-1, 3], [1, 3], [1, 4], [-1, 4]], noAim: true }));
    const crossing = t.show.pathReport(look)!.warnings;
    expect(crossing.some((w) => w.kind === "noAim" && w.zone === "pupitre")).to.equal(true);
    // a zone the look opens (allowLooks) does not darken it
    t.show.zones.put(ZoneSchema.parse({ id: "pupitre", name: "Pupitre", polygon: [[-1, 3], [1, 3], [1, 4], [-1, 4]], noAim: true, allowLooks: ["p"] }));
    expect(t.show.pathReport(look)!.warnings).to.deep.equal([]);
  });

  it("the guard darkens a head while its trip crosses a no-aim zone (it never steers)", () => {
    const t = setup();
    t.show.zones.put(ZoneSchema.parse({ id: "pupitre", name: "Pupitre", polygon: [[-1, 3], [1, 3], [1, 4], [-1, 4]], noAim: true }));
    t.place("p", loop3({ stops: [{ zone: "jardin" }, { zone: "cour" }], travel: 0.8 }), { kind: "plat", color: "#ffffff" });
    t.show.go("p");
    t.run(1500);
    const clamps = () => t.show.lastClamps.filter((c) => c.rule === "zone:pupitre");
    let darkened = false;
    for (let k = 0; k < 60 && !darkened; k++) {
      t.run(20);
      darkened = clamps().length > 0;
    }
    expect(darkened).to.equal(true);
  });

  it("a zone stop's own height is the one aimed at, not the zone's", () => {
    const t = setup();
    t.place("p", { shape: "fixe", every: { seconds: 1 }, fade: { seconds: 0 }, at: { path: { stops: [{ zone: "cour", height: 0 }] } } });
    t.show.go("p");
    const f = t.run(500).at(-1)!;
    for (const h of HEADS) {
      expect(t.offBy(h, f, zoneAimPoint(ZONES[1]!, 0))).to.be.below(0.6);
      expect(t.offBy(h, f, aimOf("cour"))).to.be.above(2);
    }
  });

  it("a target stop deleted since holds the heads at render, the target said by its last name", () => {
    const t = setup();
    t.show.targets.put({ id: "c", name: "Cible soliste", fixtures: [], point: { x: 0, y: 4, z: 1 } } as never);
    t.place("p", { shape: "fixe", every: { seconds: 1 }, fade: { seconds: 0.2 }, at: { path: { stops: [{ zone: "fond" }, { target: "c" }] } } });
    t.show.go("p");
    t.run(1200);
    t.show.rememberGoneName("target", "c", "Cible soliste");
    t.show.targets.delete("c");
    const frames = t.run(1500);
    // step 1 (1–2 s) goes to the target gone: both heads hold where they were
    const held = frames.slice(0, 700 / 20).map((f) => f.spot16);
    for (const p of held) expect(p).to.deep.equal(held[0]);
    expect(t.show.motionStatus().get("spot16")!.pan.error).to.match(/cible inconnue : Cible soliste/);
  });

  it("strictBounds changes nothing while a path plays (the same bytes with and without a check)", () => {
    const play = (check: boolean): string[] => {
      const t = setup();
      t.show.rules.put({ id: "pan-max", name: "Pan max", level: "show", scope: { fixture: "spot16" }, target: { channel: "Pan" }, max: 250, onViolation: "reject" } as never);
      t.place("p", loop3({ order: "random" }));
      t.place("q", loop3({ order: "pingpong" }));
      t.show.go("p");
      const out: string[] = [];
      for (let k = 0; k < 6; k++) {
        out.push(...bytes(t.run(500)));
        if (check) t.show.strictBounds("q");
      }
      return out;
    };
    expect(play(true)).to.deep.equal(play(false));
  });

  it("a look aimed at a zone out of reach of a head says so ahead (pathReport, a path of one stop)", () => {
    const t = setup();
    // a zone behind the heads, above them: out of reach of a hung head
    t.show.zones.put(ZoneSchema.parse({ id: "haut", name: "Plafond", polygon: [[-3, -1], [3, -1], [3, 0], [-3, 0]], floorHeight: 8, aim: {} }));
    t.place("z", { shape: "fixe", at: { zone: "haut" } });
    const report = t.show.pathReport(t.show.looks.get("z")!)!;
    expect(report.stops.map((s) => s.name)).to.deep.equal(["zone « Plafond »"]);
    expect(report.warnings.map((w) => w.kind)).to.deep.equal(["nowhere"]);
    // a reachable zone: nothing to say
    t.place("z", { shape: "fixe", at: { zone: "cour" } });
    expect(t.show.pathReport(t.show.looks.get("z")!)!.warnings).to.deep.equal([]);
    // a look on a target or a named position is not checked here
    t.place("z", { shape: "fixe", at: { target: "x" } });
    expect(t.show.pathReport(t.show.looks.get("z")!)).to.equal(undefined);
  });

  it("pathReport reads the trip's time from the step and its travel part", () => {
    const t = setup();
    t.show.rules.put({ id: "lent", name: "Lent", level: "show", scope: { fixture: "spot16" }, target: {}, maxDegPerSecond: 60, locked: false } as never);
    t.place("p", loop3({ travel: 1 }));
    const slow = t.show.pathReport(t.show.looks.get("p")!)!.warnings.length;
    t.place("p", loop3({ travel: 0.1 }));
    const fast = t.show.pathReport(t.show.looks.get("p")!)!.warnings.length;
    expect(fast).to.be.greaterThan(slow);
  });

  it("speedLimits takes the slowest rule that applies, and the output is bounded by it (applySpeeds)", () => {
    const t = setup();
    const rule = (id: string, deg: number, scope: object) => t.show.rules.put({ id, name: id, level: "show", scope, target: {}, maxDegPerSecond: deg, locked: false } as never);
    rule("vif", 90, { fixture: "spot16" });
    rule("lent", 30, { fixture: "spot16" });
    rule("autre", 5, { fixture: "spot8" });
    const r = t.venue.resolve("spot16") as ResolvedFixture;
    expect(speedLimits(t.show.rulesInForce(), r)).to.deep.equal({ pan: { degPerSecond: 30, rule: "lent" }, tilt: { degPerSecond: 30, rule: "lent" } });
    t.place("a", { shape: "fixe", center: { pan: 0.2, tilt: 0.5 }, fade: { seconds: 0 } });
    t.place("b", { shape: "fixe", center: { pan: 0.8, tilt: 0.5 }, fade: { seconds: 0 } });
    t.show.go("a");
    t.run(3000);
    t.show.go("b");
    const frames = t.run(1000);
    const perSecond = (steepest(frames, "spot16") * 540) / 0.02;
    expect(perSecond).to.be.closeTo(30, 1.5);
  });

  it("references: a zone, a named position or a target cited by a path (or a look aimed at a zone) is in use", () => {
    const look = { id: "p", name: "P", canvas: "c", move: { at: { path: { stops: [{ zone: "z1" }, { position: "pos" }, { target: "tg" }] } } } };
    const parts = { groups: [], faders: [], mappings: [], dashboards: [], snapshots: [], songs: [], looks: [look, { id: "q", name: "Q", canvas: "c", move: { at: { zone: "z2" } } }] };
    expect(usesOf("zone", "z1", parts)).to.have.length(1);
    expect(usesOf("zone", "z2", parts)).to.have.length(1);
    expect(usesOf("position", "pos", parts)).to.have.length(1);
    expect(usesOf("target", "tg", parts)).to.have.length(1);
    expect(usesOf("zone", "other", parts)).to.deep.equal([]);
  });
});
