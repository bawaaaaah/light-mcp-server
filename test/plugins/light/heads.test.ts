import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { headsOf, partOf } from "../../../src/plugins/light/venue/heads.js";
import { parseQxf } from "../../../src/plugins/light/venue/qxf-import.js";
import { emptyFrame, Venue, type ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";
import { qxwToShow } from "../../../src/plugins/light/presets/qxw-to-show.js";
import type { QxwWorkspace } from "../../../src/plugins/light/presets/qxw-import.js";

const WASH = new URL("../../fixtures/wash-zones.qxf", import.meta.url);
const wash = () => parseQxf(readFileSync(WASH, "utf8"));
/** Zones 1-3 (RGBW) at offsets 2-13, the halo (RGB) at 14-16, its effect at 17. */
const ZONE = (z: number) => ({ red: 2 + 4 * (z - 1), green: 3 + 4 * (z - 1), blue: 4 + 4 * (z - 1), white: 5 + 4 * (z - 1) });
const HALO = { red: 14, green: 15, blue: 16 };

/** Two colours repeated out of any head, named so that no part can be told apart. */
const BLOB = `<?xml version="1.0"?><FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition"><Manufacturer>Test</Manufacturer><Model>Blob</Model><Type>Color Changer</Type>
<Channel Name="Red A" Preset="IntensityRed"/><Channel Name="Green A" Preset="IntensityGreen"/><Channel Name="Red B" Preset="IntensityRed"/><Channel Name="Green B" Preset="IntensityGreen"/>
<Mode Name="4 Channel"><Channel Number="0">Red A</Channel><Channel Number="1">Green A</Channel><Channel Number="2">Red B</Channel><Channel Number="3">Green B</Channel></Mode></FixtureDefinition>`;

function makeVenue(): Venue {
  const dir = mkdtempSync(join(tmpdir(), "light-heads-"));
  const defs = join(dir, "fixtures");
  mkdirSync(defs);
  copyFileSync(WASH, join(defs, "wash-zones.qxf"));
  copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(defs, "bar4.qxf"));
  const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
  venue.fixtures.put({ id: "wash", name: "Wash", manufacturer: "Test", model: "Wash Zones", mode: "18 Channel", universe: 1, address: 1 });
  return venue;
}
const resolved = (v: Venue, id: string) => v.resolve(id) as ResolvedFixture;

