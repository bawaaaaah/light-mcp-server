import { expect } from "chai";
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { emptyFrame, Venue, type PatchedFixture } from "../../../src/plugins/light/venue/venue.js";
import { pairFixtures, placementChange } from "../../../src/plugins/light/venue/positions-import.js";

/** Two 4-cell bars (Test Bar 4, 15 channels: dimmer, strobe, program, 4×RGB) and one RGB PAR without dimmer. */
function makeVenue(): Venue {
  const dir = mkdtempSync(join(tmpdir(), "light-venue-"));
  const defs = join(dir, "fixtures");
  mkdirSync(defs);
  copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(defs, "bar4.qxf"));
  writeFileSync(
    join(defs, "par.qxf"),
    `<?xml version="1.0"?><FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition"><Manufacturer>Test</Manufacturer><Model>Par RGB</Model><Type>Color Changer</Type>
<Channel Name="Red" Preset="IntensityRed"/><Channel Name="Green" Preset="IntensityGreen"/><Channel Name="Blue" Preset="IntensityBlue"/>
<Mode Name="3 Channel"><Channel Number="0">Red</Channel><Channel Number="1">Green</Channel><Channel Number="2">Blue</Channel></Mode></FixtureDefinition>`,
  );
  const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
  venue.fixtures.put({ id: "bar-l", name: "Barre gauche", manufacturer: "Test", model: "Bar 4", mode: "15-channel", universe: 1, address: 1 });
  venue.fixtures.put({ id: "bar-r", name: "Barre droite", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 16 });
  venue.fixtures.put({ id: "par", name: "PAR", manufacturer: "Test", model: "Par RGB", mode: "3 Channel", universe: 1, address: 100 });
  return venue;
}

