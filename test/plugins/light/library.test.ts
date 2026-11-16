import { expect } from "chai";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext, type CommandError } from "../../../src/plugins/light/commands/registry.js";
import { applyFixtures, definitionDirsFor, planFixtures } from "../../../src/plugins/light/data/archive-fixtures.js";
import { decodeDefinition, encodeDefinition } from "../../../src/plugins/light/venue/definition-files.js";
import { packArchive, readArchive } from "../../../src/plugins/light/data/archive.js";
import { aliasedDefinitions, aliasLookup, aliasTarget, modeTable, retargetAliases, type Alias } from "../../../src/plugins/light/venue/aliases.js";
import { moveToTrash, renameDefinition } from "../../../src/plugins/light/venue/library.js";
import { parseQxf } from "../../../src/plugins/light/venue/qxf-import.js";

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");
const BAR = fixture("bar4.qxf");
const SPOT = fixture("spot.qxf");
/** The same bar under another name (one fixture sold under two names). */
const BAR_OTHER = BAR.replace("<Manufacturer>Test</Manufacturer>", "<Manufacturer>Other</Manufacturer>").replace("<Model>Bar 4</Model>", "<Model>Pixel Bar</Model>").replace('<Mode Name="15 Channel">', '<Mode Name="15ch">');
/** Bar 4 with one more channel name changed: another definition of the same model. */
const BAR_CHANGED = BAR.replace('Name="Strobe"', 'Name="Flash"').replace(/>Strobe</g, ">Flash<");

type Row = { id: string; folder: string; manufacturer: string; model: string; winner: boolean; copies: string[]; sameStructure: { model: string }[]; usedBy: { id: string }[]; overrides: boolean; aliasedTo?: { model: string }; aliasedFrom?: { model: string }[] };
type List = { definitions: Row[]; aliases: (Alias & { fixtures: number })[]; trash: number };

