import { expect } from "chai";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { applyRestore, MAX_ARCHIVE_BYTES, packArchive, previewRestore, readArchive, restoreBackupDir, restoreFolder, type RestoreTargets } from "../../../src/plugins/light/data/archive.js";
import { MAX_DEFINITION_BYTES } from "../../../src/plugins/light/data/archive-fixtures.js";
import { definitionFileName, listQxfFiles } from "../../../src/plugins/light/venue/definition-files.js";

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");
const BAR = fixture("bar4.qxf");
const SPOT = fixture("spot.qxf");
/** The same bar with another channel name: a different definition of the same model. */
const BAR_CHANGED = BAR.replace('Name="Strobe"', 'Name="Flash"').replace(/>Strobe</g, ">Flash<");
/** The same bar with only its layout changed (blank lines, indentation). */
const BAR_REFORMATTED = BAR.replace(/\n </g, "\n\n    <");

const manifest = (extra: Record<string, unknown> = {}) => strToU8(JSON.stringify({ format: "lightshow", version: 1, createdAt: "2026-01-01T00:00:00Z", ...extra }));
/** Offsets of the zip's central directory entries (what the reader trusts for names and sizes). */
const centralEntries = (zip: Uint8Array) => {
  const out: number[] = [];
  for (let i = 0; i + 4 <= zip.length; i++) if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02) out.push(i);
  return out;
};

const patchFile = (manufacturer: string, model: string, id: string) => JSON.stringify({ id, name: id, manufacturer, model, mode: "Standard", universe: 1, address: 1 });