describe("venue: patch, canvas and DMX conversion", () => {
  it("resolves fixtures from their definitions (tolerant mode names)", () => {
    const v = makeVenue();
    const r = v.resolve("bar-l");
    expect("error" in r).to.equal(false);
    if (!("error" in r)) {
      expect(r.dimmers).to.deep.equal([0]);
      expect(r.strobes).to.deep.equal([1]);
      expect(r.heads.get(0)).to.deep.equal({ red: 3, green: 4, blue: 5 });
    }
  });

  it("renders an 8-cell mirrored canvas onto two bars and writes DMX", () => {
    const v = makeVenue();
    v.canvases.put({
      id: "mur",
      name: "Mur",
      topology: "line-mirror",
      cells: 8,
      render: [
        ...[0, 1, 2, 3].map((h) => ({ from: h, to: h, targets: [{ fixture: "bar-l", head: h }] })),
        ...[0, 1, 2, 3].map((h) => ({ from: 4 + h, to: 4 + h, targets: [{ fixture: "bar-r", head: h }] })),
      ],
    });
    const frame = emptyFrame();
    const red = { red: 1 };
    const blue = { blue: 1 };
    v.paintCanvas(frame, "mur", [red, red, blue, blue, blue, blue, red, red]);
    frame.intensity.set("bar-l", 0.5);
    const buffers = [new Uint8Array(512)];
    expect(v.toDmx(frame, buffers)).to.deep.equal([]);
    const b = buffers[0]!;
    expect(b[0]).to.equal(128); // bar-l dimmer at 50 %
    expect([b[3], b[4], b[5]]).to.deep.equal([255, 0, 0]); // cell 0 red
    expect([b[9], b[10], b[11]]).to.deep.equal([0, 0, 255]); // cell 2 blue
    expect(b[15]).to.equal(255); // bar-r dimmer full (default intensity)
    expect([b[15 + 12], b[15 + 13], b[15 + 14]]).to.deep.equal([255, 0, 0]); // cell 7 red
  });

  it("scales colours on a fixture without dimmer", () => {
    const v = makeVenue();
    const frame = emptyFrame();
    frame.colors.set("par", new Map([[-1, { red: 1, green: 0.5 }]]));
    frame.intensity.set("par", 0.5);
    const buffers = [new Uint8Array(512)];
    v.toDmx(frame, buffers);
    expect([buffers[0]![99], buffers[0]![100], buffers[0]![101]]).to.deep.equal([128, 64, 0]);
  });

  it("reports a missing definition only when the fixture is used", () => {
    const v = makeVenue();
    v.fixtures.put({ id: "ghost", name: "?", manufacturer: "Nope", model: "X", mode: "1", universe: 1, address: 200 });
    expect(v.toDmx(emptyFrame(), [new Uint8Array(512)])).to.deep.equal([]);
    const frame = emptyFrame();
    frame.colors.set("ghost", new Map([[-1, { red: 1 }]]));
    expect(v.toDmx(frame, [new Uint8Array(512)])[0]).to.match(/définition manquante/);
  });

  it("sees a definition dropped into the folder while it runs, once refreshed", () => {
    const dir = mkdtempSync(join(tmpdir(), "light-venue-"));
    const defs = join(dir, "fixtures");
    mkdirSync(defs);
    writeFileSync(join(defs, "broken.qxf"), "<not xml");
    const v = new Venue(new FolderStore(join(dir, "venue")), [defs]);
    expect(v.definitionFor("Test", "Bar 4")).to.equal(undefined);
    expect(v.store.loadErrors).to.have.length(1);
    v.fixtures.put({ id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1 });
    const frame = emptyFrame();
    frame.colors.set("bar", new Map([[-1, { red: 1 }]]));
    expect(v.toDmx(frame, [new Uint8Array(512)])[0]).to.match(/définition manquante/);
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(defs, "bar4.qxf"));
    v.refreshDefinitions();
    expect(v.definitionFor("Test", "Bar 4")?.model).to.equal("Bar 4");
    expect(v.toDmx(frame, [new Uint8Array(512)])).to.deep.equal([]);
    v.refreshDefinitions(); // nothing changed: nothing reread, the broken file reported once
    expect(v.store.loadErrors).to.have.length(1);
  });
  it("leaves an absent fixture dark and out of the address check, without touching the patch", () => {
    const v = makeVenue();
    v.fixtures.put({ id: "par-2", name: "PAR 2", manufacturer: "Test", model: "Par RGB", mode: "3 Channel", universe: 1, address: 100 + 1 });
    expect(v.patchProblems()).to.have.length(1); // par and par-2 overlap on channels 101
    v.absent = new Set(["par-2"]);
    expect(v.patchProblems()).to.deep.equal([]); // absent: no conflict
    const frame = emptyFrame();
    frame.colors.set("par", new Map([[-1, { red: 1 }]]));
    frame.colors.set("par-2", new Map([[-1, { green: 1 }]]));
    const buffers = [new Uint8Array(512)];
    v.toDmx(frame, buffers);
    expect(buffers[0]![99]).to.equal(255); // the installed PAR is lit
    expect(buffers[0]![100]).to.equal(0); // the absent one wrote nothing
    expect(v.fixtures.get("par-2")).to.not.equal(undefined); // still in the patch
  });
  it("pairs fixtures of two venues by id, then name, then model in address order, and moves only the placement", () => {
    const fx = (id: string, name: string, address: number, extra: Partial<PatchedFixture> = {}): PatchedFixture => ({ id, name, manufacturer: "Test", model: "Bar 4", mode: "15-channel", universe: 1, address, tags: [], ...extra });
    const source = [fx("a", "Barre jardin", 1, { position: { x: -3, y: 1, z: 4 } }), fx("b", "Barre cour", 16, { position: { x: 3, y: 1, z: 4 }, mount: "truss" }), fx("c", "Extra", 31, { position: { x: 0, y: 0, z: 0 } })];
    const target = [fx("a", "Autre nom", 1), fx("zz", "barre  COUR", 40), fx("y", "Bis", 61)];
    const { pairs, unmatchedSource, unmatchedTarget } = pairFixtures(source, target);
    expect(pairs.map((p) => [p.from.id, p.to.id, p.by])).to.deep.equal([["a", "a", "id"], ["b", "zz", "name"], ["c", "y", "model"]]);
    expect([unmatchedSource.length, unmatchedTarget.length]).to.deep.equal([0, 0]);
    const change = placementChange(source[1]!, target[1]!);
    expect(change.changed).to.deep.equal(["position", "mount"]);
    expect(change.fields).to.deep.equal({ position: { x: 3, y: 1, z: 4 }, mount: "truss" }); // address and name stay the target's
    expect(placementChange(source[1]!, { ...target[1]!, ...change.fields }).changed).to.deep.equal([]);
  });
  it("pairs no fixtures by an empty name, marks pairs taken among several, and copies only targets this venue has", () => {
    const fx = (id: string, name: string, address: number, extra: Partial<PatchedFixture> = {}): PatchedFixture => ({ id, name, manufacturer: "Test", model: "Bar 4", mode: "15-channel", universe: 1, address, tags: [], ...extra });
    const other = (f: PatchedFixture): PatchedFixture => ({ ...f, model: "Par RGB", mode: "3 Channel" });
    // names in another script normalise to nothing: they must not all pair with each other
    const { pairs } = pairFixtures([other(fx("s1", "Лира", 1)), fx("s2", "Бар", 20), fx("s3", "Бар", 40)], [fx("t1", "Барра", 1), other(fx("t2", "Лира", 30))]);
    expect(pairs.map((p) => [p.from.id, p.to.id, p.by, p.ambiguous ?? false])).to.deep.equal([["s1", "t2", "model", false], ["s2", "t1", "model", true]]);
    const change = placementChange(fx("a", "A", 1, { target: "pupitre", mount: "truss" }), fx("a", "A", 1), new Set(["scene"]));
    expect(change).to.deep.equal({ fields: { mount: "truss" }, changed: ["mount"], skipped: ["target"] });
  });
});
