import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { packArchive, readArchive } from "../../../src/plugins/light/data/archive.js";
import { usesOf, type ShowParts } from "../../../src/plugins/light/show/references.js";
import { centroid, ellipsePolygon, ELLIPSE_POINTS, isSimplePolygon, polygonArea, ZoneSchema, zoneAimPoint, zoneOutline, zoneShapeError } from "../../../src/plugins/light/venue/stage.js";

type Pt = [number, number];
const rect: Pt[] = [[-4, 1], [4, 1], [4, 5], [-4, 5]];
/** An L: a 4 × 1 m bar along the front and a 1 × 3 m leg on the left, 7 m² in all. */
const ell: Pt[] = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]];

describe("aiming zones (T27): the shape and the aiming point", () => {
  it("aims a rectangle at its centre, as before (the mean of its corners)", () => {
    expect(zoneAimPoint({ polygon: rect, floorHeight: 0.4 })).to.deep.equal({ x: 0, y: 3, z: 1.9 });
    expect(zoneAimPoint({ polygon: rect, floorHeight: 0 }, 0)).to.deep.equal({ x: 0, y: 3, z: 0 });
  });

  it("aims an L at the centre of its surface, not at the mean of its corners", () => {
    const c = centroid(ell);
    // bar: 4 m² centred (2, 0.5); leg: 3 m² centred (0.5, 2.5)
    expect(c.x).to.be.closeTo((4 * 2 + 3 * 0.5) / 7, 1e-9);
    expect(c.y).to.be.closeTo((4 * 0.5 + 3 * 2.5) / 7, 1e-9);
    expect(polygonArea(ell)).to.be.closeTo(7, 1e-9);
    // the corners' mean is elsewhere
    expect(ell.reduce((a, p) => a + p[0], 0) / ell.length).to.not.be.closeTo(c.x, 0.1);
    // clockwise corners: the same centre
    const back = centroid([...ell].reverse());
    expect(back.x).to.be.closeTo(c.x, 1e-9);
    expect(back.y).to.be.closeTo(c.y, 1e-9);
  });

  it("aims an ellipse at its centre, and falls back to the corners' mean without a surface", () => {
    const c = centroid(ellipsePolygon(1, 2, 3, 1.5, 30));
    expect(c.x).to.be.closeTo(1, 0.01);
    expect(c.y).to.be.closeTo(2, 0.01);
    expect(centroid([[0, 0], [1, 0], [2, 0]])).to.deep.equal({ x: 1, y: 0 });
  });

  it("aims at the zone's own point and height when it has them; a height given wins", () => {
    const zone = { polygon: rect, floorHeight: 0.5, aim: { height: 1.2, point: [1, 2] as Pt } };
    expect(zoneAimPoint(zone)).to.deep.equal({ x: 1, y: 2, z: 1.7 });
    expect(zoneAimPoint(zone, 0)).to.deep.equal({ x: 1, y: 2, z: 0.5 });
    expect(zoneAimPoint({ polygon: rect, floorHeight: 0, aim: { height: 2 } })).to.deep.equal({ x: 0, y: 3, z: 2 });
  });

  it("draws an ellipse as 32 corners to the centimetre", () => {
    const poly = ellipsePolygon(0, 3, 2, 1);
    expect(poly).to.have.length(ELLIPSE_POINTS);
    expect(poly[0]).to.deep.equal([2, 3]);
    expect(poly[8]).to.deep.equal([0, 4]);
    for (const v of poly.flat()) expect(Math.abs(Math.round(v * 100) - v * 100)).to.be.lessThan(1e-6);
    expect(isSimplePolygon(poly)).to.equal(true);
  });

  it("refuses an outline that crosses itself, folds back or has no surface", () => {
    expect(isSimplePolygon(rect)).to.equal(true);
    expect(isSimplePolygon(ell)).to.equal(true);
    expect(isSimplePolygon([[0, 0], [2, 2], [2, 0], [0, 2]])).to.equal(false); // a bow tie
    expect(isSimplePolygon([[0, 0], [2, 0], [2, 0], [0, 2]])).to.equal(false); // a corner twice
    expect(isSimplePolygon([[0, 0], [3, 0], [1, 0], [1, 2]])).to.equal(false); // an edge folded back
    expect(isSimplePolygon([[0, 0], [4, 0], [4, 4], [2, 0], [0, 4]])).to.equal(false); // a corner touching an edge
    expect(zoneShapeError([[0, 0], [2, 2], [2, 0], [0, 2]])).to.contain("se croise");
    expect(zoneShapeError([[0, 0], [0.05, 0], [0.05, 0.05], [0, 0.05]])).to.contain("trop petite");
    expect(zoneShapeError(rect)).to.equal(undefined);
  });

  it("reads an outline only while it describes the polygon", () => {
    const ellipse = { kind: "ellipse" as const, cx: 0, cy: 3, rx: 2, ry: 1 };
    expect(zoneOutline({ polygon: ellipsePolygon(0, 3, 2, 1), outline: ellipse })).to.deep.equal(ellipse);
    // a corner moved: the ellipse no longer describes it
    const moved = ellipsePolygon(0, 3, 2, 1);
    moved[3] = [moved[3]![0] + 0.5, moved[3]![1]];
    expect(zoneOutline({ polygon: moved, outline: ellipse })).to.equal(undefined);
    expect(zoneOutline({ polygon: rect, outline: { kind: "rect" } })).to.deep.equal({ kind: "rect" });
    expect(zoneOutline({ polygon: ell, outline: { kind: "rect" } })).to.equal(undefined);
    expect(zoneOutline({ polygon: ell, outline: { kind: "polygon" } })).to.deep.equal({ kind: "polygon" });
    expect(zoneOutline({ polygon: ell })).to.equal(undefined);
  });

  it("finds what names a zone: the patch, the rules scoped to it, the commands naming it by zone", () => {
    const show: ShowParts = {
      groups: [],
      faders: [],
      dashboards: [],
      snapshots: [{ id: "s", name: "Accueil", looks: [], groups: {}, faders: {} }],
      looks: [],
      patch: [{ id: "spot-1", name: "Spot 1", target: "estrade" }, { id: "spot-2", name: "Spot 2" }],
      rules: [{ id: "r1", name: "Doux", scope: { zone: "estrade" } }, { id: "r2", name: "Autre", scope: { fixture: "estrade" } }],
      venueRules: [{ id: "r3", name: "", scope: { zone: "estrade" } }],
      mappings: [
        { id: "m1", label: "Sur l'estrade", on: { command: "position.aim", args: { zone: "estrade", group: "lyres" } } },
        { id: "m2", label: "Cible", on: { command: "target.zone", args: { id: "t", zone: "estrade" } } },
        { id: "m3", label: "Ailleurs", on: { command: "position.aim", args: { zone: "public" } } },
      ],
      songs: [{ id: "a", title: "Chant A", sections: [], cues: [{ command: "position.aim", args: { zone: "estrade" } }] }],
    };
    expect(usesOf("zone", "estrade", show)).to.deep.equal([
      "appareil « Spot 1 » (zone visée)",
      "règle du show « Doux »",
      "règle du lieu « r3 »",
      "mapping MIDI « Sur l'estrade »",
      "mapping MIDI « Cible »",
      "chant « Chant A » (1 action de la piste)",
    ]);
    expect(usesOf("zone", "nulle-part", show)).to.deep.equal([]);
    // a fixture named « estrade » is not the zone
    expect(usesOf("fixture", "estrade", show)).to.deep.equal(["règle du show « Autre »"]);
  });

  describe("in the show", () => {
    let plugin: LightPlugin;
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    const refusal = async (name: string, args: unknown) => {
      try {
        await run(name, args);
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    };
    const estrade = { id: "estrade", name: "Estrade", type: "riser", polygon: [[0, 2], [2, 2], [2, 4], [0, 4]], floorHeight: 0.4 };

    beforeEach(async () => {
      const dataRoot = join(mkdtempSync(join(tmpdir(), "light-zones-")), "data");
      mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
      copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
      const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
      await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    });

    it("aims at the zone's own height when the call gives none, at 1.5 m without one", async () => {
      await run("stage.zone.put", { zone: { ...estrade, aim: { height: 1 } } });
      expect(((await run("position.aim", { zone: "estrade" })) as { target: unknown }).target).to.deep.equal({ x: 1, y: 3, z: 1.4 });
      expect(((await run("position.aim", { zone: "estrade", height: 2 })) as { target: unknown }).target).to.deep.equal({ x: 1, y: 3, z: 2.4 });
      await run("stage.zone.put", { zone: estrade });
      expect(((await run("position.aim", { zone: "estrade" })) as { target: unknown }).target).to.deep.equal({ x: 1, y: 3, z: 1.9 });
    });

    it("refuses a zone whose outline crosses itself or is too small", async () => {
      expect(await refusal("stage.zone.put", { zone: { id: "x", name: "Nœud", polygon: [[0, 0], [2, 2], [2, 0], [0, 2]] } })).to.contain("Nœud").and.contain("se croise");
      expect(await refusal("stage.zone.put", { zone: { id: "x", name: "Point", polygon: [[0, 0], [0.05, 0], [0, 0.05]] } })).to.contain("trop petite");
      expect(plugin.runtime.zones.get("x")).to.equal(undefined);
    });

    it("keeps the aiming part and the outline, and lists an outline only while it describes the polygon", async () => {
      const outline = { kind: "ellipse", cx: 0, cy: 3, rx: 2, ry: 1 };
      await run("stage.zone.put", { zone: { id: "rond", name: "Rond", polygon: ellipsePolygon(0, 3, 2, 1), aim: { height: 1.2, color: "#ffaa00" }, outline } });
      const listed = ((await run("stage.zone.list")) as { id: string; aim?: unknown; outline?: unknown }[]).find((z) => z.id === "rond")!;
      expect(listed.aim).to.deep.equal({ height: 1.2, color: "#ffaa00" });
      expect(listed.outline).to.deep.equal(outline);
      // its corners changed by another client, the outline stays stored but is no longer listed
      const polygon = ellipsePolygon(0, 3, 2, 1);
      polygon[0] = [2.5, 3];
      await run("stage.zone.put", { zone: { id: "rond", name: "Rond", polygon, outline } });
      const stale = ((await run("stage.zone.list")) as { id: string; outline?: unknown }[]).find((z) => z.id === "rond")!;
      expect(stale).to.not.have.property("outline");
      expect(plugin.runtime.zones.get("rond")?.outline).to.deep.equal(outline);
    });

    it("carries the aiming part and the outline in a .lightshow archive", async () => {
      const zone = { id: "rond", name: "Rond", polygon: ellipsePolygon(0, 3, 2, 1), aim: { height: 1.2, point: [0.5, 3] }, outline: { kind: "ellipse", cx: 0, cy: 3, rx: 2, ry: 1, rotation: 0 } };
      await run("stage.zone.put", { zone });
      plugin.runtime.venue.store.flushLive();
      const content = readArchive(packArchive({ venue: { id: "v", dir: plugin.runtime.venue.store.root } }));
      const file = Object.entries(content.venue).find(([name]) => name.includes("zones") && name.includes("rond"));
      expect(file, Object.keys(content.venue).join(", ")).to.not.equal(undefined);
      const back = ZoneSchema.parse(JSON.parse(file![1]));
      expect(back.aim).to.deep.equal({ height: 1.2, point: [0.5, 3] });
      expect(back.outline).to.deep.equal(zone.outline);
    });

    it("refuses to delete a zone a fixture aims at, a rule is scoped to or a mapping names, unless forced", async () => {
      await run("stage.zone.put", { zone: estrade });
      const bar = plugin.runtime.venue.fixtures.get("bar-0")!;
      await run("venue.fixture.put", { fixture: { ...bar, target: "estrade" } });
      await run("rule.put", { where: "show", rule: { id: "doux", name: "Doux sur l'estrade", scope: { zone: "estrade" }, target: { attribute: "intensity" }, max: 128 } });
      await run("midi.mapping.put", { mapping: { id: "m-aim", label: "Viser l'estrade", input: { type: "note", channel: 1, number: 9 }, on: { command: "position.aim", args: { zone: "estrade" } } } });
      const { uses } = (await run("show.references", { kind: "zone", id: "estrade" })) as { uses: string[] };
      expect(uses).to.include.members([`appareil « ${bar.name} » (zone visée)`, "règle du show « Doux sur l'estrade »", "mapping MIDI « Viser l'estrade »"]);
      const refused = await refusal("stage.zone.delete", { id: "estrade" });
      expect(refused).to.contain("« Estrade » est encore utilisé").and.contain("règle du show").and.contain("force: true");
      expect(plugin.runtime.zones.get("estrade")).to.not.equal(undefined);
      const forced = (await run("stage.zone.delete", { id: "estrade", force: true })) as { deleted: boolean; usedBy: string[] };
      expect(forced.deleted).to.equal(true);
      expect(forced.usedBy).to.include.members(uses);
      // nothing uses it: deleted without force; an unknown id is not an error
      await run("stage.zone.put", { zone: { ...estrade, id: "libre", name: "Libre" } });
      expect(await run("stage.zone.delete", { id: "libre" })).to.deep.equal({ deleted: true, usedBy: [] });
      expect(await run("stage.zone.delete", { id: "nulle-part" })).to.deep.equal({ deleted: false, usedBy: [] });
    });
  });
});