describe("heads: deduced from the channel names, and the accent head", () => {
  it("tells a colour channel's part by its number and the words left once the colour is out", () => {
    expect(partOf("Red 2")).to.deep.equal({ words: "", number: 2 });
    expect(partOf("R1")).to.deep.equal({ words: "", number: 1 });
    expect(partOf("Halo Red")).to.deep.equal({ words: "halo" });
    expect(partOf("Zone 3 Blue")).to.deep.equal({ words: "zone", number: 3 });
  });

  it("deduces 4 heads from a definition without <Head>: the 3 numbered zones, then the halo as an accent", () => {
    const def = wash();
    const mode = def.modes[0]!;
    expect(mode.heads).to.deep.equal([]); // the definition is left as the file says
    const h = headsOf(def, mode);
    expect(h.deduced).to.equal(true);
    expect([...h.heads.entries()]).to.deep.equal([
      [0, ZONE(1)],
      [1, ZONE(2)],
      [2, ZONE(3)],
      [3, HALO],
    ]);
    expect([...h.accent]).to.deep.equal([3]);
    expect(h.escaped).to.deep.equal([]);
    // « no accent »: the halo is a fourth full head
    expect([...headsOf(def, mode, { accent: [] }).accent]).to.deep.equal([]);
    // a definition that declares its heads keeps them, none named as a halo
    const bar = parseQxf(readFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), "utf8"));
    const declared = headsOf(bar, bar.modes[0]!);
    expect([declared.deduced, declared.heads.size, declared.accent.size]).to.deep.equal([false, 4, 0]);
  });

  it("reports colours repeated out of any head when the names cannot be told apart", () => {
    const blob = parseQxf(BLOB);
    const h = headsOf(blob, blob.modes[0]!);
    expect([...h.heads.keys()]).to.deep.equal([-1]);
    expect(h.escaped).to.deep.equal([2, 3]);
  });

  it("paints the 3 zones and the halo for a whole-fixture colour, and lets a look paint each apart", () => {
    const v = makeVenue();
    const frame = emptyFrame();
    frame.colors.set("wash", new Map([[-1, { red: 1, blue: 0.5 }]]));
    const buf = new Uint8Array(512);
    expect(v.toDmx(frame, [buf])).to.deep.equal([]);
    for (const z of [1, 2, 3]) expect([buf[ZONE(z).red], buf[ZONE(z).blue], buf[ZONE(z).white]]).to.deep.equal([255, 128, 0]);
    expect([buf[HALO.red], buf[HALO.blue]]).to.deep.equal([255, 128]);
    // zone 2 alone, another colour on the halo
    const own = emptyFrame();
    own.colors.set("wash", new Map([[1, { green: 1 }], [3, { blue: 1 }]]));
    const out = new Uint8Array(512);
    v.toDmx(own, [out]);
    expect([out[ZONE(1).green], out[ZONE(2).green], out[HALO.green], out[HALO.blue]]).to.deep.equal([0, 255, 0, 255]);
  });

  it("lets an unpainted halo follow the brightest of the zones the look paints, unless told not to", () => {
    const v = makeVenue();
    const frame = emptyFrame();
    frame.colors.set("wash", new Map([[0, { red: 1 }], [2, { green: 0.5 }]]));
    const buf = new Uint8Array(512);
    v.toDmx(frame, [buf]);
    expect([buf[HALO.red], buf[HALO.green], buf[HALO.blue]]).to.deep.equal([255, 128, 0]);
    v.fixtures.put({ ...v.fixtures.get("wash")!, overrides: { heads: { follow: false } } });
    const dark = new Uint8Array(512);
    v.toDmx(frame, [dark]);
    expect([dark[HALO.red], dark[HALO.green]]).to.deep.equal([0, 0]);
  });

  it("leaves the halo out of the preview and of what lights the fixture", () => {
    const v = makeVenue();
    const buf = new Uint8Array(512);
    buf[0] = 255;
    buf[ZONE(2).red] = 255;
    buf[HALO.blue] = 255;
    expect(v.displayColors([buf]).wash).to.deep.equal(["#000000", "#ff0000", "#000000"]); // 3 zones, no halo
    expect(v.lightsBody("wash", [3])).to.equal(false);
    expect(v.lightsBody("wash", [3, 0])).to.equal(true);
    expect(v.lightsBody("wash", [-1])).to.equal(true);
  });

  it("fades a raw look on a zone-2 offset by its colours, and keeps the halo's effect a machine (non-regression)", () => {
    const v = makeVenue();
    // before T21 Red 2 was no colour offset: written verbatim (200) and its look's weight dosed the dimmer (128)
    const frame = emptyFrame();
    frame.raw.set("wash", new Map([[ZONE(2).red, [{ value: 200, weight: 0.5, look: "scene", sheet: "scene" }]]]));
    const buf = new Uint8Array(512);
    v.toDmx(frame, [buf]);
    expect(buf[ZONE(2).red]).to.equal(100); // from black to 200 with the look's weight
    expect(buf[0]).to.equal(255); // the look doses itself by its colours: the dimmer is left alone
    // the halo's colour fades the same way but doses nothing; its effect channel stays a machine
    const halo = emptyFrame();
    halo.raw.set("wash", new Map([[HALO.red, [{ value: 200, weight: 0.5, look: "halo", sheet: "halo" }]]]));
    const hb = new Uint8Array(512);
    v.toDmx(halo, [hb]);
    expect([hb[HALO.red], hb[0]]).to.deep.equal([100, 255]);
    const effect = emptyFrame();
    effect.raw.set("wash", new Map([[17, [{ value: 200, weight: 0.5, look: "rainbow", sheet: "rainbow" }]]]));
    const eb = new Uint8Array(512);
    v.toDmx(effect, [eb]);
    expect([eb[17], eb[0]]).to.deep.equal([200, 128]); // verbatim, and its weight doses the dimmer
  });

  it("takes the accent from the model's correction, then from the fixture's own", () => {
    const v = makeVenue();
    v.fixtures.put({ id: "wash-2", name: "Wash 2", manufacturer: "Test", model: "Wash Zones", mode: "18 Channel", universe: 1, address: 30 });
    v.models.put({ id: "test-wash-zones", manufacturer: "Test", model: "Wash Zones", overrides: { heads: { accent: ["Red 3", "Green 3", "Blue 3", "White 3"] } } });
    for (const id of ["wash", "wash-2"]) {
      const r = resolved(v, id);
      expect([...r.accent], id).to.deep.equal([3]); // zone 3 is the accent now, the halo a full head
      expect(r.heads.get(3)).to.deep.equal(ZONE(3));
      expect(r.heads.get(2)).to.deep.equal(HALO);
    }
    v.fixtures.put({ ...v.fixtures.get("wash-2")!, overrides: { heads: { accent: [] } } });
    expect([...resolved(v, "wash-2").accent]).to.deep.equal([]);
    expect([...resolved(v, "wash").accent]).to.deep.equal([3]);
  });
});

