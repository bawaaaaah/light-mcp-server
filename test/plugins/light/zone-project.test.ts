import { expect } from "chai";
import { aimAt, pointing, type AimSetup } from "../../../src/plugins/light/venue/aim.js";
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

/** No two neighbours of a run apart by a quarter of the travel: the outline is never drawn across a swing. */
function noSwing(paths: PadPoint[][]): void {
  for (const path of paths) for (let i = 1; i < path.length; i++) expect(Math.abs(path[i]![0] - path[i - 1]![0]) + Math.abs(path[i]![1] - path[i - 1]![1])).to.be.below(0.5);
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
    noSwing(p.paths);
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
    noSwing(p.paths);
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
    expect(p).to.deep.equal({ id: "z", name: "Estrade", color: "#22c55e", paths: [], closed: false, reach: "none" });
  });

  it("does not draw a line across the travel where a zone round the head's axis makes it swing", () => {
    // a zone right under a hung head: its pan turns all the way round, past what the travel keeps on one side
    const narrow: AimSetup = { ...HUNG, panMax: 360 };
    const p = projectZone(narrow, zone([[-1, 0], [1, 0], [1, 2], [-1, 2]]));
    expect(p.paths.length).to.be.at.least(1);
    noSwing(p.paths);
    for (const path of p.paths) for (const pt of path) expect(toOutline(landsAt(narrow, pt, 1.5), [[-1, 0], [1, 0], [1, 2], [-1, 2]])).to.be.below(0.01);
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
    // the same answer again (kept per head setup and zone), and a changed zone answered anew
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
