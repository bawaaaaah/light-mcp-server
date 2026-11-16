import { expect } from "chai";
import { aimAt, aimNear, pointing, withinLimits, type AimSetup } from "../../../src/plugins/light/venue/aim.js";
import { zoneAimPoint, type Zone } from "../../../src/plugins/light/venue/stage.js";
import { projectZone, type PadPoint } from "../../../src/plugins/light/venue/zone-project.js";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

/**
 * T27, lot 5: an aiming zone's outline as one moving head sees it (`projectZone`), for the pad of that head: the outline
 * at the zone's aiming height, in the head's pan/tilt, cut (never bent) where the reach or the useful stops end.
 */
const zone = (polygon: [number, number][], extra: Partial<Zone> = {}): Zone => ({
  id: "z",
  name: "Estrade",
  type: "riser",
  polygon,
  floorHeight: 0,
  tags: [],
  protected: false,
  noAim: false,
  allowLooks: [],
  aim: { height: 1.5 },
  ...extra,
});

const HUNG: AimSetup = { position: { x: 0, y: 1, z: 5 }, hung: true, yaw: 0, panMax: 540, tiltMax: 270, panOffset: 0, tiltOffset: 0 };
const STANDING: AimSetup = { position: { x: 0, y: -1, z: 1 }, hung: false, yaw: 0, panMax: 540, tiltMax: 270, panOffset: 0, tiltOffset: 0 };

/** Where a pad point falls on the plane z = h: the beam from the head, followed to that height. */
function landsAt(setup: AimSetup, [pan, tilt]: PadPoint, h: number): { x: number; y: number } {
  const d = pointing(setup, { pan, tilt });
  const t = (h - setup.position.z) / d.z;
  expect(t).to.be.greaterThan(0);
  return { x: setup.position.x + d.x * t, y: setup.position.y + d.y * t };
}