describe("heads: commands, canvas, show check and QLC+ import", () => {
  function plugin() {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-heads-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(WASH, join(dataRoot, "fixtures", "wash-zones.qxf"));
    writeFileSync(join(dataRoot, "fixtures", "blob.qxf"), BLOB);
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const p = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => p.commands.invoke(name, args, systemContext());
    return { run };
  }

  it("makes one canvas cell per zone, none for the halo", async () => {
    const { run } = plugin();
    await run("venue.fixture.put", { fixture: { id: "wash", name: "Wash", manufacturer: "Test", model: "Wash Zones", mode: "18 Channel", universe: 1, address: 1 } });
    const canvas = (await run("venue.canvas.auto", { id: "c", name: "C", fixtures: ["wash"] })) as { cells: number; render: { targets: { head: number }[] }[] };
    expect(canvas.cells).to.equal(3);
    expect(canvas.render.map((r) => r.targets[0]!.head)).to.deep.equal([0, 1, 2]);
  });

  it("sets and clears the accent per model and per fixture", async () => {
    const { run } = plugin();
    for (const [id, address] of [["wash", 1], ["wash-2", 30]] as const) await run("venue.fixture.put", { fixture: { id, name: id, manufacturer: "Test", model: "Wash Zones", mode: "18 Channel", universe: 1, address } });
    type Heads = { deduced: boolean; heads: { head: number; accent: boolean; channels: { name: string }[] }[]; overrides: { model?: unknown; fixture?: unknown } };
    const accentOf = async (fixture: string) => ((await run("venue.fixture.heads", { fixture })) as Heads).heads.filter((h) => h.accent).map((h) => h.channels.map((c) => c.name).join("+"));
    const first = (await run("venue.fixture.heads", { fixture: "wash" })) as Heads;
    expect(first.deduced).to.equal(true);
    expect(await accentOf("wash")).to.deep.equal(["Halo Red+Halo Green+Halo Blue"]);
    // the model: no accent at all
    await run("venue.fixture.heads.set", { fixture: "wash", accent: [] });
    expect(await accentOf("wash-2")).to.deep.equal([]);
    // this fixture: zone 1 is its accent
    const set = (await run("venue.fixture.heads.set", { fixture: "wash-2", scope: "fixture", accent: ["Red 1", "Green 1", "Blue 1", "White 1"] })) as Heads;
    expect(set.overrides).to.deep.equal({ model: { accent: [] }, fixture: { accent: ["Red 1", "Green 1", "Blue 1", "White 1"] } });
    expect(await accentOf("wash-2")).to.deep.equal(["Red 1+Green 1+Blue 1+White 1"]);
    expect(await accentOf("wash")).to.deep.equal([]);
    await run("venue.fixture.heads.clear", { fixture: "wash-2", scope: "fixture" });
    expect(await accentOf("wash-2")).to.deep.equal([]); // the model's again
    await run("venue.fixture.heads.clear", { fixture: "wash" });
    expect(await accentOf("wash-2")).to.deep.equal(["Halo Red+Halo Green+Halo Blue"]); // found by its name again
    let refused = "";
    await run("venue.fixture.heads.set", { fixture: "wash", accent: ["Halo Effect"] }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("Halo Effect");
  });

  it("warns in the show check about colours repeated out of any head, once per model", async () => {
    const { run } = plugin();
    await run("venue.fixture.put", { fixture: { id: "wash", name: "Wash", manufacturer: "Test", model: "Wash Zones", mode: "18 Channel", universe: 1, address: 1 } });
    for (const [id, address] of [["blob-a", 100], ["blob-b", 110]] as const) await run("venue.fixture.put", { fixture: { id, name: id, manufacturer: "Test", model: "Blob", mode: "4 Channel", universe: 1, address } });
    const lint = (await run("show.lint")) as { issues: { level: string; where: string; message: string }[] };
    const escaping = lint.issues.filter((i) => i.message.includes("hors de toute tête"));
    expect(escaping).to.have.length(1); // the wash's zones are deduced: only the blob
    expect(escaping[0]!.where).to.equal("projecteur blob-a, blob-b");
    expect(escaping[0]!.message).to.contain("Red B, Green B");
  });

  it("says which head and whether it is the halo in dmx.explain", async () => {
    const { run } = plugin();
    await run("venue.fixture.put", { fixture: { id: "wash", name: "Wash", manufacturer: "Test", model: "Wash Zones", mode: "18 Channel", universe: 1, address: 1 } });
    const zone = (await run("dmx.explain", { universe: 1, channel: 1 + ZONE(2).red })) as { fixture: { head?: number; accent?: boolean } };
    expect([zone.fixture.head, zone.fixture.accent]).to.deep.equal([1, undefined]);
    const halo = (await run("dmx.explain", { universe: 1, channel: 1 + HALO.red })) as { fixture: { head?: number; accent?: boolean } };
    expect([halo.fixture.head, halo.fixture.accent]).to.deep.equal([3, true]);
  });

  it("keeps a QLC+ workspace fixture without <Head> aimed whole (-1)", () => {
    const ws: QxwWorkspace = {
      qlcVersion: "4",
      fixtures: [{ id: 0, name: "Wash", manufacturer: "Test", model: "Wash Zones", mode: "18 Channel", universe: 0, address: 0, channels: 18 }],
      functions: new Map(),
      widgets: [],
      soloFrames: [],
      fixtureGroups: [{ id: 1, name: "All", width: 1, height: 1, heads: [{ x: 0, y: 0, fixture: 0, head: 0 }] }],
    };
    const p = qxwToShow(ws, [wash()]);
    expect(p.canvas!.render.map((r) => r.targets[0]!.head)).to.deep.equal([-1]);
  });
});