describe(".lightshow archives carry the fixture definitions", () => {
  let root: string;
  let lib: string;
  let t: RestoreTargets;
  const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

  /** An instance: a library, a show, a venue patching Bar 4 and the generic dimmer (spot is in the library, unused). */
  const instance = (name: string, defs: Record<string, string>): RestoreTargets => {
    const base = join(root, name);
    const fixturesDir = join(base, "fixtures");
    mkdirSync(fixturesDir, { recursive: true });
    for (const [f, xml] of Object.entries(defs)) writeFileSync(join(fixturesDir, f), xml);
    mkdirSync(join(base, "show"), { recursive: true });
    writeFileSync(join(base, "show", "show.json"), JSON.stringify({ name: "s", venue: "v" }));
    mkdirSync(join(base, "venue", "fixtures"), { recursive: true });
    writeFileSync(join(base, "venue", "fixtures", "bar-0.json"), patchFile("Test", "Bar 4", "bar-0"));
    writeFileSync(join(base, "venue", "fixtures", "dim-0.json"), patchFile("Generic", "Generic", "dim-0"));
    return { showDir: join(base, "show"), venueDir: join(base, "venue"), venueId: "v", definitionDirs: [fixturesDir, join(base, "venue", "fixture-definitions")], fixturesDir };
  };
  const pack = (x: RestoreTargets) => packArchive({ show: { id: "s", dir: x.showDir }, venue: { id: "v", dir: x.venueDir }, definitionDirs: x.definitionDirs });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "light-archive-fx-"));
    t = instance("src", { "bar4.qxf": BAR, "spot.qxf": SPOT });
    lib = t.fixturesDir;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("packs only the definitions the patch uses, and lists them in the manifest", () => {
    const entries = unzipSync(pack(t));
    expect(Object.keys(entries).filter((n) => n.startsWith("fixtures/"))).to.deep.equal(["fixtures/bar4.qxf"]); // not spot.qxf, nothing for the generic dimmer
    expect(strFromU8(entries["fixtures/bar4.qxf"]!)).to.equal(BAR);
    expect(readArchive(pack(t)).manifest.fixtures).to.deep.equal(["bar4.qxf"]);
  });

  it("packs nothing without a venue, and finds definitions in the venue's own folder", () => {
    const entries = unzipSync(packArchive({ show: { id: "s", dir: t.showDir }, definitionDirs: t.definitionDirs }));
    expect(Object.keys(entries).some((n) => n.startsWith("fixtures/"))).to.equal(false);
    const own = join(t.venueDir, "fixture-definitions");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "spot-own.qxf"), SPOT.replace("Spot 7", "Spot 9"));
    writeFileSync(join(t.venueDir, "fixtures", "spot-0.json"), patchFile("Test", "Spot 9", "spot-0"));
    expect(readArchive(pack(t)).manifest.fixtures).to.deep.equal(["bar4.qxf", "spot-own.qxf"]);
  });

  it("is deterministic: two packs differ only by createdAt", () => {
    const strip = (bytes: Uint8Array) => {
      const e = unzipSync(bytes);
      const m = JSON.parse(strFromU8(e["manifest.json"]!)) as Record<string, unknown>;
      delete m.createdAt;
      return JSON.stringify([Object.keys(e), Object.entries(e).filter(([n]) => n !== "manifest.json").map(([, d]) => Buffer.from(d).toString("base64")), m]);
    };
    expect(strip(pack(t))).to.equal(strip(pack(t)));
  });

  it("restores the missing definitions into a fresh library, and they parse as the same", () => {
    const dest = instance("dest", {});
    const content = readArchive(pack(t));
    const pre = previewRestore(content, dest);
    expect(pre.fixtures).to.deep.include({ missing: ["bar4.qxf"], differs: [], wouldImport: ["bar4.qxf"], policy: "missing" });
    const res = applyRestore(content, dest, "missing", join(root, "backups", "r1"));
    expect(res.fixtures.wouldImport).to.deep.equal(["bar4.qxf"]);
    expect(readFileSync(join(dest.fixturesDir, "bar4.qxf"), "utf8")).to.equal(BAR);
    expect(list(dest.fixturesDir)).to.deep.equal(["bar4.qxf"]);
    // restored again: nothing left to bring
    expect(previewRestore(content, dest).fixtures).to.deep.include({ missing: [], differs: [], unchanged: 1 });
  });

  it("reads a reformatted definition as the same one, a changed one as different", () => {
    const content = readArchive(pack(t));
    writeFileSync(join(lib, "bar4.qxf"), BAR_REFORMATTED);
    expect(previewRestore(content, t).fixtures).to.deep.include({ missing: [], differs: [], unchanged: 1 });
    writeFileSync(join(lib, "bar4.qxf"), BAR_CHANGED);
    expect(previewRestore(content, t).fixtures).to.deep.include({ missing: [], differs: ["bar4.qxf"] });
  });

  describe("with a different definition in the library", () => {
    let dest: RestoreTargets;
    let content: ReturnType<typeof readArchive>;
    beforeEach(() => {
      content = readArchive(pack(t));
      dest = instance("dest", { "bar4.qxf": BAR_CHANGED });
    });

    it("\"missing\" leaves it alone", () => {
      const res = applyRestore(content, dest, "missing", join(root, "backups", "r2"));
      expect(readFileSync(join(dest.fixturesDir, "bar4.qxf"), "utf8")).to.equal(BAR_CHANGED);
      expect(res.fixtures).to.deep.include({ differs: ["bar4.qxf"], wouldReplace: [], wouldImport: [] });
      expect(existsSync(join(root, "backups", "r2", "fixtures"))).to.equal(false);
    });

    it("\"replace\" overwrites it and keeps the old file in the restore's backup folder", () => {
      const pre = previewRestore(content, dest, "replace");
      expect(pre.fixtures.wouldReplace).to.deep.equal(["bar4.qxf"]);
      expect(readFileSync(join(dest.fixturesDir, "bar4.qxf"), "utf8")).to.equal(BAR_CHANGED); // a preview writes nothing
      applyRestore(content, dest, "replace", join(root, "backups", "r3"));
      expect(readFileSync(join(dest.fixturesDir, "bar4.qxf"), "utf8")).to.equal(BAR);
      expect(readFileSync(join(root, "backups", "r3", "fixtures", "bar4.qxf"), "utf8")).to.equal(BAR_CHANGED);
    });

    it("\"none\" writes no definition at all", () => {
      const empty = instance("empty", {});
      const res = applyRestore(content, empty, "none", join(root, "backups", "r4"));
      expect(list(empty.fixturesDir)).to.deep.equal([]);
      expect(res.fixtures).to.deep.include({ missing: ["bar4.qxf"], wouldImport: [] });
      applyRestore(content, dest, "none", join(root, "backups", "r5"));
      expect(readFileSync(join(dest.fixturesDir, "bar4.qxf"), "utf8")).to.equal(BAR_CHANGED);
    });

    it("the dry run writes nothing anywhere", () => {
      const before = [list(dest.fixturesDir), list(dest.venueDir), list(join(dest.venueDir, "fixtures")), list(join(root, "backups"))];
      previewRestore(content, dest, "replace");
      expect([list(dest.fixturesDir), list(dest.venueDir), list(join(dest.venueDir, "fixtures")), list(join(root, "backups"))]).to.deep.equal(before);
    });

    it("keeps a model's definition under another name instead of overwriting a different model's file", () => {
      const other = instance("other", { "bar4.qxf": SPOT }); // that file name holds another model
      applyRestore(content, other, "missing", join(root, "backups", "r6"));
      expect(readFileSync(join(other.fixturesDir, "bar4.qxf"), "utf8")).to.equal(SPOT);
      expect(readFileSync(join(other.fixturesDir, "bar4-2.qxf"), "utf8")).to.equal(BAR);
    });
  });

  it("restores an archive made before definitions existed", () => {
    const old = zipSync({
      "manifest.json": strToU8(JSON.stringify({ format: "lightshow", version: 1, createdAt: "2026-01-01T00:00:00Z", show: "s", venue: "v" })),
      "show/show.json": strToU8('{"name":"s","venue":"v"}'),
      "venue/fixtures/bar-0.json": strToU8(patchFile("Test", "Bar 4", "bar-0")),
    });
    const content = readArchive(old);
    expect(content.fixtures).to.deep.equal({});
    const dest = instance("dest", {});
    const res = applyRestore(content, dest, "replace", join(root, "backups", "r7"));
    expect(res.files).to.deep.equal({ show: 1, venue: 1 });
    expect(res.fixtures).to.deep.include({ missing: [], differs: [], unchanged: 0, wouldImport: [], wouldReplace: [] });
  });

  it("reports an invalid definition and odd entry names, skips them, and imports the rest", () => {
    const bytes = zipSync({
      "manifest.json": strToU8(JSON.stringify({ format: "lightshow", version: 1, createdAt: "2026-01-01T00:00:00Z" })),
      "fixtures/bar4.qxf": strToU8(BAR),
      "fixtures/broken.qxf": strToU8("<not-a-definition/>"),
      "fixtures/sub/deep.qxf": strToU8(SPOT),
      "fixtures/notes.txt": strToU8("x"),
      "fixtures/.hidden.qxf": strToU8(SPOT),
    });
    const content = readArchive(bytes);
    expect(content.rejectedFixtures.sort()).to.deep.equal(["fixtures/.hidden.qxf", "fixtures/notes.txt", "fixtures/sub/deep.qxf"]);
    const dest = instance("dest", {});
    const res = applyRestore(content, dest, "missing", join(root, "backups", "r8"));
    expect(res.fixtures.invalid.map((x) => x.file)).to.deep.equal(["broken.qxf"]);
    expect(list(dest.fixturesDir)).to.deep.equal(["bar4.qxf"]); // nothing else written, nothing nested
  });

  it("matches the patch's model as the library does (case and punctuation), and decodes entities", () => {
    writeFileSync(join(t.venueDir, "fixtures", "bar-0.json"), patchFile("TEST", "bar-4", "bar-0"));
    expect(readArchive(pack(t)).manifest.fixtures).to.deep.equal(["bar4.qxf"]);
    // « A &amp; B » in the file is « A & B » once read: the quick header check must not skip it
    writeFileSync(join(lib, "bar4.qxf"), BAR.replace("<Manufacturer>Test</Manufacturer>", "<Manufacturer>A &amp; B</Manufacturer>"));
    writeFileSync(join(t.venueDir, "fixtures", "bar-0.json"), patchFile("A & B", "Bar 4", "bar-0"));
    expect(readArchive(pack(t)).manifest.fixtures).to.deep.equal(["bar4.qxf"]);
  });

  it("packs a library file whose name is not plain under a plain name, and that archive restores", () => {
    rmSync(join(lib, "bar4.qxf"));
    writeFileSync(join(lib, "Été bar 4.qxf"), BAR);
    expect(definitionFileName("Été bar 4.qxf")).to.equal("Ete-bar-4.qxf");
    const content = readArchive(pack(t));
    expect(content.manifest.fixtures).to.deep.equal(["Ete-bar-4.qxf"]);
    const dest = instance("dest", {});
    applyRestore(content, dest, "missing", join(root, "backups", "u"));
    expect(list(dest.fixturesDir)).to.deep.equal(["Ete-bar-4.qxf"]);
  });

  it("skips what the library cannot read instead of failing the backup", () => {
    mkdirSync(join(lib, "aaa.qxf")); // a folder named like a definition, read first
    writeFileSync(join(lib, "aab.qxf"), "<FixtureDefinition><Manufacturer>Test</Manufacturer><Model>Bar 4</Model><oops");
    expect(listQxfFiles(lib).map((f) => f.slice(lib.length + 1))).to.deep.equal(["aab.qxf", "bar4.qxf", "spot.qxf"]);
    expect(readArchive(pack(t)).manifest.fixtures).to.deep.equal(["bar4.qxf"]);
  });

  it("keeps the venue's own definitions (and its other non-JSON files) when the venue is restored", () => {
    const content = readArchive(pack(t));
    const dest = instance("dest", { "spot.qxf": SPOT });
    const own = join(dest.venueDir, "fixture-definitions");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "own.qxf"), SPOT.replace("Spot 7", "Spot 9"));
    writeFileSync(join(dest.venueDir, "fixtures", "stale.json"), patchFile("Test", "Spot 7", "stale"));
    const res = applyRestore(content, dest, "missing", join(root, "backups", "v"));
    expect(res.files.venue).to.equal(2);
    expect(readFileSync(join(own, "own.qxf"), "utf8")).to.contain("Spot 9");
    expect(list(join(dest.venueDir, "fixtures"))).to.deep.equal(["bar-0.json", "dim-0.json"]); // the JSON is the archive's
    expect(existsSync(join(root, "backups", "v", "venue", "fixtures", "stale.json"))).to.equal(true);
    // the folder function itself: a non-JSON file is put back, JSON replaced
    const dir = join(root, "plain");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "notes.txt"), "kept");
    writeFileSync(join(dir, "old.json"), "{}");
    restoreFolder(dir, { "new.json": "{}" }, join(root, "backups", "plain"));
    expect([list(dir), readFileSync(join(dir, "sub", "notes.txt"), "utf8")]).to.deep.equal([["new.json", "sub"], "kept"]);
  });

  it("never writes two new definitions to one file of a case-insensitive disk", () => {
    const bytes = zipSync({
      "manifest.json": manifest(),
      "fixtures/Bar.qxf": strToU8(BAR),
      "fixtures/bar.qxf": strToU8(SPOT),
    });
    const dest = instance("dest", {});
    const plan = previewRestore(readArchive(bytes), dest);
    expect(plan.fixtures.missing.sort()).to.deep.equal(["Bar.qxf", "bar.qxf"]);
    applyRestore(readArchive(bytes), dest, "missing", join(root, "backups", "c"));
    const names = list(dest.fixturesDir);
    expect(names).to.include.members(["Bar.qxf", "bar-2.qxf"]);
    expect(new Set(names.map((n) => n.toLowerCase())).size).to.equal(names.length);
    // an existing file differing only by case also counts as taken
    const dest2 = instance("dest2", { "BAR4.qxf": SPOT.replace("Spot 7", "Other") });
    applyRestore(readArchive(pack(t)), dest2, "missing", join(root, "backups", "c2"));
    expect(list(dest2.fixturesDir)).to.deep.equal(["BAR4.qxf", "bar4-2.qxf"]);
    expect(readFileSync(join(dest2.fixturesDir, "BAR4.qxf"), "utf8")).to.contain("Other");
  });

  it("keeps both old files when two replaced definitions share a name in two library folders", () => {
    writeFileSync(join(t.venueDir, "fixtures", "spot-0.json"), patchFile("Test", "Spot 7", "spot-0"));
    const content = readArchive(pack(t));
    expect(content.manifest.fixtures).to.deep.equal(["bar4.qxf", "spot.qxf"]);
    const dest = instance("dest", { "defs.qxf": BAR_CHANGED });
    const own = join(dest.venueDir, "fixture-definitions");
    mkdirSync(own, { recursive: true });
    const SPOT_CHANGED = SPOT.replace(/<Channel Name="([^"]+)"/, '<Channel Name="$1 x"');
    writeFileSync(join(own, "defs.qxf"), SPOT_CHANGED);
    const backup = join(root, "backups", "two");
    const res = applyRestore(content, dest, "replace", backup);
    expect(res.fixtures.wouldReplace).to.deep.equal(["bar4.qxf", "spot.qxf"]);
    expect(readFileSync(join(dest.fixturesDir, "defs.qxf"), "utf8")).to.equal(BAR);
    expect(readFileSync(join(own, "defs.qxf"), "utf8")).to.equal(SPOT); // replaced where the library had it
    const saved = list(join(backup, "fixtures")).map((n) => readFileSync(join(backup, "fixtures", n), "utf8"));
    expect(saved.sort()).to.deep.equal([BAR_CHANGED, SPOT_CHANGED].sort());
    expect(list(dest.fixturesDir).some((n) => n.includes("tmp"))).to.equal(false);
  });

  it("gives every restore its own backup folder", () => {
    const now = new Date("2026-03-01T10:00:00.000Z");
    const first = restoreBackupDir(root, now);
    mkdirSync(first, { recursive: true });
    const second = restoreBackupDir(root, now);
    expect(second).to.not.equal(first);
    expect(second.startsWith(first)).to.equal(true);
  });

  it("skips an oversized definition without decompressing it, and refuses an archive too big once decompressed", () => {
    const big = BAR.replace("</FixtureDefinition>", `<!-- ${"x".repeat(MAX_DEFINITION_BYTES)} --></FixtureDefinition>`);
    const content = readArchive(zipSync({ "manifest.json": manifest(), "fixtures/big.qxf": strToU8(big), "fixtures/spot.qxf": strToU8(SPOT) }));
    expect(content.fixtures).to.have.keys(["spot.qxf"]);
    expect(content.invalidFixtures.map((x) => x.file)).to.deep.equal(["big.qxf"]);
    expect(previewRestore(content, instance("dest", {})).fixtures).to.deep.include({ wouldImport: ["spot.qxf"] });
    expect(previewRestore(content, instance("dest", {})).fixtures.invalid.map((x) => x.file)).to.deep.equal(["big.qxf"]);
    // a small zip claiming a huge content: refused from its directory, before inflating anything
    const bomb = zipSync({ "manifest.json": manifest(), "show/show.json": strToU8("{}") });
    for (const at of centralEntries(bomb)) new DataView(bomb.buffer, bomb.byteOffset).setUint32(at + 24, Math.floor(MAX_ARCHIVE_BYTES / 2) + 1, true);
    expect(() => readArchive(bomb)).to.throw(/trop grosse|too big/);
  });

  it("refuses an archive naming one entry twice", () => {
    const zip = zipSync({ "manifest.json": manifest(), "show/a.json": strToU8('{"a":1}'), "show/b.json": strToU8('{"b":1}') });
    const name = new TextEncoder().encode("show/b.json");
    const at = centralEntries(zip).find((i) => Buffer.from(zip.subarray(i + 46, i + 46 + name.length)).equals(Buffer.from(name)))!;
    zip.set(new TextEncoder().encode("show/a.json"), at + 46);
    expect(() => readArchive(zip)).to.throw(/double|duplicate/);
  });

  it("refuses `..` as a path segment with either separator, but not inside a name", () => {
    const zip = (name: string) => zipSync({ "manifest.json": manifest(), [name]: strToU8(BAR) });
    expect(() => readArchive(zip("fixtures\\..\\..\\evil.qxf"))).to.throw(/chemin interdit|forbidden path/);
    expect(() => readArchive(zip("/abs/evil.qxf"))).to.throw(/chemin interdit|forbidden path/);
    expect(readArchive(zip("fixtures/Bar 4 v1..2.qxf")).fixtures).to.have.keys(["Bar 4 v1..2.qxf"]);
  });

  it("refuses an archive with a path-traversal entry", () => {
    const bytes = zipSync({
      "manifest.json": strToU8(JSON.stringify({ format: "lightshow", version: 1, createdAt: "2026-01-01T00:00:00Z" })),
      "fixtures/../../evil.qxf": strToU8(BAR),
    });
    expect(() => readArchive(bytes)).to.throw(/chemin interdit|forbidden path/);
  });
});