describe("fixture library (T20b)", () => {
  let dataRoot: string;
  let plugin: LightPlugin;
  const clock = Date.parse("2026-11-16T10:00:00Z");
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  const list = async (args: unknown = {}) => (await run("library.list", args)) as List;
  const shared = () => join(dataRoot, "fixtures");
  const own = () => join(dataRoot, "venues", "default", "fixture-definitions");
  const put = (id: string, manufacturer: string, model: string, mode: string, address = 1) => run("venue.fixture.put", { fixture: { id, name: id.toUpperCase(), manufacturer, model, mode, universe: 1, address } });
  const failure = async (p: Promise<unknown>) => p.then(() => expect.fail("refused expected"), (e: unknown) => e as CommandError);

  beforeEach(() => {
    dataRoot = join(mkdtempSync(join(tmpdir(), "light-library-")), "data");
    mkdirSync(shared(), { recursive: true });
    writeFileSync(join(shared(), "bar4.qxf"), BAR);
    writeFileSync(join(shared(), "spot.qxf"), SPOT);
    writeFileSync(join(shared(), "pixel-bar.qxf"), BAR_OTHER);
    let cfg: Record<string, unknown> = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async (c) => void (cfg = c as Record<string, unknown>) }, dataRoot, midiNative: null, now: () => clock });
  });
  afterEach(() => rmSync(join(dataRoot, ".."), { recursive: true, force: true }));

  it("lists every file with its folder, its winner, its usage and its duplicates, then the generic dimmer", async () => {
    // the same structure under another name (its modes named alike)
    writeFileSync(join(shared(), "twin.qxf"), BAR.replace("<Model>Bar 4</Model>", "<Model>Twin Bar</Model>"));
    writeFileSync(join(shared(), "bar4-copy.qxf"), BAR);
    await put("bar", "Test", "Bar 4", "15 Channel");
    const { definitions } = await list();
    expect(definitions.map((d) => d.id)).to.deep.equal(["shared/bar4-copy.qxf", "shared/bar4.qxf", "shared/pixel-bar.qxf", "shared/spot.qxf", "shared/twin.qxf", "builtin/generic"]);
    const bar = definitions[0]!;
    expect(bar).to.deep.include({ folder: "shared", manufacturer: "Test", model: "Bar 4", winner: true, copies: ["shared/bar4-copy.qxf", "shared/bar4.qxf"] });
    expect(definitions[1]).to.deep.include({ winner: false });
    expect(bar.usedBy).to.deep.equal([{ id: "bar", name: "BAR" }]);
    expect(bar.sameStructure).to.deep.equal([{ manufacturer: "Test", model: "Twin Bar" }]);
    // filters
    expect((await list({ used: true })).definitions.map((d) => d.id)).to.deep.equal(["shared/bar4-copy.qxf"]);
    expect((await list({ search: "pixel" })).definitions.map((d) => d.id)).to.deep.equal(["shared/pixel-bar.qxf"]);
    expect((await list({ duplicates: true })).definitions.map((d) => d.id)).to.deep.equal(["shared/bar4-copy.qxf", "shared/bar4.qxf", "shared/twin.qxf"]);
    expect((await list({ manufacturer: "other" })).definitions).to.have.length(1);
    expect((await list({ type: "moving head" })).definitions.map((d) => d.model)).to.deep.equal(["Spot 7"]);
  });

  it("reads one definition and compares two", async () => {
    const got = (await run("library.get", { id: "shared/bar4.qxf" })) as { xml: string; modes: { name: string; channels: string[] }[] };
    expect(got.xml).to.equal(BAR);
    expect(got.modes[0]!.channels).to.have.length(15);
    writeFileSync(join(shared(), "bar4-b.qxf"), BAR_CHANGED);
    expect(await run("library.diff", { a: "shared/bar4.qxf", b: "shared/bar4-b.qxf" })).to.deep.include({ identical: false });
    expect(await run("library.diff", { a: "shared/bar4.qxf", b: "shared/bar4.qxf" })).to.deep.include({ identical: true });
    expect((await failure(run("library.get", { id: "shared/../x.qxf" }))).message).to.match(/inconnue/);
  });

  it("lists 600 definitions in less than 200 ms", async () => {
    // 600 models, many of one structure (a range shares its layout): the worst case for the duplicates
    for (let i = 0; i < 600; i++) writeFileSync(join(shared(), `gen-${String(i).padStart(3, "0")}.qxf`), BAR.replace("<Model>Bar 4</Model>", `<Model>Gen ${i}</Model>`).replace('Max="127">Manual', `Max="${i % 120}">Manual`));
    await list(); // the first read parses the files
    const start = performance.now();
    const { definitions } = await list({ search: "gen 59" });
    expect(performance.now() - start).to.be.below(200);
    expect(definitions.length).to.be.greaterThan(0);
  });

  describe("delete, trash, restore", () => {
    it("refuses to delete a definition in use, naming the fixtures, then moves it to the trash with force and restores it", async () => {
      await put("bar", "Test", "Bar 4", "15 Channel");
      const refused = await failure(run("library.delete", { id: "shared/bar4.qxf" }));
      expect(refused.message).to.contain("BAR");
      expect(refused.detail).to.deep.include({ force: true });
      expect(await run("library.delete", { id: "shared/bar4.qxf", dryRun: true })).to.deep.include({ deleted: false, refused: true });
      expect(existsSync(join(shared(), "bar4.qxf"))).to.equal(true);
      const done = (await run("library.delete", { id: "shared/bar4.qxf", force: true })) as { trash: string };
      expect(existsSync(join(shared(), "bar4.qxf"))).to.equal(false);
      expect(plugin.runtime.venue.resolve("bar")).to.have.property("error"); // missing definition, said by show.lint
      const trash = (await run("library.trash")) as { id: string; file: string; folder: string; model: string; deletedAt: string }[];
      expect(trash).to.have.length(1);
      expect(trash[0]).to.deep.include({ id: done.trash, file: "bar4.qxf", folder: "shared", model: "Bar 4", deletedAt: "2026-11-16T10:00:00.000Z" });
      expect(await run("library.restore", { id: done.trash })).to.deep.include({ file: "bar4.qxf", folder: "shared" });
      expect(plugin.runtime.venue.resolve("bar")).to.not.have.property("error");
      expect(await run("library.trash")).to.deep.equal([]);
    });

    it("deletes an unused copy without force, and empties the trash for good", async () => {
      await put("bar", "Test", "Bar 4", "15 Channel");
      writeFileSync(join(shared(), "bar4-copy.qxf"), BAR);
      await run("library.delete", { id: "shared/bar4-copy.qxf" }); // a loser copy: nobody resolves it
      // the winner, with an identical copy left: its fixtures fall back on it, no force needed
      writeFileSync(join(shared(), "bar4-copy.qxf"), BAR);
      expect(await run("library.delete", { id: "shared/bar4.qxf" })).to.deep.include({ deleted: true, fallback: "shared/bar4-copy.qxf", identicalFallback: true });
      expect(((await list()).trash)).to.equal(2);
      expect(await run("library.trash.empty")).to.deep.include({ count: 2 });
      expect(await run("library.trash")).to.deep.equal([]);
    });

    it("refuses to delete a shared definition another venue uses", async () => {
      const other = join(dataRoot, "venues", "hall", "fixtures");
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, "spot-1.json"), JSON.stringify({ id: "spot-1", name: "Hall spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1 }));
      const refused = await failure(run("library.delete", { id: "shared/spot.qxf" }));
      expect(refused.detail).to.deep.include({ otherVenues: [{ venue: "hall", name: "hall", fixtures: ["Hall spot"], modes: ["Standard"] }] });
      // that venue's own copy would take over there: then the shared file is free to go
      mkdirSync(join(dataRoot, "venues", "hall", "fixture-definitions"), { recursive: true });
      writeFileSync(join(dataRoot, "venues", "hall", "fixture-definitions", "spot.qxf"), SPOT);
      expect(await run("library.delete", { id: "shared/spot.qxf" })).to.deep.include({ deleted: true, otherVenues: [] });
    });
  });

  describe("duplicate", () => {
    it("copies under a new model name into the venue's folder, with the model's corrections, the original untouched", async () => {
      await put("spot", "Test", "Spot 7", "Standard");
      await run("venue.wheel.put", { id: "spot", scope: "model", wheel: { doubles: false } });
      const copy = (await run("library.duplicate", { id: "shared/spot.qxf" })) as { id: string; model: string; copiedOverrides: boolean };
      expect(copy).to.deep.include({ id: "venue/Test-Spot-7-copie-.qxf", model: "Spot 7 (copie)", copiedOverrides: true });
      expect(readFileSync(join(shared(), "spot.qxf"), "utf8")).to.equal(SPOT);
      expect(parseQxf(readFileSync(join(own(), "Test-Spot-7-copie-.qxf"), "utf8")).model).to.equal("Spot 7 (copie)");
      expect(plugin.runtime.venue.models.get("test_spot7copie")?.overrides.wheel).to.deep.equal({ doubles: false });
      expect((plugin.runtime.venue.resolve("spot") as { def: { model: string } }).def.model).to.equal("Spot 7"); // the patch is unchanged
      // again: the next free name; a name given that exists is refused
      expect(await run("library.duplicate", { id: "shared/spot.qxf" })).to.deep.include({ model: "Spot 7 (copie 2)" });
      expect((await failure(run("library.duplicate", { id: "shared/spot.qxf", model: "Bar 4" }))).message).to.match(/déjà/);
    });

    it("keeps the name for a copy of this venue, which then wins over the shared one (decision Q1)", async () => {
      await put("spot", "Test", "Spot 7", "Standard");
      const copy = (await run("library.duplicate", { id: "shared/spot.qxf", sameName: true })) as { id: string; takesOver: { id: string }[] };
      expect(copy).to.deep.include({ id: "venue/spot.qxf", takesOver: [{ id: "spot", name: "SPOT" }] });
      const rows = (await list({ search: "spot 7" })).definitions;
      expect(rows.map((r) => [r.id, r.winner])).to.deep.equal([["venue/spot.qxf", true], ["shared/spot.qxf", false]]);
      expect((await failure(run("library.duplicate", { id: "shared/spot.qxf", sameName: true }))).message).to.match(/déjà sa copie/);
    });

    it("renames by the text, everything else to the byte", () => {
      const out = renameDefinition(SPOT, { model: "A & B" });
      expect(out).to.equal(SPOT.replace("<Model>Spot 7</Model>", "<Model>A &amp; B</Model>"));
      expect(parseQxf(out).model).to.equal("A & B");
    });
  });

  describe("decision Q1: the venue's own folder is read first", () => {
    const VENUE_SPOT = SPOT.replace('<Mode Name="Basic">', '<Mode Name="Venue basic">');
    beforeEach(() => {
      mkdirSync(own(), { recursive: true });
      writeFileSync(join(own(), "zz-spot.qxf"), VENUE_SPOT);
    });

    it("orders the folders venue first", () => {
      expect(definitionDirsFor("/d", "v")).to.deep.equal([join("/d", "venues", "v", "fixture-definitions"), join("/d", "fixtures")]);
    });

    it("resolves a patched fixture with the venue's copy", async () => {
      plugin.runtime.venue.refreshDefinitions(); // dropped while the server runs: read at the next library listing
      await put("spot", "Test", "Spot 7", "Venue basic");
      expect(plugin.runtime.venue.resolve("spot")).to.not.have.property("error");
      expect(plugin.runtime.venue.definitionFor("Test", "Spot 7")!.modes.map((m) => m.name)).to.include("Venue basic");
    });

    it("packs the venue's copy in an archive", async () => {
      await put("spot", "Test", "Spot 7", "Standard");
      const zip = unzipSync(packArchive({ venue: { id: "default", dir: join(dataRoot, "venues", "default") }, definitionDirs: definitionDirsFor(dataRoot, "default") }));
      expect(Object.keys(zip).filter((k) => k.startsWith("fixtures/"))).to.deep.equal(["fixtures/zz-spot.qxf"]);
      expect(strFromU8(zip["fixtures/zz-spot.qxf"]!)).to.equal(VENUE_SPOT);
    });

    it("compares a restored definition with the venue's copy", () => {
      const plan = planFixtures({ "spot.qxf": SPOT }, [], definitionDirsFor(dataRoot, "default"), shared());
      expect(plan.entries[0]).to.deep.include({ status: "differs", target: join(own(), "zz-spot.qxf") });
      expect(planFixtures({ "spot.qxf": VENUE_SPOT }, [], definitionDirsFor(dataRoot, "default"), shared()).entries[0]!.status).to.equal("same");
    });

    it("names the venue's copy as the duplicate that wins", async () => {
      const dups = (await run("library.duplicates")) as { sameName: { winner: string; others: { source: string }[] }[] };
      expect(dups.sameName).to.have.length(1);
      expect(dups.sameName[0]).to.deep.include({ winner: "venue/zz-spot.qxf" });
      expect(dups.sameName[0]!.others.map((o) => o.source)).to.deep.equal(["shared/spot.qxf"]);
      expect(plugin.runtime.venue.duplicateDefinitions().sameName[0]!.winner).to.equal("zz-spot.qxf");
    });
  });

  describe("merge", () => {
    it("pick: keeps one file of a model, the others to the trash, the fixtures unchanged", async () => {
      writeFileSync(join(shared(), "bar4-b.qxf"), BAR_CHANGED);
      await put("bar", "Test", "Bar 4", "15 Channel");
      // a file of the model read before the kept one must go too, or the kept one would not win
      writeFileSync(join(shared(), "bar4-c.qxf"), BAR);
      expect((await failure(run("library.merge", { keep: "shared/bar4.qxf", drop: ["shared/bar4-b.qxf"], as: "pick" }))).message).to.match(/shared\/bar4-c.qxf passerait encore avant/);
      rmSync(join(shared(), "bar4-c.qxf"));
      const done = (await run("library.merge", { keep: "shared/bar4-b.qxf", drop: ["shared/bar4.qxf"], as: "pick" })) as { merged: boolean; trashed: unknown[]; differs: string[] };
      expect(done).to.deep.include({ merged: true, differs: ["shared/bar4.qxf"] });
      expect(readdirSync(shared()).sort()).to.deep.equal(["bar4-b.qxf", "pixel-bar.qxf", "spot.qxf"]);
      expect(plugin.runtime.venue.fixtures.get("bar")).to.deep.include({ manufacturer: "Test", model: "Bar 4", mode: "15 Channel" });
      expect((plugin.runtime.venue.resolve("bar") as { def: { channels: Map<string, unknown> } }).def.channels.has("Flash")).to.equal(true);
    });

    it("pick: refuses when a mode in use exists only in a dropped file", async () => {
      writeFileSync(join(shared(), "bar4-b.qxf"), BAR.replace('<Mode Name="15 Channel">', '<Mode Name="Other">'));
      await put("bar", "Test", "Bar 4", "15 Channel");
      const refused = await failure(run("library.merge", { keep: "shared/bar4-b.qxf", drop: ["shared/bar4.qxf"], as: "pick" }));
      expect(refused.detail).to.deep.include({ lostModes: ["15 Channel"] });
      expect(existsSync(join(shared(), "bar4.qxf"))).to.equal(true);
    });

    it("alias: the old name's fixtures resolve the target, mode by the table, address and patch unchanged; unalias undoes it", async () => {
      await put("pix", "Other", "Pixel Bar", "15ch", 20);
      const plan = (await run("library.merge", { keep: "shared/bar4.qxf", drop: ["shared/pixel-bar.qxf"], as: "alias", dryRun: true })) as { modes: Record<string, string>; unmapped: string[]; fixtures: unknown[] };
      // « 15ch » and « 15 Channel » are one mode by their channel count
      expect(plan).to.deep.include({ modes: { "15ch": "15 Channel" }, unmapped: [] });
      expect(plugin.runtime.venue.aliases.list()).to.deep.equal([]); // a dry run writes nothing
      await run("library.merge", { keep: "shared/bar4.qxf", drop: ["shared/pixel-bar.qxf"], as: "alias" });
      const r = plugin.runtime.venue.resolve("pix") as { def: { model: string }; mode: { name: string } };
      expect([r.def.model, r.mode.name]).to.deep.equal(["Bar 4", "15 Channel"]);
      expect(plugin.runtime.venue.fixtures.get("pix")).to.deep.include({ manufacturer: "Other", model: "Pixel Bar", mode: "15ch", address: 20 });
      const rows = (await list()).definitions;
      expect(rows.find((d) => d.id === "shared/pixel-bar.qxf")).to.deep.include({ aliasedTo: { manufacturer: "Test", model: "Bar 4" } });
      expect(rows.find((d) => d.id === "shared/bar4.qxf")!.usedBy).to.deep.equal([{ id: "pix", name: "PIX" }]);
      await run("library.unalias", { id: "other_pixelbar" });
      expect((plugin.runtime.venue.resolve("pix") as { def: { model: string } }).def.model).to.equal("Pixel Bar");
    });

    it("alias: refuses a mode in use without an equivalent until the table names it", async () => {
      await put("pix", "Other", "Pixel Bar", "15ch");
      writeFileSync(join(shared(), "pixel-bar.qxf"), BAR_OTHER.replace("</Mode>", '</Mode><Mode Name="Tiny"><Channel Number="0">Dimmer</Channel></Mode>'));
      await put("tiny", "Other", "Pixel Bar", "Tiny", 40);
      const refused = await failure(run("library.merge", { keep: "shared/bar4.qxf", drop: ["shared/pixel-bar.qxf"], as: "alias" }));
      expect(refused.detail).to.deep.include({ unmapped: ["Tiny"] });
      // mapped onto a mode with more channels: the footprint changes, force says yes
      const changes = await failure(run("library.merge", { keep: "shared/bar4.qxf", drop: ["shared/pixel-bar.qxf"], as: "alias", modes: { Tiny: "15 Channel" } }));
      expect(changes.detail).to.deep.include({ channelChanges: [{ mode: "Tiny", to: "15 Channel", from: 1, channels: 15 }] });
      await run("library.merge", { keep: "shared/bar4.qxf", drop: ["shared/pixel-bar.qxf"], as: "alias", modes: { Tiny: "15 Channel" }, force: true });
      expect((plugin.runtime.venue.resolve("tiny") as { mode: { name: string } }).mode.name).to.equal("15 Channel");
    });

    it("alias: copies the old name's corrections onto the target, asks when the target has its own (decision Q5)", async () => {
      await put("pix", "Other", "Pixel Bar", "15ch");
      await put("bar", "Test", "Bar 4", "15 Channel", 30);
      await run("venue.fixture.heads.set", { fixture: "pix", scope: "model", follow: false });
      const args = { keep: "shared/bar4.qxf", drop: ["shared/pixel-bar.qxf"], as: "alias" };
      // no correction on the target: copied there, the old name keeps its own
      await run("library.merge", args);
      const models = plugin.runtime.venue.models;
      expect(models.get("test_bar4")?.overrides.heads).to.deep.equal({ follow: false });
      expect(models.get("other_pixelbar")?.overrides.heads).to.deep.equal({ follow: false });
      expect(plugin.runtime.venue.overridesOf(plugin.runtime.venue.fixtures.get("pix")!).heads).to.deep.equal({ follow: false });
      // both have their own: asked
      await run("library.unalias", { id: "other_pixelbar" });
      await run("venue.fixture.heads.set", { fixture: "bar", scope: "model", accent: [] });
      const refused = await failure(run("library.merge", args));
      expect(refused.detail).to.deep.include({ overrides: "conflict", overridesConflict: { source: { heads: { follow: false } }, target: { heads: { follow: false, accent: [] } } } });
      await run("library.merge", { ...args, overrides: "target" });
      expect(models.get("test_bar4")?.overrides.heads).to.deep.equal({ follow: false, accent: [] });
      await run("library.unalias", { id: "other_pixelbar" });
      await run("library.merge", { ...args, overrides: "source" });
      expect(models.get("test_bar4")?.overrides.heads).to.deep.equal({ follow: false });
    });

    it("alias: an archive carries the target's definition, and a QLC+ import citing the old name finds it", async () => {
      await put("pix", "Other", "Pixel Bar", "15ch");
      await run("library.merge", { keep: "shared/bar4.qxf", drop: ["shared/pixel-bar.qxf"], as: "alias" });
      rmSync(join(shared(), "pixel-bar.qxf")); // the old file gone: the alias alone carries it
      const zip = unzipSync(packArchive({ venue: { id: "default", dir: join(dataRoot, "venues", "default") }, definitionDirs: definitionDirsFor(dataRoot, "default") }));
      expect(Object.keys(zip).filter((k) => k.startsWith("fixtures/"))).to.deep.equal(["fixtures/bar4.qxf"]);
      const defs = plugin.runtime.venue.definitionsThroughAliases();
      expect(defs[0]).to.deep.include({ manufacturer: "Other", model: "Pixel Bar" });
      expect(defs[0]!.modes.map((m) => m.name)).to.include("15ch");
    });

    it("alias: points an alias of the old model at the new target (one hop)", () => {
      const a: Alias = { id: "x_a", from: { manufacturer: "X", model: "A" }, to: { manufacturer: "Y", model: "B" }, modes: { m1: "n1" } };
      const b: Alias = { id: "y_b", from: { manufacturer: "Y", model: "B" }, to: { manufacturer: "Z", model: "C" }, modes: { n1: "p1" } };
      expect(retargetAliases([a], b)).to.deep.equal([{ ...a, to: b.to, previousTo: a.to, modes: { m1: "p1" } }]);
      // its old model's modes named in the new table go through it too; a key of the new one alone does not leak in
      expect(retargetAliases([a], { ...b, modes: { n1: "p1", z9: "q" } }, () => ["n1"])[0]!.modes).to.deep.equal({ m1: "p1", n1: "p1" });
      const lookup = aliasLookup([b]);
      expect(aliasTarget(lookup, { manufacturer: "y", model: "b ", mode: "n1" })).to.deep.include({ manufacturer: "Z", model: "C", mode: "p1" });
      expect(aliasTarget(lookup, { manufacturer: "Q", model: "R", mode: "n1" })).to.deep.equal({ manufacturer: "Q", model: "R", mode: "n1" });
    });

    it("finds the mode table by name, loose name and channel count, and refuses a given mode the target lacks", () => {
      const from = parseQxf(BAR_OTHER);
      const to = parseQxf(BAR);
      expect(modeTable(from, to, [{ mode: "15ch", channels: 15 }])).to.deep.equal({ modes: { "15ch": "15 Channel" }, unmapped: [], channelChanges: [] });
      expect(() => modeTable(from, to, [], { "15ch": "Nope" })).to.throw(/Nope/);
      expect(aliasedDefinitions([to], [], () => to)).to.deep.equal([to]);
    });
  });

  describe("review 1", () => {
    const hall = () => join(dataRoot, "venues", "hall");
    const hallUses = (model: string, mode: string) => {
      mkdirSync(join(hall(), "fixtures"), { recursive: true });
      writeFileSync(join(hall(), "fixtures", "h1.json"), JSON.stringify({ id: "h1", name: "Hall one", manufacturer: "Test", model, mode, universe: 1, address: 1 }));
    };

    it("B1: merging a model others already follow names them, maps their modes and keeps their previous target", async () => {
      // « Third Bar » has no file: it follows Pixel Bar by its name alone (I8), its mode T15 mapped by hand
      writeFileSync(join(shared(), "pixel-bar.qxf"), BAR_OTHER.replace("</Mode>", '</Mode><Mode Name="Tiny"><Channel Number="0">Dimmer</Channel></Mode>'));
      await put("third", "Other", "Third Bar", "T15");
      await put("third2", "Other", "Third Bar", "T1", 40);
      await run("library.merge", { keep: "shared/pixel-bar.qxf", from: { manufacturer: "Other", model: "Third Bar" }, as: "alias", modes: { T15: "15ch", T1: "Tiny" } });
      expect((plugin.runtime.venue.resolve("third2") as { mode: { name: string } }).mode.name).to.equal("Tiny");
      // Pixel Bar → Bar 4: Third Bar's fixtures come along, Tiny (theirs through T1) has no equivalent in Bar 4
      const args = { keep: "shared/bar4.qxf", drop: ["shared/pixel-bar.qxf"], as: "alias" };
      const plan = (await run("library.merge", { ...args, dryRun: true })) as { following: { from: { model: string }; fixtures: { id: string }[] }[]; unmapped: string[]; refused: boolean };
      expect(plan.following).to.deep.equal([{ from: { manufacturer: "Other", model: "Third Bar" }, fixtures: [{ id: "third", name: "THIRD" }, { id: "third2", name: "THIRD2" }] }]);
      expect(plan).to.deep.include({ unmapped: ["Tiny"], refused: true });
      expect((await failure(run("library.merge", args))).detail).to.deep.include({ unmapped: ["Tiny"] });
      const done = (await run("library.merge", { ...args, modes: { Tiny: "15 Channel" }, force: true })) as { retargeted: { from: { model: string }; previousTo: { model: string } }[] };
      expect(done.retargeted[0]).to.deep.include({ previousTo: { manufacturer: "Other", model: "Pixel Bar" } });
      for (const id of ["third", "third2"]) expect((plugin.runtime.venue.resolve(id) as { def: { model: string }; mode: { name: string } }).def.model).to.equal("Bar 4");
      expect((plugin.runtime.venue.resolve("third2") as { mode: { name: string } }).mode.name).to.equal("15 Channel");
      // an unknown key of the table is said
      await run("library.unalias", { id: "other_pixelbar" });
      expect((await failure(run("library.merge", { ...args, modes: { Nope: "15 Channel" } }))).message).to.match(/Nope/);
    });

    it("B2: another venue never loses its definition without a yes, even with an identical copy here", async () => {
      hallUses("Spot 7", "Standard");
      writeFileSync(join(shared(), "spot2.qxf"), SPOT); // identical, read after spot.qxf
      const refused = await failure(run("library.delete", { id: "shared/spot.qxf" }));
      expect(refused.detail).to.deep.include({ identicalFallback: true, force: true });
      // pick: a shared keep must have the modes the other venue uses
      writeFileSync(join(shared(), "spot2.qxf"), SPOT.replace('<Mode Name="Standard">', '<Mode Name="Other">'));
      const pick = await failure(run("library.merge", { keep: "shared/spot2.qxf", drop: ["shared/spot.qxf"], as: "pick" }));
      expect(pick.detail).to.deep.include({ lostModes: ["hall : Standard"] });
      expect(existsSync(join(shared(), "spot.qxf"))).to.equal(true);
    });

    it("B3: a Latin-1 definition is read, copied and renamed without losing a byte", async () => {
      const text = SPOT.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"').replace("<Model>Spot 7</Model>", "<Model>Spöt 7</Model>").replace("<Author>light-mcp-server tests</Author>", "<Author>Équipe</Author>");
      const bytes = Buffer.from(text, "latin1");
      writeFileSync(join(shared(), "latin.qxf"), bytes);
      const got = (await run("library.get", { id: "shared/latin.qxf" })) as { xml: string; base64?: string };
      expect(got.base64).to.equal(bytes.toString("base64"));
      expect(got.xml).to.contain("Équipe");
      const same = (await run("library.duplicate", { id: "shared/latin.qxf", sameName: true })) as { id: string };
      expect(readFileSync(join(own(), same.id.slice("venue/".length)))).to.deep.equal(bytes);
      const copy = (await run("library.duplicate", { id: "shared/latin.qxf", model: "Copie ü ŵ" })) as { id: string };
      const out = readFileSync(join(own(), copy.id.slice("venue/".length)));
      expect(out.toString("latin1")).to.equal(text.replace("<Model>Spöt 7</Model>", "<Model>Copie ü &#x175;</Model>"));
      // read back as the library reads it: the reference decoded, the requested name; the library sees the accents
      expect(parseQxf(out.toString("latin1")).model).to.equal("Copie ü ŵ");
      plugin.runtime.venue.refreshDefinitions();
      expect(plugin.runtime.venue.libraryFileFor("Test", "Copie ü ŵ")).to.not.equal(undefined);
      expect(plugin.runtime.venue.libraryFileFor("Test", "Spöt 7")).to.not.equal(undefined);
      expect(await run("library.duplicate", { id: "shared/latin.qxf" })).to.deep.include({ model: "Spöt 7 (copie)" });
    });

    it("I1: a file with accents and commas is usable; leaving the folder is refused", async () => {
      writeFileSync(join(shared(), "Été, bar.qxf"), BAR.replace("<Model>Bar 4</Model>", "<Model>Summer</Model>"));
      expect(await run("library.get", { id: "shared/Été, bar.qxf" })).to.deep.include({ model: "Summer" });
      await run("library.delete", { id: "shared/Été, bar.qxf" });
      for (const id of ["shared/../fixtures/bar4.qxf", "shared/..", "venue/a\\b.qxf", "shared/a\u0000.qxf", "other/bar4.qxf"]) expect((await failure(run("library.get", { id }))).message).to.match(/inconnue/);
    });

    it("I2: « Remplacer » keeps the old version in the trash, never overwrites another model in use, says a venue copy leaves the shared file", async () => {
      const v2 = SPOT.replace('<Mode Name="Basic">', '<Mode Name="Basic 2">');
      expect(await run("fixture.definition.add", { name: "x.qxf", xml: v2, replace: true })).to.deep.include({ file: "spot.qxf", replaced: true });
      const trash = (await run("library.trash")) as { file: string; reason?: string; id: string }[];
      expect(trash).to.have.length(1);
      expect(trash[0]).to.deep.include({ file: "spot.qxf", reason: "replaced" });
      await run("library.restore", { id: trash[0]!.id }); // the old version back beside the new one
      expect(readdirSync(shared()).filter((f) => f.startsWith("spot")).sort()).to.deep.equal(["spot-2.qxf", "spot.qxf"]);
      // a file of that name holding another model fixtures use: refused, even with replace
      await put("bar", "Test", "Bar 4", "15 Channel");
      const fresh = SPOT.replace("<Model>Spot 7</Model>", "<Model>Fresh</Model>");
      const refused = await failure(run("fixture.definition.add", { name: "bar4.qxf", xml: fresh, replace: true }));
      expect(refused.detail).to.deep.include({ otherModel: { manufacturer: "Test", model: "Bar 4" }, usedBy: [{ id: "bar", name: "BAR" }] });
      // this venue's copy replaced: the shared file stays as it was for the other venues
      await run("library.duplicate", { id: "shared/pixel-bar.qxf", sameName: true });
      const r = await run("fixture.definition.add", { name: "pixel-bar.qxf", xml: BAR_OTHER.replace("<Type>", "<!-- v3 --><Type>").replace('Name="Program"', 'Name="Prog"').replace(/>Program</g, ">Prog<"), replace: true });
      expect(r).to.deep.include({ folder: "venue", sharedUnchanged: true });
      expect(readFileSync(join(shared(), "pixel-bar.qxf"), "utf8")).to.equal(BAR_OTHER);
    });

    it("I3 (L3): changing the mode of a fixture patched under an alias repatches it on the target, the alias staying", async () => {
      await put("pix", "Other", "Pixel Bar", "15ch");
      await run("library.merge", { keep: "shared/bar4.qxf", drop: ["shared/pixel-bar.qxf"], as: "alias" });
      const listed = ((await run("venue.fixture.list")) as { id: string; resolvesAs?: unknown }[]).find((f) => f.id === "pix")!;
      expect(listed.resolvesAs).to.deep.equal({ manufacturer: "Test", model: "Bar 4", mode: "15 Channel" });
      const plan = (await run("venue.fixture.mode", { id: "pix", mode: "15 Channel", dryRun: true })) as { renamed?: unknown; channels: { before: number } };
      expect(plan.renamed).to.deep.equal({ from: { manufacturer: "Other", model: "Pixel Bar" }, to: { manufacturer: "Test", model: "Bar 4" } });
      expect(plan.channels.before).to.equal(15);
      await run("venue.fixture.mode", { id: "pix", mode: "15 Channel" });
      expect(plugin.runtime.venue.fixtures.get("pix")).to.deep.include({ manufacturer: "Test", model: "Bar 4", mode: "15 Channel" });
      expect(plugin.runtime.venue.aliases.get("other_pixelbar")).to.not.equal(undefined);
    });

    it("I4: a definition of a venue gone since is restored into the shared folder, never into a ghost venue", async () => {
      mkdirSync(own(), { recursive: true });
      writeFileSync(join(own(), "gone.qxf"), BAR.replace("<Model>Bar 4</Model>", "<Model>Gone</Model>"));
      const id = moveToTrash(dataRoot, join(own(), "gone.qxf"), { folder: "venue", venue: "ghost", manufacturer: "Test", model: "Gone" }, clock);
      expect(await run("library.restore", { id })).to.deep.include({ folder: "shared", toShared: true, file: "gone.qxf" });
      expect(existsSync(join(dataRoot, "venues", "ghost"))).to.equal(false);
      expect(existsSync(join(shared(), "gone.qxf"))).to.equal(true);
      const bad = moveToTrash(dataRoot, join(shared(), "gone.qxf"), { folder: "venue", venue: "../x", manufacturer: "Test", model: "Gone" }, clock);
      expect(await run("library.restore", { id: bad })).to.deep.include({ toShared: true });
    });

    it("I7: deleting an alias' target names the alias, removes it on request; the fixture's error says where the alias points", async () => {
      await put("pix", "Other", "Pixel Bar", "15ch");
      await run("library.merge", { keep: "shared/bar4.qxf", drop: ["shared/pixel-bar.qxf"], as: "alias" });
      const plan = (await run("library.delete", { id: "shared/bar4.qxf", dryRun: true })) as { aliases: { id: string; fixtures: { id: string }[] }[] };
      expect(plan.aliases).to.deep.equal([{ id: "other_pixelbar", from: { manufacturer: "Other", model: "Pixel Bar" }, fixtures: [{ id: "pix", name: "PIX" }] }]);
      await run("library.delete", { id: "shared/bar4.qxf", force: true });
      expect((plugin.runtime.venue.resolve("pix") as { error: string }).error).to.contain("alias vers Test Bar 4 introuvable");
      await run("library.restore", { id: ((await run("library.trash")) as { id: string }[])[0]!.id });
      expect(await run("library.delete", { id: "shared/bar4.qxf", force: true, dropAliases: true })).to.deep.include({ droppedAliases: [{ manufacturer: "Other", model: "Pixel Bar" }] });
      expect(plugin.runtime.venue.aliases.list()).to.deep.equal([]);
    });

    it("L4: emptying the trash needs show:admin; its dry run lists what goes; an unreadable entry stays", async () => {
      await run("library.delete", { id: "shared/spot.qxf" });
      mkdirSync(join(dataRoot, "backups", "deleted-definitions", "broken"), { recursive: true });
      writeFileSync(join(dataRoot, "backups", "deleted-definitions", "broken", "meta.json"), "{oops");
      const regisseur = { origin: "ui" as const, can: (r: string) => r === "show:write" || r === "dashboards:view" };
      expect(((await failure(plugin.commands.invoke("library.trash.empty", {}, regisseur))) as CommandError).code).to.equal("forbidden");
      expect(await run("library.trash.empty", { dryRun: true })).to.deep.include({ count: 1, removed: [{ id: ((await run("library.trash")) as { id: string }[])[0]!.id, file: "spot.qxf", manufacturer: "Test", model: "Spot 7", folder: "shared", deletedAt: "2026-11-16T10:00:00.000Z" }] });
      expect(await run("library.trash.empty")).to.deep.include({ count: 1 });
      expect(existsSync(join(dataRoot, "backups", "deleted-definitions", "broken"))).to.equal(true);
    });

    it("copies the corrections only when the new name has none, and says so", async () => {
      await put("spot", "Test", "Spot 7", "Standard");
      expect(await run("library.duplicate", { id: "shared/spot.qxf" })).to.deep.include({ copiedOverrides: false });
      await run("venue.wheel.put", { id: "spot", scope: "model", wheel: { doubles: false } });
      expect(await run("library.duplicate", { id: "shared/spot.qxf" })).to.deep.include({ copiedOverrides: true });
    });
  });

  describe("review 2", () => {
    const hallUses = (model: string, mode: string) => {
      mkdirSync(join(dataRoot, "venues", "hall", "fixtures"), { recursive: true });
      writeFileSync(join(dataRoot, "venues", "hall", "fixtures", "h1.json"), JSON.stringify({ id: "h1", name: "Hall one", manufacturer: "Test", model, mode, universe: 1, address: 1 }));
    };
    const V2 = SPOT.replace('<Mode Name="Basic">', '<Mode Name="Basic 2">');

    it("1: restoring the old version « Remplacer » kept says it would win, and asks before changing a fixture's definition", async () => {
      await put("spot", "Test", "Spot 7", "Standard");
      await run("fixture.definition.add", { name: "spot.qxf", xml: V2, replace: true });
      const trash = ((await run("library.trash")) as { id: string }[])[0]!.id;
      // back as spot-2.qxf, read before spot.qxf: it would take over for the patched spot
      const plan = (await run("library.restore", { id: trash, dryRun: true })) as Record<string, unknown>;
      expect(plan).to.deep.include({ file: "spot-2.qxf", winner: true, displaces: "spot.qxf", identical: false, copies: ["shared/spot.qxf"], usedBy: [{ id: "spot", name: "SPOT" }], refused: true });
      expect((await failure(run("library.restore", { id: trash }))).detail).to.deep.include({ force: true });
      expect(existsSync(join(shared(), "spot-2.qxf"))).to.equal(false);
      await run("library.restore", { id: trash, force: true });
      expect(plugin.runtime.venue.definitionFor("Test", "Spot 7")!.modes.map((m) => m.name)).to.include("Basic");
    });

    it("1: a restore that would change another venue's definition asks too; one that displaces nothing does not", async () => {
      hallUses("Spot 7", "Standard");
      // an older Spot 7 trashed as « a-spot.qxf »: back in the shared folder, it is read before spot.qxf
      writeFileSync(join(shared(), "a-spot.qxf"), V2);
      const trash = moveToTrash(dataRoot, join(shared(), "a-spot.qxf"), { folder: "shared", manufacturer: "Test", model: "Spot 7" }, clock);
      const plan = (await run("library.restore", { id: trash, dryRun: true })) as { otherVenues: { venue: string }[]; refused: boolean; displaces?: string };
      expect(plan.displaces).to.equal("spot.qxf");
      expect(plan.otherVenues.map((v) => v.venue)).to.deep.equal(["hall"]);
      expect(plan.refused).to.equal(true);
      // a model nobody resolves elsewhere: put back without a question
      await run("library.delete", { id: "shared/pixel-bar.qxf" });
      const free = ((await run("library.trash")) as { id: string; model: string }[]).find((e) => e.model === "Pixel Bar")!.id;
      expect(await run("library.restore", { id: free })).to.deep.include({ restored: true, winner: true, usedBy: [], otherVenues: [] });
    });

    it("3: « Remplacer » on a shared file another venue uses checks its modes, and never gives it another model", async () => {
      hallUses("Spot 7", "Standard");
      const noStandard = SPOT.replace('<Mode Name="Standard">', '<Mode Name="Std">');
      const refused = await failure(run("fixture.definition.add", { name: "spot.qxf", xml: noStandard, replace: true }));
      expect(refused.detail).to.deep.include({ lostModes: ["hall : Standard"], force: true });
      expect(readFileSync(join(shared(), "spot.qxf"), "utf8")).to.equal(SPOT);
      expect(await run("fixture.definition.add", { name: "spot.qxf", xml: V2, replace: true })).to.deep.include({ otherVenues: [{ venue: "hall", name: "hall", fixtures: ["Hall one"], modes: ["Standard"] }] });
      await run("fixture.definition.add", { name: "spot.qxf", xml: noStandard, replace: true, force: true });
      // a file of that name holding the model another venue uses, replaced by another model: refused
      const other = await failure(run("fixture.definition.add", { name: "spot.qxf", xml: SPOT.replace("<Model>Spot 7</Model>", "<Model>Fresh</Model>"), replace: true }));
      expect(other.detail).to.deep.include({ otherModel: { manufacturer: "Test", model: "Spot 7" } });
      expect((other.detail as { otherVenues: { venue: string }[] }).otherVenues.map((v) => v.venue)).to.deep.equal(["hall"]);
    });

    it("L3: another mode repatches that fixture on the target; a second fixture of the alias is left as it was", async () => {
      writeFileSync(join(shared(), "bar4.qxf"), BAR.replace("</Mode>", '</Mode><Mode Name="Small"><Channel Number="0">Dimmer</Channel></Mode>'));
      await put("pix", "Other", "Pixel Bar", "15ch");
      await put("pix2", "Other", "Pixel Bar", "15ch", 20);
      await run("library.merge", { keep: "shared/bar4.qxf", drop: ["shared/pixel-bar.qxf"], as: "alias" });
      const plan = (await run("venue.fixture.mode", { id: "pix", mode: "Small", dryRun: true })) as { from: string; to: string; renamed?: unknown };
      expect(plan).to.deep.include({ from: "15 Channel", to: "Small" });
      await run("venue.fixture.mode", { id: "pix", mode: "Small", force: true });
      expect(plugin.runtime.venue.fixtures.get("pix")).to.deep.include({ manufacturer: "Test", model: "Bar 4", mode: "Small" });
      expect(plugin.runtime.venue.fixtures.get("pix2")).to.deep.include({ manufacturer: "Other", model: "Pixel Bar", mode: "15ch" });
      expect((plugin.runtime.venue.resolve("pix2") as { mode: { name: string } }).mode.name).to.equal("15 Channel");
    });

    it("pick with force: another venue loses the shared file it used when the kept one is this venue's own", async () => {
      hallUses("Spot 7", "Standard");
      await run("library.duplicate", { id: "shared/spot.qxf", sameName: true });
      const args = { keep: "venue/spot.qxf", drop: ["shared/spot.qxf"], as: "pick" };
      expect((await failure(run("library.merge", args))).detail).to.deep.include({ losesDefinition: ["hall"], force: true });
      expect(await run("library.merge", { ...args, force: true })).to.deep.include({ merged: true, losesDefinition: ["hall"] });
      expect(existsSync(join(shared(), "spot.qxf"))).to.equal(false);
    });

    it("unalias names the aliases a merge re-pointed through it", async () => {
      await put("third", "Other", "Third Bar", "T15");
      await run("library.merge", { keep: "shared/pixel-bar.qxf", from: { manufacturer: "Other", model: "Third Bar" }, as: "alias", modes: { T15: "15ch" } });
      await run("library.merge", { keep: "shared/bar4.qxf", drop: ["shared/pixel-bar.qxf"], as: "alias" });
      const plan = (await run("library.unalias", { id: "other_pixelbar", dryRun: true })) as { repointed: unknown[] };
      expect(plan.repointed).to.deep.equal([{ from: { manufacturer: "Other", model: "Third Bar" }, to: { manufacturer: "Test", model: "Bar 4" }, previousTo: { manufacturer: "Other", model: "Pixel Bar" } }]);
    });
  });

  describe("review 3", () => {
    const hallUses = (model: string, mode: string) => {
      mkdirSync(join(dataRoot, "venues", "hall", "fixtures"), { recursive: true });
      writeFileSync(join(dataRoot, "venues", "hall", "fixtures", "h1.json"), JSON.stringify({ id: "h1", name: "Hall one", manufacturer: "Test", model, mode, universe: 1, address: 1 }));
    };
    const LATIN = readFileSync(new URL("../../fixtures/latin1-eclat.qxf", import.meta.url));

    it("UB1: a Latin-1 .qxf imported as bytes is written byte for byte and read with its accents", async () => {
      const r = await run("fixture.definition.add", { name: "eclat.qxf", base64: LATIN.toString("base64") });
      expect(r).to.deep.include({ file: "eclat.qxf", manufacturer: "Société Fictive", model: "Projecteur Éclat" });
      expect(readFileSync(join(shared(), "eclat.qxf"))).to.deep.equal(LATIN);
      expect(plugin.runtime.venue.definitionFor("Société Fictive", "Projecteur Éclat")!.modes.map((m) => m.name)).to.deep.equal(["Défaut", "Réduit"]);
      // the same bytes again: nothing written
      expect(await run("fixture.definition.add", { name: "eclat.qxf", base64: LATIN.toString("base64") })).to.deep.include({ unchanged: true });
    });

    it("I1/M1: « Remplacer » asks before dropping or relaying a mode this venue's fixtures use, and says the other venues", async () => {
      await put("s", "Test", "Spot 7", "Standard");
      const noStandard = SPOT.replace('<Mode Name="Standard">', '<Mode Name="Std">');
      const refused = await failure(run("fixture.definition.add", { name: "spot.qxf", xml: noStandard, replace: true }));
      expect(refused.detail).to.deep.include({ lostModes: ["Standard"], usedBy: [{ id: "s", name: "S" }], force: true });
      expect(readFileSync(join(shared(), "spot.qxf"), "utf8")).to.equal(SPOT);
      // the same mode name, other channels: asked too
      const relaid = SPOT.replace(/<Mode Name="Standard">([\s\S]*?)<\/Mode>/, (m) => m.replace("<Channel Number=\"0\">Pan</Channel>", "<Channel Number=\"0\">Dimmer</Channel>"));
      expect((await failure(run("fixture.definition.add", { name: "spot.qxf", xml: relaid, replace: true }))).detail).to.deep.include({ changedModes: ["Standard"] });
      expect(await run("fixture.definition.add", { name: "spot.qxf", xml: noStandard, replace: true, dryRun: true })).to.deep.include({ refused: true, lostModes: ["Standard"] });
      await run("fixture.definition.add", { name: "spot.qxf", xml: noStandard, replace: true, force: true });
      // other venues are named in the result
      hallUses("Spot 7", "Std");
      expect(await run("fixture.definition.add", { name: "spot.qxf", xml: SPOT.replace('<Mode Name="Standard">', '<Mode Name="Std">').replace("<Type>", "<!-- v3 --><Type>"), replace: true, force: true })).to.deep.include({ otherVenues: [{ venue: "hall", name: "hall", fixtures: ["Hall one"], modes: ["Std"] }] });
    });

    it("M2: HTML's named entities stay as written; numeric references and the five XML ones are decoded", () => {
      const def = parseQxf(SPOT.replace("<Model>Spot 7</Model>", "<Model>Spot 7&deg; &amp; &#233;</Model>"));
      expect(def.model).to.equal("Spot 7&deg; & é");
    });

    it("M3: an all-ASCII file declaring ISO-8859-1 is copied in Latin-1 under its declaration", async () => {
      writeFileSync(join(shared(), "ascii.qxf"), SPOT.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"').replace("<Model>Spot 7</Model>", "<Model>Ascii Spot</Model>"));
      const copy = (await run("library.duplicate", { id: "shared/ascii.qxf", model: "Copié ŵ" })) as { id: string };
      const out = readFileSync(join(own(), copy.id.slice("venue/".length)));
      expect(out.includes(Buffer.from([0x43, 0x6f, 0x70, 0x69, 0xe9]))).to.equal(true); // « Copié » in Latin-1
      expect(out.toString("latin1")).to.contain("&#x175;");
      expect(parseQxf(out.toString("latin1")).model).to.equal("Copié ŵ");
    });

    it("M4: a fixture patched under the misread name of a Latin-1 file still resolves it, with its corrections", async () => {
      writeFileSync(join(shared(), "eclat.qxf"), LATIN);
      plugin.runtime.venue.refreshDefinitions(); // dropped while the server runs
      const misread = (s: string) => Buffer.from(s, "latin1").toString("utf8");
      await put("old", misread("Société Fictive"), misread("Projecteur Éclat"), "Défaut");
      expect((plugin.runtime.venue.resolve("old") as { def: { model: string } }).def.model).to.equal("Projecteur Éclat");
      // corrections stored then, under the misread key, still apply; and those under the proper names too
      await run("venue.fixture.heads.set", { fixture: "old", scope: "model", follow: false });
      expect(plugin.runtime.venue.overridesOf(plugin.runtime.venue.fixtures.get("old")!).heads).to.deep.equal({ follow: false });
    });

    it("M5/M6: a restore names the folders, and sees an identical displaced file in another venue's own folder", async () => {
      // another venue's own copy of Spot 7, identical to what goes back there
      const hallDefs = join(dataRoot, "venues", "hall", "fixture-definitions");
      hallUses("Spot 7", "Standard");
      mkdirSync(hallDefs, { recursive: true });
      writeFileSync(join(hallDefs, "spot.qxf"), SPOT);
      writeFileSync(join(hallDefs, "a-spot.qxf"), SPOT);
      const id = moveToTrash(dataRoot, join(hallDefs, "a-spot.qxf"), { folder: "venue", venue: "hall", manufacturer: "Test", model: "Spot 7" }, clock);
      expect(await run("library.restore", { id, dryRun: true })).to.deep.include({ displaces: "spot.qxf", identical: true, refused: false });
      // the shared one: an older version back as spot-2.qxf, before spot.qxf; the refusal names both folders
      await put("spot", "Test", "Spot 7", "Standard");
      await run("fixture.definition.add", { name: "spot.qxf", xml: SPOT.replace("<Type>", "<!-- v2 --><Type>").replace('Name="Shutter"', 'Name="Shut"').replace(/>Shutter</g, ">Shut<"), replace: true, force: true });
      const old = ((await run("library.trash")) as { id: string; reason?: string }[]).find((e) => e.reason === "replaced")!.id;
      expect((await failure(run("library.restore", { id: old }))).message).to.match(/spot-2\.qxf \(partagée\) passerait avant spot\.qxf \(partagée\)/);
      // beside: under a name read after it, nothing changes; in its place: the current one to the trash
      expect(await run("library.restore", { id: old, as: "beside", dryRun: true })).to.deep.include({ file: "spot_old.qxf", winner: false, refused: false });
      expect(await run("library.restore", { id: old, as: "replace" })).to.deep.include({ file: "spot.qxf", restored: true });
      expect(readFileSync(join(shared(), "spot.qxf"), "utf8")).to.equal(SPOT);
      expect(((await run("library.trash")) as { reason?: string }[]).some((e) => e.reason === "replaced")).to.equal(true);
    });

    it("M7: emptying the trash removes only what was listed; an entry gone since is said", async () => {
      await run("library.delete", { id: "shared/spot.qxf" });
      const listed = ((await run("library.trash.empty", { dryRun: true })) as { removed: { id: string }[] }).removed.map((e) => e.id);
      await run("library.delete", { id: "shared/pixel-bar.qxf" }); // arrives after the list was shown
      const r = (await run("library.trash.empty", { ids: [...listed, "2026-01-01T00-00-00-000Z-gone"] })) as { count: number; missing?: string[] };
      expect(r).to.deep.include({ count: 1, missing: ["2026-01-01T00-00-00-000Z-gone"] });
      expect(((await run("library.trash")) as { model: string }[]).map((e) => e.model)).to.deep.equal(["Pixel Bar"]);
    });
  });

  describe("review 4", () => {
    const LATIN = readFileSync(new URL("../../fixtures/latin1-eclat.qxf", import.meta.url));
    const LATIN_TEXT = LATIN.toString("latin1");
    const misread = (s: string) => Buffer.from(s, "latin1").toString("utf8");

    it("1: a text declaring ISO-8859-1 is written in Latin-1; a valid UTF-8 file under that declaration keeps its UTF-8 names", async () => {
      expect(await run("fixture.definition.add", { name: "eclat.qxf", xml: LATIN_TEXT })).to.deep.include({ manufacturer: "Société Fictive", model: "Projecteur Éclat" });
      expect(readFileSync(join(shared(), "eclat.qxf"))).to.deep.equal(LATIN);
      // the same text, saved as UTF-8 by an editor that left the old declaration
      writeFileSync(join(shared(), "utf8-declared.qxf"), Buffer.from(LATIN_TEXT.replace("Projecteur Éclat", "Projecteur Éclair"), "utf8"));
      plugin.runtime.venue.refreshDefinitions();
      expect(plugin.runtime.venue.libraryFileFor("Société Fictive", "Projecteur Éclair")).to.not.equal(undefined);
      expect(decodeDefinition(readFileSync(join(shared(), "utf8-declared.qxf")))).to.deep.include({ encoding: "utf8", latin1: false });
    });

    it("windows-1252: ’ œ € are read and kept, a retouch is written back in Windows-1252", async () => {
      const text = SPOT.replace('encoding="UTF-8"', 'encoding="windows-1252"').replace("<Model>Spot 7</Model>", "<Model>Spot l’œil €</Model>");
      const bytes = encodeDefinition(text, "windows-1252");
      expect([...bytes].filter((b) => b === 0x92 || b === 0x9c || b === 0x80)).to.have.length(3);
      writeFileSync(join(shared(), "cp.qxf"), bytes);
      plugin.runtime.venue.refreshDefinitions();
      expect(plugin.runtime.venue.libraryFileFor("Test", "Spot l’œil €")).to.not.equal(undefined);
      const copy = (await run("library.duplicate", { id: "shared/cp.qxf" })) as { id: string; model: string };
      expect(copy.model).to.equal("Spot l’œil € (copie)");
      const out = readFileSync(join(own(), copy.id.slice("venue/".length)));
      expect(decodeDefinition(out).text).to.contain("<Model>Spot l’œil € (copie)</Model>");
      expect(out.includes(Buffer.from([0x92]))).to.equal(true);
    });

    it("2: an archive carries a Latin-1 definition byte for byte; restored elsewhere it resolves, again it adds no copy", async () => {
      writeFileSync(join(shared(), "eclat.qxf"), LATIN);
      plugin.runtime.venue.refreshDefinitions();
      await put("e", "Société Fictive", "Projecteur Éclat", "Défaut");
      const zip = packArchive({ venue: { id: "default", dir: join(dataRoot, "venues", "default") }, definitionDirs: definitionDirsFor(dataRoot, "default") });
      expect(Buffer.from(unzipSync(zip)["fixtures/eclat.qxf"]!)).to.deep.equal(LATIN);
      // another machine: an empty library
      const other = join(dataRoot, "..", "other");
      mkdirSync(join(other, "fixtures"), { recursive: true });
      const plan = planFixtures(readArchive(zip).fixtures, [], [join(other, "fixtures")], join(other, "fixtures"));
      applyFixtures(plan, "missing", join(other, "backup"));
      expect(readFileSync(join(other, "fixtures", "eclat.qxf"))).to.deep.equal(LATIN);
      // the same archive again: the same definition, nothing new written
      const again = planFixtures(readArchive(zip).fixtures, [], [join(other, "fixtures")], join(other, "fixtures"));
      expect(again.entries.map((e) => e.status)).to.deep.equal(["same"]);
      applyFixtures(again, "replace", join(other, "backup2"));
      expect(readdirSync(join(other, "fixtures"))).to.deep.equal(["eclat.qxf"]);
    });

    it("3: a fixture under the misread names of a Latin-1 file is counted, guards its delete and its replace, goes in an archive", async () => {
      writeFileSync(join(shared(), "eclat.qxf"), LATIN);
      plugin.runtime.venue.refreshDefinitions();
      await put("old", misread("Société Fictive"), misread("Projecteur Éclat"), "Défaut");
      const row = (await list()).definitions.find((d) => d.id === "shared/eclat.qxf")!;
      expect(row.usedBy).to.deep.equal([{ id: "old", name: "OLD" }]);
      expect((await failure(run("library.delete", { id: "shared/eclat.qxf" }))).detail).to.deep.include({ force: true });
      const noDefault = LATIN_TEXT.replace('<Mode Name="Défaut">', '<Mode Name="Autre">');
      expect((await failure(run("fixture.definition.add", { name: "eclat.qxf", xml: noDefault, replace: true }))).detail).to.deep.include({ lostModes: ["Défaut"] });
      const zip = packArchive({ venue: { id: "default", dir: join(dataRoot, "venues", "default") }, definitionDirs: definitionDirsFor(dataRoot, "default") });
      expect(Object.keys(unzipSync(zip)).filter((k) => k.startsWith("fixtures/"))).to.deep.equal(["fixtures/eclat.qxf"]);
    });

    it("4: the export of an all-ASCII file declared ISO-8859-1 writes its accented corrections in Latin-1", async () => {
      const ascii = fixture("wheel-spot.qxf").replace('encoding="UTF-8"', 'encoding="ISO-8859-1"');
      writeFileSync(join(shared(), "ws.qxf"), ascii);
      plugin.runtime.venue.refreshDefinitions();
      const out = (await run("fixture.definition.export", { manufacturer: "Test", model: "Wheel Spot" })) as { base64?: string; xml: string };
      expect(Buffer.from(out.base64!, "base64").toString("latin1")).to.equal(ascii);
      // a valid UTF-8 file under that declaration: exported as UTF-8 text, its accents kept
      writeFileSync(join(shared(), "ws.qxf"), Buffer.from(ascii.replace("<Model>Wheel Spot</Model>", "<Model>Wheel Spot é</Model>"), "utf8"));
      plugin.runtime.venue.refreshDefinitions();
      const utf = (await run("fixture.definition.export", { manufacturer: "Test", model: "Wheel Spot é" })) as { base64?: string; xml: string };
      expect(utf.base64).to.equal(undefined);
      expect(utf.xml).to.contain("Wheel Spot é");
    });
  });

  describe("review 5", () => {
    const cp1252 = (model: string) => encodeDefinition(SPOT.replace('encoding="UTF-8"', 'encoding="windows-1252"').replace("<Model>Spot 7</Model>", `<Model>${model}</Model>`), "windows-1252");

    it("a Windows-1252 file patched under the names it had when read as UTF-8 still resolves (’ œ € as their own bytes)", async () => {
      const bytes = cp1252("Spot l’œil €");
      writeFileSync(join(shared(), "cp.qxf"), bytes);
      plugin.runtime.venue.refreshDefinitions();
      const misread = (s: string) => encodeDefinition(s, "windows-1252").toString("utf8");
      await put("old", "Test", misread("Spot l’œil €"), "Standard");
      expect((plugin.runtime.venue.resolve("old") as { def: { model: string } }).def.model).to.equal("Spot l’œil €");
    });

    it("Windows-1252's five undefined bytes go back as they were; an export without corrections is the file's bytes", async () => {
      const bytes = Buffer.concat([cp1252("Spot X"), Buffer.alloc(0)]);
      // 0x81 0x8D 0x8F 0x90 0x9D inside a comment
      const odd = Buffer.from(bytes.toString("latin1").replace("<Type>", "<!-- \x81\x8d\x8f\x90\x9d --><Type>"), "latin1");
      expect(encodeDefinition(decodeDefinition(odd).text, "windows-1252")).to.deep.equal(odd);
      writeFileSync(join(shared(), "odd.qxf"), odd);
      plugin.runtime.venue.refreshDefinitions();
      const out = (await run("fixture.definition.export", { manufacturer: "Test", model: "Spot X" })) as { base64?: string };
      expect(Buffer.from(out.base64!, "base64")).to.deep.equal(odd);
    });
  });
});