/** Distance (metres) from a point to a polygon's outline. */
function toOutline(p: { x: number; y: number }, poly: [number, number][]): number {
  return Math.min(
    ...poly.map(([x0, y0], i) => {
      const [x1, y1] = poly[(i + 1) % poly.length]!;
      const [dx, dy] = [x1 - x0, y1 - y0];
      const t = Math.max(0, Math.min(1, ((p.x - x0) * dx + (p.y - y0) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(p.x - (x0 + t * dx), p.y - (y0 + t * dy));
    }),
  );
}

/**
 * No two neighbours of a run a swing apart, axis by axis in degrees (90° of pan, 60° of tilt): a 720° head's half-turn
 * is a quarter of its travel, so a fraction of the travel would not catch it. A closed band (`axisInside`) joins its
 * two arcs by constant-pan segments across the axis: there, only the pan is checked.
 */
function noSwing(setup: AimSetup, p: { paths: PadPoint[][]; axisInside?: true; closed: boolean }): void {
  for (const path of p.paths) {
    const pts = p.closed ? [...path, path[0]!] : path;
    for (let i = 1; i < pts.length; i++) {
      const dPan = Math.abs(pts[i]![0] - pts[i - 1]![0]) * setup.panMax;
      const dTilt = Math.abs(pts[i]![1] - pts[i - 1]![1]) * setup.tiltMax;
      expect(dPan, `pan step ${i}`).to.be.at.most(90);
      if (!(p.axisInside && dPan < 0.1)) expect(dTilt, `tilt step ${i}`).to.be.at.most(60);
    }
  }
}

/** A seeded random source: the property test is the same on every run. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("aiming zones seen by a moving head (T27, lot 5)", () => {
  it("projects a zone a hung head reaches whole: one closed loop around where position.aim sends it", () => {
    const z = zone([[-3, 2], [-1, 2], [-1, 4], [-3, 4]]);
    const p = projectZone(HUNG, z);
    expect(p.reach).to.equal("full");
    expect(p.closed).to.equal(true);
    expect(p.paths).to.have.length(1);
    // the aiming point: what position.aim {zone} gives
    const aimed = aimAt(HUNG, zoneAimPoint(z));
    if ("error" in aimed) throw new Error(aimed.error);
    expect(p.aim![0]).to.be.closeTo(aimed.pan, 1e-4);
    expect(p.aim![1]).to.be.closeTo(aimed.tilt, 1e-4);
    // every point of the loop falls on the outline, at the zone's aiming height (floor 0 + 1.5)
    for (const pt of p.paths[0]!) expect(toOutline(landsAt(HUNG, pt, 1.5), z.polygon)).to.be.below(0.01);
    // the corners are kept and the edges sampled every 10 cm at most
    expect(p.paths[0]!.length).to.be.at.least(80);
    noSwing(HUNG, p);
  });

  it("takes the outline at the zone's own aiming height above its floor", () => {
    const z = zone([[-1, 3], [1, 3], [1, 4], [-1, 4]], { floorHeight: 0.6, aim: { height: 0.4 } });
    const p = projectZone(HUNG, z);
    for (const pt of p.paths[0]!) expect(toOutline(landsAt(HUNG, pt, 1), z.polygon)).to.be.below(0.01);
  });

  it("cuts the part a standing head cannot reach at its useful stops, never bending it onto them", () => {
    // tilt within ±60° of the base axis (up): above the head at 1.5 m (0.5 m higher), within 0.87 m of its foot
    const limited: AimSetup = { ...STANDING, limits: { tilt: [-60, 60] } };
    const z = zone([[-0.5, -0.6], [3, -0.6], [3, 0], [-0.5, 0]], { aim: { height: 1.5, point: [0, -0.4] } });
    const p = projectZone(limited, z);
    expect(p.reach).to.equal("partial");
    expect(p.closed).to.equal(false);
    expect(p.paths.length).to.be.at.least(1);
    expect(p.aim).to.not.equal(undefined);
    const tiltDeg = (pt: PadPoint) => (pt[1] - 0.5) * limited.tiltMax;
    for (const path of p.paths) {
      // every point is in reach and still on the outline: the cut part is left out, not pressed onto the stop
      for (const pt of path) {
        expect(Math.abs(tiltDeg(pt))).to.be.at.most(60 + 0.06); // pan/tilt rounded to 1e-4 of the travel
        expect(toOutline(landsAt(limited, pt, 1.5), z.polygon)).to.be.below(0.01);
      }
      // each run ends where the reach ends (found between two samples): on the stop, to a tenth of a degree
      expect(Math.abs(tiltDeg(path[0]!))).to.be.closeTo(60, 0.1);
      expect(Math.abs(tiltDeg(path.at(-1)!))).to.be.closeTo(60, 0.1);
    }
    noSwing(limited, p);
  });

  it("cuts at the pan stops of a hung head too", () => {
    const limited: AimSetup = { ...HUNG, limits: { pan: [-30, 30] } };
    const z = zone([[-3, 2], [3, 2], [3, 4], [-3, 4]]);
    const p = projectZone(limited, z);
    expect(p.reach).to.equal("partial");
    for (const path of p.paths) for (const pt of path) expect(Math.abs((pt[0] - 0.5) * limited.panMax)).to.be.at.most(30 + 0.06);
  });

  it("gives nothing for a zone wholly out of reach, and no aiming point", () => {
    const limited: AimSetup = { ...HUNG, limits: { tilt: [-5, 5] } };
    const p = projectZone(limited, zone([[4, 6], [6, 6], [6, 8], [4, 8]], { aim: { height: 1.5, color: "#22c55e" } }));
    expect(p).to.deep.equal({ id: "z", name: "Estrade", color: "#22c55e", paths: [], closed: false, reach: "none", polygon: [[4, 6], [6, 6], [6, 8], [4, 8]], plane: 1.5 });
  });

  it("draws a zone right under a hung head as the closed band round its axis, two arcs joined across it, at 360° and 720°", () => {
    const square: [number, number][] = [[-1, 0], [1, 0], [1, 2], [-1, 2]];
    for (const panMax of [360, 540, 720]) {
      const setup: AimSetup = { ...HUNG, panMax };
      const p = projectZone(setup, zone(square, { aim: { height: 1.5, point: [0.5, 1.4] } }));
      expect(p, `${panMax}°`).to.include({ reach: "full", closed: true, axisInside: true });
      expect(p.paths).to.have.length(1);
      noSwing(setup, p);
      // every point of the loop is on the outline (the joins are edges of the loop, not points)
      for (const pt of p.paths[0]!) expect(toOutline(landsAt(setup, pt, 1.5), square)).to.be.below(0.01);
      // the two joins: constant pan, crossing the axis (tilt 0), on either side of the aiming point's pan (± 90°)
      const loop = [...p.paths[0]!, p.paths[0]![0]!];
      const joins = loop.slice(1).flatMap((pt, i) => {
        const prev = loop[i]!;
        const crosses = Math.sign(pt[1] - 0.5) !== Math.sign(prev[1] - 0.5) && Math.abs(pt[1] - prev[1]) * setup.tiltMax > 10;
        return crosses ? [(pt[0] - 0.5) * panMax] : [];
      });
      expect(joins).to.have.length(2);
      const aimPan = (p.aim![0] - 0.5) * panMax;
      expect(joins.map((pan) => Math.round(Math.abs(pan - aimPan))).sort()).to.deep.equal([90, 90]);
    }
  });

  it("draws only the branch position.aim is on: a part only the other solution reaches is left out, not drawn elsewhere", () => {
    // pan stops at ± 100°: the zone's back corners are beyond them on the aiming point's branch, but the other solution
    // (pan − 180°, the tilt mirrored) would reach them
    const limited: AimSetup = { position: { x: 0, y: 0, z: 5 }, hung: true, yaw: 0, panMax: 540, tiltMax: 270, panOffset: 0, tiltOffset: 0, limits: { pan: [-100, 100] } };
    const z = zone([[1, -3], [4, -3], [4, 3], [1, 3]], { aim: { height: 1.5, point: [2.5, 2] } });
    const p = projectZone(limited, z);
    const anchor = aimAt(limited, zoneAimPoint(z));
    if ("error" in anchor) throw new Error(anchor.error);
    const other = aimNear(limited, { x: 4, y: -3, z: 1.5 }, anchor);
    expect("error" in other).to.equal(false); // reachable by the other solution…
    if (!("error" in other)) expect(Math.sign(other.tiltDeg)).to.not.equal(Math.sign(anchor.tiltDeg));
    expect(p.reach).to.equal("partial"); // …but not drawn: the zone is only partly in reach on this branch
    for (const path of p.paths) for (const pt of path) expect(Math.sign((pt[1] - 0.5) * limited.tiltMax)).to.equal(Math.sign(anchor.tiltDeg));
    noSwing(limited, p);
  });

  it("holds its properties over random heads, zones and stops (yaw, offsets, standing heads, 720°)", () => {
    const rnd = seeded(2711);
    const between = (a: number, b: number) => a + (b - a) * rnd();
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    for (let it = 0; it < 400; it++) {
      const hung = rnd() < 0.6;
      const panMax = pick([360, 540, 630, 720]);
      const tiltMax = pick([180, 220, 270]);
      const setup: AimSetup = {
        position: { x: between(-6, 6), y: between(-2, 8), z: hung ? between(2.5, 7) : between(0, 1.2) },
        hung,
        yaw: pick([0, 90, -90, 180, between(-180, 180)]),
        panMax,
        tiltMax,
        panOffset: rnd() < 0.5 ? 0 : between(-40, 40),
        tiltOffset: rnd() < 0.5 ? 0 : between(-10, 10),
        ...(rnd() < 0.4 ? { limits: { pan: [between(-panMax / 2, -20), between(20, panMax / 2)] as [number, number], ...(rnd() < 0.5 ? { tilt: [between(-tiltMax / 2, -5), between(10, tiltMax / 2)] as [number, number] } : {}) } } : {}),
      };
      const [w, d] = [between(0.3, 6), between(0.3, 5)];
      const under = rnd() < 0.3; // round the head's axis, sometimes
      const [ox, oy] = under ? [setup.position.x + between(-w / 3, w / 3), setup.position.y + between(-d / 3, d / 3)] : [between(-6, 6), between(-2, 8)];
      const polygon: [number, number][] = [[ox - w / 2, oy - d / 2], [ox + w / 2, oy - d / 2], [ox + w / 2, oy + d / 2], [ox - w / 2, oy + d / 2]];
      const z = zone(polygon, { floorHeight: pick([0, 0.4]), aim: { height: pick([0, 1.5, 3]) } });
      const p = projectZone(setup, z);
      const at = `case ${it}`;
      // the aiming point is position.aim's; full ⇔ one closed loop; nothing drawn ⇔ none
      const aimed = aimAt(setup, zoneAimPoint(z));
      if ("error" in aimed) expect(p.aim, at).to.equal(undefined);
      else expect(p.aim, at).to.deep.equal([Math.round(aimed.pan * 1e4) / 1e4, Math.round(aimed.tilt * 1e4) / 1e4]);
      expect(p.reach === "full", at).to.equal(p.closed);
      expect(p.reach === "none", at).to.equal(p.paths.length === 0);
      if (p.closed) expect(p.paths, at).to.have.length(1);
      noSwing(setup, p);
      const plane = zoneAimPoint(z).z;
      for (const path of p.paths)
        for (const pt of path) {
          const deg: [number, number] = [(pt[0] - 0.5) * panMax, (pt[1] - 0.5) * tiltMax];
          // within the travel and the stops (rounded to 1e-4 of the travel), and on the outline
          expect(withinLimits(setup.limits, deg[0], deg[1], 0.08), at).to.equal(true);
          expect(pt[0], at).to.be.within(0, 1);
          expect(pt[1], at).to.be.within(0, 1);
          const dir = pointing(setup, { pan: pt[0], tilt: pt[1] });
          const k = (plane - setup.position.z) / dir.z;
          expect(k, at).to.be.greaterThan(0);
          const reach = Math.hypot(dir.x * k, dir.y * k, dir.z * k);
          const cos = Math.abs(dir.z);
          const tol = 0.01 + (reach * (1e-4 * Math.max(panMax, tiltMax) * Math.PI) / 180 / Math.max(cos, 1e-3)) * 1.5;
          expect(toOutline({ x: setup.position.x + dir.x * k, y: setup.position.y + dir.y * k }, polygon), at).to.be.below(tol);
        }
    }
  });

  it("keeps a large zone to a bounded number of points", () => {
    const p = projectZone(HUNG, zone([[-50, 2], [50, 2], [50, 60], [-50, 60]]), { maxSamples: 120 });
    const points = p.paths.reduce((n, path) => n + path.length, 0);
    expect(points).to.be.at.most(120 + 2 * p.paths.length);
  });
});

describe("stage.zone.project: the aiming zones of the stage seen by one head (T27, lot 5)", () => {
  let plugin: LightPlugin;
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  type Reply = { fixture: string; zones: { id: string; reach: string; paths: PadPoint[][]; closed: boolean; aim?: PadPoint; color?: string }[]; reason?: string };
  beforeEach(async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-zone-project-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), join(dataRoot, "fixtures", "spot.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    plugin.venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: 0, y: 1, z: 5 }, mount: "hung" });
    await run("stage.zone.put", { zone: { id: "scene", name: "Scène", polygon: [[-4, 0], [4, 0], [4, 6], [-4, 6]] } });
    await run("stage.zone.put", { zone: { id: "estrade", name: "Estrade", polygon: [[-3, 2], [-1, 2], [-1, 4], [-3, 4]], aim: { height: 1.5, color: "#22c55e" } } });
  });
  afterEach(async () => {
    await plugin.stop();
  });

  it("projects the aiming zones only, aimed where position.aim sends the head, read-only", async () => {
    const reply = (await run("stage.zone.project", { fixture: "spot" })) as Reply;
    expect(reply.zones.map((z) => z.id)).to.deep.equal(["estrade"]); // « Scène » is no aiming zone
    const estrade = reply.zones[0]!;
    expect(estrade).to.include({ reach: "full", closed: true, color: "#22c55e" });
    const aimed = (await run("position.aim", { fixtures: ["spot"], zone: "estrade" })) as { results: { pan: number; tilt: number }[] };
    expect(estrade.aim![0]).to.be.closeTo(aimed.results[0]!.pan, 1e-4);
    expect(estrade.aim![1]).to.be.closeTo(aimed.results[0]!.tilt, 1e-4);
    // the head's aiming data and each zone on the stage, for the pad to find the zone under a point
    expect((reply as Reply & { head: unknown }).head).to.deep.include({ position: { x: 0, y: 1, z: 5 }, hung: true });
    expect(estrade).to.deep.include({ polygon: [[-3, 2], [-1, 2], [-1, 4], [-3, 4]], plane: 1.5 });
    // the same answer again, and a changed zone answered anew
    expect(await run("stage.zone.project", { fixture: "spot" })).to.deep.equal(reply);
    await run("stage.zone.put", { zone: { id: "estrade", name: "Estrade", polygon: [[-3, 2], [-2, 2], [-2, 4], [-3, 4]], aim: { height: 1.5 } } });
    const moved = ((await run("stage.zone.project", { fixture: "spot" })) as Reply).zones[0]!;
    expect(moved.aim).to.not.deep.equal(estrade.aim);
    expect(moved.color).to.equal(undefined);
  });

  it("follows the head's useful stops and its place, and says a head without a stage position", async () => {
    const spot = plugin.venue.fixtures.get("spot")!;
    plugin.venue.fixtures.put({ ...spot, orientation: { limits: { tilt: [-5, 5] } } });
    expect(((await run("stage.zone.project", { fixture: "spot" })) as Reply).zones[0]).to.include({ reach: "none" });
    const { position: _placed, ...unplaced } = spot;
    plugin.venue.fixtures.put(unplaced);
    expect(await run("stage.zone.project", { fixture: "spot" })).to.deep.equal({ fixture: "spot", zones: [], reason: "no-position" });
    let refused = "";
    try {
      await run("stage.zone.project", { fixture: "nobody" });
    } catch (e) {
      refused = (e as Error).message;
    }
    expect(refused).to.contain("nobody");
  });
});