describe(".lightshow archives and the running library", () => {
  let dataRoot: string;
  let plugin: LightPlugin;
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());

  beforeEach(async () => {
    dataRoot = join(mkdtempSync(join(tmpdir(), "light-archive-run-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    // off the stage network: output on loopback and the tests' Art-Net port, no route
    const cfg = { discovery: false, output: { bindAddress: "127.0.0.1", artnetPort: 16454, routes: [] }, osc: { enabled: false }, os2l: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
  });
  afterEach(async () => {
    await plugin.stop();
    rmSync(join(dataRoot, ".."), { recursive: true, force: true });
  });

  it("backups (by hand and automatic) carry the definitions, and a restore makes them usable at once", async () => {
    const { file } = (await run("backup.create")) as { file: string };
    const auto = plugin.autoBackup(new Date(2026, 9, 1, 9, 0))!;
    for (const f of [file, auto]) expect(readArchive(new Uint8Array(readFileSync(join(dataRoot, "backups", f)))).manifest.fixtures).to.deep.equal(["bar4.qxf"]);
    rmSync(join(dataRoot, "fixtures", "bar4.qxf"));
    plugin.runtime.venue.refreshDefinitions();
    expect(plugin.runtime.venue.missingDefinitions().length).to.be.greaterThan(0);

    const preview = (await run("backup.restore", { file, dryRun: true })) as { fixtures: { missing: string[]; wouldImport: string[] } };
    expect(preview.fixtures).to.deep.include({ missing: ["bar4.qxf"], wouldImport: ["bar4.qxf"] });
    expect(existsSync(join(dataRoot, "fixtures", "bar4.qxf"))).to.equal(false);
    expect(plugin.runtime.venue.missingDefinitions().length).to.be.greaterThan(0); // the running library did not change either
    expect(readdirSync(join(dataRoot, "backups")).filter((n) => n.startsWith("restore-"))).to.deep.equal([]); // no backup folder for a preview

    await run("backup.restore", { file, fixtures: "none" });
    expect(plugin.runtime.venue.missingDefinitions().length).to.be.greaterThan(0);
    const res = (await run("backup.restore", { file })) as { fixtures: { wouldImport: string[] } };
    expect(res.fixtures.wouldImport).to.deep.equal(["bar4.qxf"]);
    expect(plugin.runtime.venue.missingDefinitions()).to.deep.equal([]); // the library re-read the new file
  });

  it("refuses an unknown policy", async () => {
    const { file } = (await run("backup.create")) as { file: string };
    const err = await run("backup.restore", { file, fixtures: "all" }).then(() => "restored", (e: Error) => e.message);
    expect(err).to.not.equal("restored");
  });
});
