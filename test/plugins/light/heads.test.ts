import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { accentProblems, headsOf, partOf } from "../../../src/plugins/light/venue/heads.js";
import { parseQxf } from "../../../src/plugins/light/venue/qxf-import.js";
import { emptyFrame, Venue, type ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";
import { modelKey } from "../../../src/plugins/light/venue/overrides.js";
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
    expect(v.toDmx(frame, [buf], new Map(), { now: 0, merge: "last" })).to.deep.equal([]);
    for (const z of [1, 2, 3]) expect([buf[ZONE(z).red], buf[ZONE(z).blue], buf[ZONE(z).white]]).to.deep.equal([255, 128, 0]);
    expect([buf[HALO.red], buf[HALO.blue]]).to.deep.equal([255, 128]);
    // zone 2 alone, another colour on the halo
    const own = emptyFrame();
    own.colors.set("wash", new Map([[1, { green: 1 }], [3, { blue: 1 }]]));
    const out = new Uint8Array(512);
    v.toDmx(own, [out], new Map(), { now: 0, merge: "last" });
    expect([out[ZONE(1).green], out[ZONE(2).green], out[HALO.green], out[HALO.blue]]).to.deep.equal([0, 255, 0, 255]);
  });

  it("lets an unpainted halo follow the brightest of the zones the look paints, unless told not to", () => {
    const v = makeVenue();
    const sheet = () => new Map([["wash", new Map([[0, { red: 1 }], [2, { green: 0.5 }]])]]);
    const look = sheet();
    v.followAccents(look); // per look, before any merge
    expect(look.get("wash")!.get(3)).to.deep.equal({ red: 1, green: 0.5 });
    const frame = emptyFrame();
    frame.colors = look;
    const buf = new Uint8Array(512);
    v.toDmx(frame, [buf], new Map(), { now: 0, merge: "last" });
    expect([buf[HALO.red], buf[HALO.green], buf[HALO.blue]]).to.deep.equal([255, 128, 0]);
    // a whole-fixture colour is spelt out on every head, the halo included
    const whole = new Map([["wash", new Map([[-1, { blue: 1 }]])]]);
    v.followAccents(whole);
    expect([...whole.get("wash")!.keys()]).to.deep.equal([0, 1, 2, 3]);
    // follow false: neither the zones' colour nor a whole-fixture colour reaches the halo
    v.fixtures.put({ ...v.fixtures.get("wash")!, overrides: { heads: { follow: false } } });
    const off = sheet();
    v.followAccents(off);
    expect(off.get("wash")!.has(3)).to.equal(false);
    const offWhole = new Map([["wash", new Map([[-1, { blue: 1 }]])]]);
    v.followAccents(offWhole);
    expect([...offWhole.get("wash")!.keys()]).to.deep.equal([0, 1, 2]);
    const raw = emptyFrame(); // a whole-fixture colour straight to the output does not reach it either
    raw.colors.set("wash", new Map([[-1, { blue: 1 }]]));
    const dark = new Uint8Array(512);
    v.toDmx(raw, [dark], new Map(), { now: 0, merge: "last" });
    expect([dark[ZONE(1).blue], dark[HALO.blue]]).to.deep.equal([255, 0]);
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
    v.toDmx(frame, [buf], new Map(), { now: 0, merge: "last" });
    expect(buf[ZONE(2).red]).to.equal(100); // from black to 200 with the look's weight
    expect(buf[0]).to.equal(255); // the look doses itself by its colours: the dimmer is left alone
    // the halo's colour fades the same way but doses nothing; its effect channel stays a machine
    const halo = emptyFrame();
    halo.raw.set("wash", new Map([[HALO.red, [{ value: 200, weight: 0.5, look: "halo", sheet: "halo" }]]]));
    const hb = new Uint8Array(512);
    v.toDmx(halo, [hb], new Map(), { now: 0, merge: "last" });
    expect([hb[HALO.red], hb[0]]).to.deep.equal([100, 255]);
    const effect = emptyFrame();
    effect.raw.set("wash", new Map([[17, [{ value: 200, weight: 0.5, look: "rainbow", sheet: "rainbow" }]]]));
    const eb = new Uint8Array(512);
    v.toDmx(effect, [eb], new Map(), { now: 0, merge: "last" });
    expect([eb[17], eb[0]]).to.deep.equal([200, 128]); // verbatim, and its weight doses the dimmer
  });

  it("takes the accent from the model's correction, then from the fixture's own", () => {
    const v = makeVenue();
    v.fixtures.put({ id: "wash-2", name: "Wash 2", manufacturer: "Test", model: "Wash Zones", mode: "18 Channel", universe: 1, address: 30 });
    v.models.put({ id: modelKey("Test", "Wash Zones"), manufacturer: "Test", model: "Wash Zones", overrides: { heads: { accent: ["Red 3", "Green 3", "Blue 3", "White 3"] } } });
    for (const id of ["wash", "wash-2"]) {
      const r = resolved(v, id);
      // zone 3 is the accent now, the halo a full head; their numbers do not move (canvases keep their zones)
      expect([...r.accent], id).to.deep.equal([2]);
      expect(r.heads.get(2)).to.deep.equal(ZONE(3));
      expect(r.heads.get(3)).to.deep.equal(HALO);
    }
    v.fixtures.put({ ...v.fixtures.get("wash-2")!, overrides: { heads: { accent: [] } } });
    expect([...resolved(v, "wash-2").accent]).to.deep.equal([]);
    expect([...resolved(v, "wash").accent]).to.deep.equal([2]);
    // the fixture's own correction is merged field by field over its model's: follow alone keeps the model's accent
    v.fixtures.put({ ...v.fixtures.get("wash-2")!, overrides: { heads: { follow: false } } });
    expect([[...resolved(v, "wash-2").accent], resolved(v, "wash-2").follow]).to.deep.equal([[2], false]);
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
    return { run, render: () => p.runtime.render([new Uint8Array(512)]) };
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
    // part of a head: refused, naming the head
    await run("venue.fixture.heads.set", { fixture: "wash", accent: ["Halo Red", "Halo Green"] }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("Halo Red, Halo Green, Halo Blue");
    // every head: refused rather than saved and undone (all accents are full heads)
    refused = "";
    const all = [1, 2, 3].flatMap((z) => [`Red ${z}`, `Green ${z}`, `Blue ${z}`, `White ${z}`]).concat(["Halo Red", "Halo Green", "Halo Blue"]);
    await run("venue.fixture.heads.set", { fixture: "wash", accent: all }).catch((e: Error) => (refused = e.message));
    expect(refused).to.match(/toutes les têtes|every head/);
    expect(((await run("venue.fixture.heads", { fixture: "wash" })) as Heads).overrides).to.deep.equal({});
    // follow: null goes back to the default; the model's view says how many fixtures it reaches
    await run("venue.fixture.heads.set", { fixture: "wash", follow: false });
    type View = Heads & { follow: boolean; model: { fixtures: number; follow: boolean; heads: { accent: boolean }[] } };
    const off = (await run("venue.fixture.heads", { fixture: "wash" })) as View;
    expect([off.follow, off.model.follow, off.model.fixtures, off.overrides]).to.deep.equal([false, false, 2, { model: { follow: false } }]);
    const back = (await run("venue.fixture.heads.set", { fixture: "wash", follow: null })) as View;
    expect([back.follow, back.overrides]).to.deep.equal([true, {}]);
    // the model's list stays the model's when the fixture has its own correction
    await run("venue.fixture.heads.set", { fixture: "wash-2", scope: "fixture", accent: [] });
    const own = (await run("venue.fixture.heads", { fixture: "wash-2" })) as View;
    expect([own.heads.some((h) => h.accent), own.model.heads.some((h) => h.accent)]).to.deep.equal([false, true]);
  });

  it("warns in the show check about colours repeated out of any head, once per model", async () => {
    const { run } = plugin();
    await run("venue.fixture.put", { fixture: { id: "wash", name: "Wash", manufacturer: "Test", model: "Wash Zones", mode: "18 Channel", universe: 1, address: 1 } });
    for (const [id, address] of [["blob-a", 100], ["blob-b", 110]] as const) await run("venue.fixture.put", { fixture: { id, name: id, manufacturer: "Test", model: "Blob", mode: "4 Channel", universe: 1, address } });
    const lint = (await run("show.lint")) as { issues: { level: string; where: string; message: string }[] };
    const escaping = lint.issues.filter((i) => i.message.includes("hors de toute tête"));
    expect(escaping).to.have.length(1); // the wash's zones are deduced: only the blob
    expect(escaping[0]!.where).to.equal("projecteur blob-a, blob-b");
    expect(escaping[0]!.level).to.equal("info"); // often meant so (a mono pixel, an extra channel)
    expect(escaping[0]!.message).to.contain("Red B, Green B");
    expect(escaping[0]!.message).to.contain("« … 1 », « … 2 »"); // numbering works in any language
  });

  it("says which head and whether it is the halo in dmx.explain", async () => {
    const { run, render } = plugin();
    await run("venue.fixture.put", { fixture: { id: "wash", name: "Wash", manufacturer: "Test", model: "Wash Zones", mode: "18 Channel", universe: 1, address: 1 } });
    const zone = (await run("dmx.explain", { universe: 1, channel: 1 + ZONE(2).red })) as { fixture: { head?: number; accent?: boolean } };
    expect([zone.fixture.head, zone.fixture.accent]).to.deep.equal([1, undefined]);
    const halo = (await run("dmx.explain", { universe: 1, channel: 1 + HALO.red })) as { fixture: { head?: number; accent?: boolean } };
    expect([halo.fixture.head, halo.fixture.accent]).to.deep.equal([3, true]);
    // the look painting zone 2 is named on zone 2 and on the halo that follows it, not on zone 1
    await run("venue.canvas.put", { canvas: { id: "z2", name: "Z2", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "wash", head: 1 }] }] } });
    await run("look.put", { look: { id: "rouge", name: "Rouge", canvas: "z2", technique: { kind: "plat", color: "#ff0000" } } });
    await run("look.go", { id: "rouge" });
    render();
    type Why = { paintingLooks?: { name: string }[] };
    const names = async (offset: number) => (((await run("dmx.explain", { universe: 1, channel: 1 + offset })) as Why).paintingLooks ?? []).map((l) => l.name);
    expect([await names(ZONE(2).red), await names(HALO.red), await names(ZONE(1).red)]).to.deep.equal([["Rouge"], ["Rouge"], []]);
    // a whole-fixture look launched after it covers it (looksMerge « last »), and a look stopped with an exit fade is leaving
    await run("venue.canvas.put", { canvas: { id: "all", name: "All", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "wash", head: -1 }] }] } });
    await run("look.put", { look: { id: "bleu", name: "Bleu", canvas: "all", technique: { kind: "plat", color: "#0000ff" } } });
    await run("look.go", { id: "bleu" });
    render();
    type Painting = { paintingLooks?: { name: string; covered?: true; leaving?: true }[] };
    const why = async (offset: number) => ((await run("dmx.explain", { universe: 1, channel: 1 + offset })) as Painting).paintingLooks;
    expect(await why(ZONE(2).red)).to.deep.equal([{ id: "rouge", name: "Rouge", covered: true }, { id: "bleu", name: "Bleu" }]);
    expect(await why(ZONE(1).red)).to.deep.equal([{ id: "bleu", name: "Bleu" }]);
    await run("look.put", { look: { id: "bleu", name: "Bleu", canvas: "all", technique: { kind: "plat", color: "#0000ff" }, timing: { exitFade: 10 } } });
    await run("look.stop", { id: "bleu" });
    render();
    expect(await why(ZONE(2).red)).to.deep.equal([{ id: "bleu", name: "Bleu", leaving: true }, { id: "rouge", name: "Rouge" }]);
  });

  it("names in dmx.explain only the looks that paint the head now: not a look of raw channels, nor a step's empty cells", async () => {
    const { run, render } = plugin();
    await run("venue.fixture.put", { fixture: { id: "wash", name: "Wash", manufacturer: "Test", model: "Wash Zones", mode: "18 Channel", universe: 1, address: 1 } });
    await run("venue.canvas.put", { canvas: { id: "zones", name: "Zones", cells: 3, render: [0, 1, 2].map((i) => ({ from: i, to: i, targets: [{ fixture: "wash", head: i }] })) } });
    await run("look.put", { look: { id: "rouge", name: "Rouge", canvas: "zones", technique: { kind: "plat", color: "#ff0000" } } });
    // on the same canvas, later: a look that only holds a raw channel, and steps painting zone 1 alone (zone 2 dark, zone 3 left empty)
    await run("look.put", { look: { id: "brut", name: "Brut", canvas: "zones", technique: { kind: "aucune" }, channels: { targets: [{ fixture: "wash", offset: 17 }], steps: [[200]] } } });
    await run("look.put", { look: { id: "pas", name: "Pas", canvas: "zones", technique: { kind: "pas", steps: [["#00ff00", "-", ""]] } } });
    for (const id of ["rouge", "brut", "pas"]) await run("look.go", { id });
    render();
    type Painting = { paintingLooks?: { name: string; covered?: true }[] };
    const why = async (offset: number) => (((await run("dmx.explain", { universe: 1, channel: 1 + offset })) as Painting).paintingLooks ?? []).map((l) => `${l.name}${l.covered ? " (covered)" : ""}`);
    expect(await why(ZONE(1).red)).to.deep.equal(["Rouge (covered)", "Pas"]);
    expect(await why(ZONE(2).red)).to.deep.equal(["Rouge (covered)", "Pas"]); // « - » paints black: it covers
    expect(await why(ZONE(3).red)).to.deep.equal(["Rouge"]); // before: « Rouge (covered) », « Brut (covered) », « Pas »
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

/** A definition from channel names and presets (« Red » → IntensityRed; none: a speed channel), its modes listing channel names, and declared heads (names). */
function qxf(model: string, channels: [string, string?][], modes: { name: string; channels: string[]; heads?: string[][] }[] = [{ name: "Mode", channels: channels.map(([n]) => n) }]): string {
  const chans = channels.map(([n, p]) => (p ? `<Channel Name="${n}" Preset="Intensity${p}"/>` : `<Channel Name="${n}"><Group Byte="0">Speed</Group></Channel>`)).join("");
  const mode = (m: (typeof modes)[number]) =>
    `<Mode Name="${m.name}">${m.channels.map((n, i) => `<Channel Number="${i}">${n}</Channel>`).join("")}${(m.heads ?? []).map((h) => `<Head>${h.map((n) => `<Channel>${m.channels.indexOf(n)}</Channel>`).join("")}</Head>`).join("")}</Mode>`;
  return `<?xml version="1.0"?><FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition"><Manufacturer>Test</Manufacturer><Model>${model}</Model><Type>Color Changer</Type>${chans}${modes.map(mode).join("")}</FixtureDefinition>`;
}
/** Each head's channel names (accent ones starred), as headsOf finds them in a mode. */
function headNames(xml: string, overrides?: Parameters<typeof headsOf>[2], modeIndex = 0): string[] {
  const def = parseQxf(xml);
  const mode = def.modes[modeIndex]!;
  const h = headsOf(def, mode, overrides);
  return [...h.heads].map(([i, comps]) => `${h.accent.has(i) ? "*" : ""}${i}:${Object.values(comps).map((o) => mode.channels[o]).join("/")}`);
}

describe("heads: a cautious deduction", () => {
  it("keeps one colour for a fixture that repeats no colour component (RGB+UV, CMY+CTO, RGB+emulated white)", () => {
    expect(headNames(qxf("RGB UV", [["Red", "Red"], ["Green", "Green"], ["Blue", "Blue"], ["U.V.", "UV"]]))).to.deep.equal(["-1:Red/Green/Blue/U.V."]);
    expect(headNames(qxf("CMY CTO", [["Cyan", "Cyan"], ["Magenta", "Magenta"], ["Yellow", "Yellow"], ["CTO"]]))).to.deep.equal(["-1:Cyan/Magenta/Yellow"]);
    expect(headNames(qxf("RGB Emulated", [["Red", "Red"], ["Green", "Green"], ["Blue", "Blue"], ["Emulated White", "White"]]))).to.deep.equal(["-1:Red/Green/Blue/Emulated White"]);
  });

  it("keeps one colour when the parts are no zones: more parts than repetitions, or a lone colour beside full zones", () => {
    // single-colour LEDs numbered as pixels: 8 parts, each component twice
    const pixels = ["Red", "Green", "Blue", "White", "Red", "Green", "Blue", "White"].map((c, i): [string, string] => [`${c} (Pixel ${i + 1})`, c]);
    expect(headNames(qxf("Octa", pixels))).to.have.length(1);
    // a lone red beside one RGB part, with no two parts alike
    const lone = parseQxf(qxf("Lone", [["Red 1", "Red"], ["Red 2", "Red"], ["Green 2", "Green"], ["Blue 2", "Blue"]]));
    const h = headsOf(lone, lone.modes[0]!);
    expect([[...h.heads.keys()], h.deduced]).to.deep.equal([[-1], false]);
    expect(h.escaped.map((o) => lone.modes[0]!.channels[o])).to.deep.equal(["Red 2"]);
  });

  it("keeps zones alike and leaves a lone colour beside them out of any head (4 RGBW spots + a UV dimmer)", () => {
    const spots = [1, 2, 3, 4].flatMap((n): [string, string][] => [[`Spot ${n} Red`, "Red"], [`Spot ${n} Green`, "Green"], [`Spot ${n} Blue`, "Blue"], [`Spot ${n} White`, "White"]]);
    const def = parseQxf(qxf("Spots UV", [...spots, ["UV Dimmer", "UV"]]));
    const h = headsOf(def, def.modes[0]!);
    expect(h.deduced).to.equal(true);
    expect(headNames(qxf("Spots UV", [...spots, ["UV Dimmer", "UV"]]))).to.deep.equal([1, 2, 3, 4].map((n) => `${n - 1}:Spot ${n} Red/Spot ${n} Green/Spot ${n} Blue/Spot ${n} White`));
    expect(h.escaped).to.deep.equal([]); // UV is in no head: nothing repeats it out of one
    // a red for the whole fixture lights the 4 spots, not spot 1 alone
    const dir = mkdtempSync(join(tmpdir(), "light-heads-spots-"));
    mkdirSync(join(dir, "fixtures"));
    writeFileSync(join(dir, "fixtures", "spots.qxf"), qxf("Spots UV", [...spots, ["UV Dimmer", "UV"]]));
    const venue = new Venue(new FolderStore(join(dir, "venue")), [join(dir, "fixtures")]);
    venue.fixtures.put({ id: "spots", name: "Spots", manufacturer: "Test", model: "Spots UV", mode: "Mode", universe: 1, address: 1 });
    const frame = emptyFrame();
    frame.colors.set("spots", new Map([[-1, { red: 1 }]]));
    const buf = new Uint8Array(512);
    venue.toDmx(frame, [buf], new Map(), { now: 0, merge: "last" });
    expect([0, 4, 8, 12].map((o) => buf[o])).to.deep.equal([255, 255, 255, 255]);
    expect(buf[16]).to.equal(0); // the UV
  });

  it("puts an unnumbered first zone first when only the others are numbered (« Red, Red 2, Red 3 »)", () => {
    const rgb = (suffix: string): [string, string][] => [[`Red${suffix}`, "Red"], [`Green${suffix}`, "Green"], [`Blue${suffix}`, "Blue"]];
    expect(headNames(qxf("Red 23", [...rgb(""), ...rgb(" 2"), ...rgb(" 3")]))).to.deep.equal(["0:Red/Green/Blue", "1:Red 2/Green 2/Blue 2", "2:Red 3/Green 3/Blue 3"]);
    expect(headNames(qxf("Red only", [["Red", "Red"], ["Red 2", "Red"], ["Red 3", "Red"]]))).to.deep.equal(["0:Red", "1:Red 2", "2:Red 3"]);
    // a part already numbered 1: the unnumbered one is 0, still first
    expect(headNames(qxf("Red 12", [...rgb(" 1"), ...rgb(""), ...rgb(" 2")]))).to.deep.equal(["0:Red/Green/Blue", "1:Red 1/Green 1/Blue 1", "2:Red 2/Green 2/Blue 2"]);
    // a halo stays after the numbered zones
    expect(headNames(qxf("Red halo", [...rgb(""), ...rgb(" 2"), ["Halo Red", "Red"], ["Halo Green", "Green"], ["Halo Blue", "Blue"]]))).to.deep.equal(["0:Red/Green/Blue", "1:Red 2/Green 2/Blue 2", "*2:Halo Red/Halo Green/Halo Blue"]);
  });

  it("never takes a laser or a colour channel cut into functions for a colour: no zone, and no whole-fixture colour writes it", () => {
    const laser = (name: string, colour: string) =>
      `<Channel Name="${name}"><Group Byte="0">Intensity</Group><Colour>${colour}</Colour><Capability Min="0" Max="4">Blackout</Capability><Capability Min="5" Max="54">On</Capability><Capability Min="55" Max="255">Strobe slow-fast</Capability></Channel>`;
    const strobing = `<Channel Name="White"><Group Byte="0">Intensity</Group><Colour>White</Colour><Capability Min="0" Max="9">Off</Capability><Capability Min="10" Max="127">Dimmer</Capability><Capability Min="128" Max="255">Sound active</Capability></Channel>`;
    const plainRgb = `<Channel Name="Red" Preset="IntensityRed"/><Channel Name="Green" Preset="IntensityGreen"/><Channel Name="Blue" Preset="IntensityBlue"/>`;
    const switched = `<Channel Name="Amber"><Group Byte="0">Intensity</Group><Colour>Amber</Colour><Capability Min="0" Max="127">Off</Capability><Capability Min="128" Max="255">On</Capability></Channel>`;
    const xml = `<?xml version="1.0"?><FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition"><Manufacturer>Test</Manufacturer><Model>Bar</Model><Type>Effect</Type>${laser("Red Laser", "Red")}${laser("Green Laser", "Green")}${strobing}${plainRgb}${switched}
<Mode Name="M">${["Red Laser", "Green Laser", "White", "Red", "Green", "Blue", "Amber"].map((n, i) => `<Channel Number="${i}">${n}</Channel>`).join("")}</Mode></FixtureDefinition>`;
    const def = parseQxf(xml);
    const h = headsOf(def, def.modes[0]!);
    // before: « Red Laser / Green Laser » became a second zone; now one colour, the lasers and the strobing white left out
    expect([...h.heads.entries()]).to.deep.equal([[-1, { red: 3, green: 4, blue: 5, amber: 6 }]]);
    expect(h.escaped).to.deep.equal([]);
    expect(accentProblems(def, ["Red Laser"]).unknown).to.deep.equal(["Red Laser"]);
  });

  it("keeps a fixture whose colour channels are all cut into functions a colour fixture: not painted, its wheel untouched", () => {
    // a laser effect with RGB LEDs: each colour channel fades by itself above 127, and a « Color » channel picks the laser's colour
    const cut = (name: string) =>
      `<Channel Name="${name}"><Group Byte="0">Intensity</Group><Colour>${name}</Colour><Capability Min="0" Max="127">${name}</Capability><Capability Min="128" Max="169">Fade in (0~100%)</Capability><Capability Min="170" Max="209">Fade out (100%~0)</Capability><Capability Min="210" Max="255">Alternating fade</Capability></Channel>`;
    const wheel = `<Channel Name="Color"><Group Byte="0">Colour</Group><Capability Min="0" Max="4" Preset="ColorMacro" Res1="#000000">Blackout</Capability><Capability Min="5" Max="28" Preset="ColorMacro" Res1="#ff0000">Red</Capability><Capability Min="29" Max="56" Preset="ColorMacro" Res1="#00ff00">Green</Capability></Channel>`;
    const xml = (names: string[]) => `<?xml version="1.0"?><FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition"><Manufacturer>Test</Manufacturer><Model>Laser Wash</Model><Type>Effect</Type>${wheel}${cut("Red")}${cut("Green")}${cut("Blue")}<Channel Name="Dimmer" Preset="IntensityDimmer"/>
<Mode Name="M">${names.map((n, i) => `<Channel Number="${i}">${n}</Channel>`).join("")}</Mode></FixtureDefinition>`;
    const full = xml(["Color", "Red", "Green", "Blue", "Dimmer"]);
    const def = parseQxf(full);
    const h = headsOf(def, def.modes[0]!);
    expect([...h.heads.entries()]).to.deep.equal([[-1, {}]]); // no plain colour
    expect(h.mixes).to.equal(true); // and still colour channels: no lamp
    const dir = mkdtempSync(join(tmpdir(), "light-heads-laser-"));
    mkdirSync(join(dir, "fixtures"));
    writeFileSync(join(dir, "fixtures", "laser-wash.qxf"), full);
    const venue = new Venue(new FolderStore(join(dir, "venue")), [join(dir, "fixtures")]);
    venue.fixtures.put({ id: "lw", name: "LW", manufacturer: "Test", model: "Laser Wash", mode: "M", universe: 1, address: 1 });
    expect(resolved(venue, "lw").lampOnly).to.equal(false);
    expect(venue.hasWheel("lw")).to.equal(false);
    // before: taken for a lamp, a red look turned the « Color » channel to its red slot (17: the laser, red) and left the LEDs dark
    const frame = emptyFrame();
    frame.colors.set("lw", new Map([[-1, { red: 1 }]]));
    const buf = new Uint8Array(512);
    venue.toDmx(frame, [buf], new Map(), { now: 0, merge: "last" });
    expect([...buf.slice(0, 5)]).to.deep.equal([0, 0, 0, 0, 255]); // the wheel and the three colours: left to raw channels
    // the same mode without its colour channels is a lamp, and its wheel answers the painted colour
    const lamp = parseQxf(xml(["Color", "Dimmer"]));
    expect(headsOf(lamp, lamp.modes[0]!).mixes).to.equal(false);
  });

  it("doses a fixture whose colour channels all run functions by its dimmer, as a lamp: no full white beam no look doses", () => {
    // a moving head whose CMY channels spin past their saturation range, with a dimmer and an open shutter (no wheel)
    const cmy = (name: string) =>
      `<Channel Name="${name}"><Group Byte="0">Intensity</Group><Colour>${name}</Colour><Capability Min="0" Max="0">Open white</Capability><Capability Min="1" Max="128">${name} (0% to 100% saturation)</Capability><Capability Min="129" Max="172">Media scan</Capability><Capability Min="173" Max="255">Forward spin (slow to fast)</Capability></Channel>`;
    const shutter = `<Channel Name="Shutter"><Group Byte="0">Shutter</Group><Capability Min="0" Max="0" Preset="ShutterOpen">Open</Capability><Capability Min="1" Max="255" Preset="StrobeRandom">Random</Capability></Channel>`;
    const xml = `<?xml version="1.0"?><FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition"><Manufacturer>Test</Manufacturer><Model>CMY Beam</Model><Type>Moving Head</Type><Channel Name="Dim" Preset="IntensityDimmer"/>${shutter}${cmy("Cyan")}${cmy("Magenta")}${cmy("Yellow")}
<Mode Name="M">${["Dim", "Shutter", "Cyan", "Magenta", "Yellow"].map((n, i) => `<Channel Number="${i}">${n}</Channel>`).join("")}</Mode></FixtureDefinition>`;
    const dir = mkdtempSync(join(tmpdir(), "light-heads-cmy-"));
    mkdirSync(join(dir, "fixtures"));
    writeFileSync(join(dir, "fixtures", "cmy-beam.qxf"), xml);
    const venue = new Venue(new FolderStore(join(dir, "venue")), [join(dir, "fixtures")]);
    venue.fixtures.put({ id: "beam", name: "Beam", manufacturer: "Test", model: "CMY Beam", mode: "M", universe: 1, address: 1 });
    const r = resolved(venue, "beam");
    expect([...r.heads.entries()]).to.deep.equal([[-1, {}]]); // no plain colour
    expect(r.lampOnly).to.equal(false); // colour channels: no lamp, no wheel driven by the painted colour
    expect(r.levelDimmer).to.equal(true); // but nothing to paint: the dimmer follows the painted level
    const out = (color?: { red: number; green: number; blue: number }) => {
      const frame = emptyFrame();
      if (color) frame.colors.set("beam", new Map([[-1, color]]));
      const buf = new Uint8Array(512);
      venue.toDmx(frame, [buf], new Map(), { now: 0, merge: "last" });
      return { dmx: [...buf.slice(0, 5)], display: venue.displayColors([buf]).beam };
    };
    const g = 32 / 255;
    // before: Dim 255 whatever the looks, CMY 0 and the shutter open: a full white beam, shown black in the preview
    expect(out({ red: g, green: g, blue: g })).to.deep.equal({ dmx: [32, 0, 0, 0, 0], display: ["#202020"] });
    expect(out({ red: 0, green: 0, blue: 0 })).to.deep.equal({ dmx: [0, 0, 0, 0, 0], display: ["#000000"] });
    expect(out()).to.deep.equal({ dmx: [0, 0, 0, 0, 0], display: ["#000000"] });
  });

  it("joins a qualified lone channel to the part sharing the most words (« Spot » and « Spot Inner » both prefix it)", () => {
    const rgb = (part: string): [string, string][] => [[`${part} - Red`, "Red"], [`${part} - Green`, "Green"], [`${part} - Blue`, "Blue"]];
    const xml = qxf("Spots", [...rgb("Spot"), ...rgb("Spot Inner"), ["Spot Inner - White - all pixels", "White"]]);
    const names = headNames(xml);
    expect(names).to.have.length(2);
    expect(names.some((n) => n.endsWith("Spot Inner - Blue/Spot Inner - White - all pixels"))).to.equal(true);
    expect(names.some((n) => n.includes("White") && n.startsWith("0:Spot - Red"))).to.equal(false);
  });

  it("shows white x dimmer only for subtractive colour channels: an RGB split into functions stays dark at 0", () => {
    const fn = (name: string) => `<Channel Name="${name}"><Group Byte="0">Intensity</Group><Colour>${name}</Colour><Capability Min="0" Max="0">Open white</Capability><Capability Min="1" Max="128">${name} (0% to 100%)</Capability><Capability Min="129" Max="255">Forward spin (slow to fast)</Capability></Channel>`;
    const defn = (model: string, colours: string[]) => `<?xml version="1.0"?><FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition"><Manufacturer>Test</Manufacturer><Model>${model}</Model><Type>Moving Head</Type><Channel Name="Dim" Preset="IntensityDimmer"/>${colours.map(fn).join("")}
<Mode Name="M">${["Dim", ...colours].map((n, i) => `<Channel Number="${i}">${n}</Channel>`).join("")}</Mode></FixtureDefinition>`;
    const dir = mkdtempSync(join(tmpdir(), "light-heads-eclipse-"));
    mkdirSync(join(dir, "fixtures"));
    writeFileSync(join(dir, "fixtures", "eclipse.qxf"), defn("Eclipse", ["Red", "Green", "Blue"]));
    writeFileSync(join(dir, "fixtures", "cmy.qxf"), defn("CMY", ["Cyan", "Magenta", "Yellow"]));
    const venue = new Venue(new FolderStore(join(dir, "venue")), [join(dir, "fixtures")]);
    venue.fixtures.put({ id: "ecl", name: "E", manufacturer: "Test", model: "Eclipse", mode: "M", universe: 1, address: 1 });
    venue.fixtures.put({ id: "cmy", name: "C", manufacturer: "Test", model: "CMY", mode: "M", universe: 1, address: 11 });
    expect(resolved(venue, "ecl").levelDimmer).to.equal(true);
    const buf = new Uint8Array(512);
    buf[0] = 255; // Eclipse dimmer full, its colour channels at 0: dark
    buf[10] = 255; // CMY dimmer full, 0 = open white
    const shown = venue.displayColors([buf]);
    expect(shown.ecl).to.deep.equal(["#000000"]);
    expect(shown.cmy).to.deep.equal(["#ffffff"]);
  });

  it("never takes a resolution for a part number: « Flower Effect 1 - Red (8bit) » is part 1, « Background - Red (8bit) » no number", () => {
    expect(partOf("Flower Effect 1 - Red (8bit)")).to.deep.equal({ words: "flower effect", number: 1 });
    expect(partOf("Background - Red (8bit)")).to.deep.equal({ words: "background" });
    expect(partOf("Red 16 bit")).to.deep.equal({ words: "" });
    expect(partOf("Spot 2 Red (16-bit)")).to.deep.equal({ words: "spot", number: 2 });
    // a moving head with two flower effects and a background: the numbered effects first, then the background as
    // patched; its « White … - all pixels » only qualifies the background and joins it
    const rgbw = (part: string): [string, string][] => ["Red", "Green", "Blue", "White"].map((c) => [`${part} - ${c} (8bit)`, c]);
    const bg: [string, string][] = [...rgbw("Background").slice(0, 3), ["Background - White (8bit) - all pixels", "White"]];
    const xml = qxf("Flowers", [...bg, ...rgbw("Flower Effect 1"), ...rgbw("Flower Effect 2")]);
    expect(headNames(xml)).to.deep.equal([
      "0:Flower Effect 1 - Red (8bit)/Flower Effect 1 - Green (8bit)/Flower Effect 1 - Blue (8bit)/Flower Effect 1 - White (8bit)",
      "1:Flower Effect 2 - Red (8bit)/Flower Effect 2 - Green (8bit)/Flower Effect 2 - Blue (8bit)/Flower Effect 2 - White (8bit)",
      "2:Background - Red (8bit)/Background - Green (8bit)/Background - Blue (8bit)/Background - White (8bit) - all pixels",
    ]);
    const def = parseQxf(xml);
    expect(headsOf(def, def.modes[0]!).escaped).to.deep.equal([]);
  });

  it("names a part by its first number: « Spots 1+4 » comes before « Spots 2+3 »", () => {
    expect(partOf("Spots 2+3 Red")).to.deep.equal({ words: "spots", number: 2 });
    expect(partOf("Spots 1+4 Red")).to.deep.equal({ words: "spots", number: 1 });
    const pair = (n: string): [string, string][] => [[`Spots ${n} Red`, "Red"], [`Spots ${n} Green`, "Green"], [`Spots ${n} Blue`, "Blue"]];
    // before: the last number won (4 and 3), and « Spots 2+3 » became the first head
    expect(headNames(qxf("Pairs", [...pair("1+4"), ...pair("2+3")]))).to.deep.equal(["0:Spots 1+4 Red/Spots 1+4 Green/Spots 1+4 Blue", "1:Spots 2+3 Red/Spots 2+3 Green/Spots 2+3 Blue"]);
  });

  it("finds the zones by the number left once the colour words are out, in French or English, wherever it stands", () => {
    expect(partOf("Rouge 2")).to.deep.equal({ words: "", number: 2 });
    expect(partOf("LED 1 Red")).to.deep.equal({ words: "", number: 1 });
    expect(partOf("Red (1)")).to.deep.equal({ words: "", number: 1 });
    expect(partOf("1 Red")).to.deep.equal({ words: "", number: 1 });
    expect(partOf("Spot 1 Red")).to.deep.equal({ words: "spot", number: 1 });
    const fr = qxf("FR", [["Rouge 1", "Red"], ["Vert 1", "Green"], ["Bleu 1", "Blue"], ["Rouge 2", "Red"], ["Vert 2", "Green"], ["Bleu 2", "Blue"]]);
    expect(headNames(fr)).to.deep.equal(["0:Rouge 1/Vert 1/Bleu 1", "1:Rouge 2/Vert 2/Bleu 2"]);
    const led = qxf("LED", [["LED 1 Red", "Red"], ["LED 1 Green", "Green"], ["LED 2 Red", "Red"], ["LED 2 Green", "Green"]]);
    expect(headNames(led)).to.deep.equal(["0:LED 1 Red/LED 1 Green", "1:LED 2 Red/LED 2 Green"]);
    // a white told apart by its temperature is not a second zone
    expect(headNames(qxf("TW", [["Warm White", "White"], ["Cool White", "White"]]))).to.deep.equal(["-1:Warm White"]);
  });

  it("names accents carefully: no back face, no numbered ring, no declared ring; a declared halo or aura is one", () => {
    const sides = qxf("Sides", [["Front Red", "Red"], ["Front Green", "Green"], ["Back Red", "Red"], ["Back Green", "Green"]]);
    expect(headNames(sides)).to.deep.equal(["0:Front Red/Front Green", "1:Back Red/Back Green"]);
    const rings = qxf("Rings", [["Ring 1 Red", "Red"], ["Ring 1 Green", "Green"], ["Ring 2 Red", "Red"], ["Ring 2 Green", "Green"]]);
    expect(headNames(rings)).to.deep.equal(["0:Ring 1 Red/Ring 1 Green", "1:Ring 2 Red/Ring 2 Green"]);
    const chans: [string, string][] = [["Beam Red", "Red"], ["Beam Green", "Green"], ["Ring Red", "Red"], ["Ring Green", "Green"]];
    const declared = [{ name: "M", channels: chans.map(([n]) => n), heads: [["Beam Red", "Beam Green"], ["Ring Red", "Ring Green"]] }];
    expect(headNames(qxf("Declared ring", chans, declared))).to.deep.equal(["0:Beam Red/Beam Green", "1:Ring Red/Ring Green"]);
    const aura: [string, string][] = [["Beam Red", "Red"], ["Beam Green", "Green"], ["Aura Red", "Red"], ["Aura Green", "Green"]];
    const auraModes = [{ name: "M", channels: aura.map(([n]) => n), heads: [["Beam Red", "Beam Green"], ["Aura Red", "Aura Green"]] }];
    expect(headNames(qxf("Aura", aura, auraModes))).to.deep.equal(["0:Beam Red/Beam Green", "*1:Aura Red/Aura Green"]);
  });

  it("makes every part a full head when they are all named as accents, and keeps the head numbers whatever the accent", () => {
    const halos = qxf("Halos", [["Halo 1 Red", "Red"], ["Halo 1 Green", "Green"], ["Halo 2 Red", "Red"], ["Halo 2 Green", "Green"]]);
    expect(headNames(halos)).to.deep.equal(["0:Halo 1 Red/Halo 1 Green", "1:Halo 2 Red/Halo 2 Green"]);
    // zone 1 marked as the accent stays head 0: a canvas cell on head 1 keeps driving zone 2
    const marked = headNames(readFileSync(WASH, "utf8"), { accent: ["Red 1", "Green 1", "Blue 1", "White 1"] });
    expect(marked.slice(0, 2)).to.deep.equal(["*0:Red 1/Green 1/Blue 1/White 1", "1:Red 2/Green 2/Blue 2/White 2"]);
  });

  it("applies an accent list only to the modes that have one of its channels, detecting by name in the others", () => {
    const chans: [string, string][] = [["Red 1", "Red"], ["Green 1", "Green"], ["Red 2", "Red"], ["Green 2", "Green"], ["Halo Red", "Red"], ["Halo Green", "Green"], ["Halo R", "Red"], ["Halo G", "Green"]];
    const xml = qxf("Two modes", chans, [
      { name: "Full", channels: ["Red 1", "Green 1", "Red 2", "Green 2", "Halo Red", "Halo Green"] },
      { name: "Short", channels: ["Red 1", "Green 1", "Red 2", "Green 2", "Halo R", "Halo G"] },
    ]);
    expect(headNames(xml, { accent: ["Red 2", "Green 2"] }, 0).filter((h) => h.startsWith("*"))).to.deep.equal(["*1:Red 2/Green 2"]);
    expect(headNames(xml, { accent: ["Halo Red", "Halo Green"] }, 1).filter((h) => h.startsWith("*"))).to.deep.equal(["*2:Halo R/Halo G"]); // by name: none of its channels in this mode
    // a list covering part of a head, or naming no colour channel, is told
    const problems = accentProblems(parseQxf(xml), ["Halo Red", "Red 2", "Speed"]);
    expect(problems.unknown).to.deep.equal(["Speed"]);
    expect(problems.partial).to.deep.equal([
      { mode: "Full", head: ["Red 2", "Green 2"] },
      { mode: "Full", head: ["Halo Red", "Halo Green"] },
      { mode: "Short", head: ["Red 2", "Green 2"] },
    ]);
    expect(accentProblems(parseQxf(xml), ["Halo Red", "Halo Green", "Halo R", "Halo G"])).to.deep.equal({ unknown: [], partial: [], every: [] });
    // every head marked: no full head would be left beside the accent
    expect(accentProblems(parseQxf(xml), ["Red 1", "Green 1", "Red 2", "Green 2", "Halo Red", "Halo Green"]).every).to.deep.equal(["Full"]);
  });

  it("does not report colours a definition with declared heads keeps out of them (a master, a background)", () => {
    const chans: [string, string][] = [["Red (all pixels)", "Red"], ["Red 1", "Red"], ["Green 1", "Green"], ["Red 2", "Red"], ["Green 2", "Green"]];
    const def = parseQxf(qxf("Master", chans, [{ name: "M", channels: chans.map(([n]) => n), heads: [["Red 1", "Green 1"], ["Red 2", "Green 2"]] }]));
    expect(headsOf(def, def.modes[0]!).escaped).to.deep.equal([]);
  });
});
