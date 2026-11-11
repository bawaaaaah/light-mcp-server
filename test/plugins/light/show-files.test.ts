import { expect } from "chai";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { CommandError, systemContext } from "../../../src/plugins/light/commands/registry.js";

type ShowRow = { id: string; name: string; venue: string; active: boolean };

describe("show files (new, open, duplicate, reset, backups)", () => {
  let dataRoot: string;
  let plugin: LightPlugin;
  let saved: { show?: string; venue?: string };
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  const looks = async () => ((await run("look.list")) as { id: string }[]).map((l) => l.id).sort();

  beforeEach(async () => {
    dataRoot = join(mkdtempSync(join(tmpdir(), "light-files-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    let cfg: Record<string, unknown> = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    saved = {};
    plugin = new LightPlugin({
      eventBus: new EventBus(),
      config: {
        get: () => cfg,
        set: async (c) => {
          cfg = c as Record<string, unknown>;
          saved = { show: cfg.show as string, venue: cfg.venue as string };
        },
      },
      dataRoot,
      midiNative: null,
    });
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
  });

  it("creates an empty show on the same venue, opens it, and goes back", async () => {
    const before = await looks();
    expect(before.length).to.be.greaterThan(0);
    const created = (await run("show.create", { name: "Concert d'été" })) as { id: string; venue: string };
    expect(created).to.include({ id: "concert-d-ete", venue: "default" });
    expect(saved).to.deep.equal({ show: "concert-d-ete", venue: "default" });
    expect(await looks()).to.deep.equal([]);
    expect(((await run("venue.fixture.list")) as unknown[]).length).to.be.greaterThan(0); // same patch
    expect(plugin.state().show).to.deep.equal({ id: "concert-d-ete", name: "Concert d'été" });
    const shows = (await run("show.list")) as ShowRow[];
    expect(shows.find((s) => s.active)?.id).to.equal("concert-d-ete");
    await run("show.open", { id: "default" });
    expect(await looks()).to.deep.equal(before);
  });

  it("duplicates a show (« Enregistrer sous »), with a copy of its venue on request", async () => {
    const before = await looks();
    await run("look.go", { id: before[0] });
    const copy = (await run("show.create", { name: "Copie", from: "default", venue: "copy" })) as { id: string; venue: string };
    expect(copy.venue).to.equal("copie");
    expect(await looks()).to.deep.equal(before);
    expect(plugin.runtime.activeLooks()).to.deep.equal([]); // opening stops what played
    // the copy is independent: deleting a look there leaves the original intact
    await run("look.delete", { id: before[0] });
    await run("venue.fixture.delete", { id: "bar-0", force: true });
    await run("show.open", { id: "default" });
    expect(await looks()).to.deep.equal(before);
    expect(plugin.runtime.venue.fixtures.get("bar-0")).to.not.equal(undefined);
  });

  it("renames, refuses to delete the open show, and moves another one to the backups", async () => {
    await run("show.rename", { name: "Dimanche" });
    expect(plugin.state().show.name).to.equal("Dimanche");
    await run("show.create", { name: "Brouillon", open: false });
    const refused = await run("show.delete", { id: "default" }).then(() => "deleted", (e: Error) => e.message);
    expect(refused).to.match(/show ouvert/);
    const moved = (await run("show.delete", { id: "brouillon" })) as { movedTo: string };
    expect(existsSync(join(dataRoot, moved.movedTo, "show.json"))).to.equal(true);
    expect(((await run("show.list")) as ShowRow[]).map((s) => s.id)).to.deep.equal(["default"]);
    // the same show deleted again within the same second: both copies are kept
    await run("show.create", { name: "Brouillon", open: false });
    const again = (await run("show.delete", { id: "brouillon" })) as { movedTo: string };
    expect(again.movedTo).to.not.equal(moved.movedTo);
  });

  it("resets the show (and its venue on request) after a backup, which restores it", async () => {
    const before = await looks();
    const reset = (await run("show.reset", { venue: true })) as { backup: string };
    expect(await looks()).to.deep.equal([]);
    expect((await run("venue.fixture.list")) as unknown[]).to.deep.equal([]);
    const backups = (await run("backup.list")) as { file: string; show?: string }[];
    expect(backups.map((b) => b.file)).to.include(reset.backup);
    expect(backups[0]).to.include({ show: "default" });
    await run("backup.restore", { file: reset.backup });
    expect(await looks()).to.deep.equal(before);
    expect(((await run("venue.fixture.list")) as unknown[]).length).to.be.greaterThan(0);
  });

  it("imports a QLC+ workspace into a new show of its own, on a new venue", async () => {
    const before = await looks();
    const defaultFixtures = ((await run("venue.fixture.list")) as unknown[]).length;
    const xml = readFileSync(new URL("../../fixtures/efx.qxw", import.meta.url), "utf8");
    const created = (await run("show.create", { name: "Autre salle", venue: "new", qxw: xml })) as { id: string; venue: string; imported: { applied: boolean } };
    expect(created).to.deep.include({ id: "autre-salle", venue: "autre-salle" });
    expect(created.imported.applied).to.equal(true);
    expect((await looks()).length).to.be.greaterThan(0);
    expect(await looks()).to.not.deep.equal(before);
    await run("show.open", { id: "default" });
    expect(await looks()).to.deep.equal(before);
    expect(((await run("venue.fixture.list")) as unknown[]).length).to.equal(defaultFixtures); // the first venue is untouched
  });

  it("adds a fixture definition (.qxf) to the library, checked first", async () => {
    const xml = readFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), "utf8");
    const bad = await run("fixture.definition.add", { name: "x.qxf", xml: "<oops" }).then(() => "added", (e: Error) => e.message);
    expect(bad).to.not.equal("added");
    const added = (await run("fixture.definition.add", { name: "Mon spot.qxf", xml })) as { file: string; model: string };
    expect(added.file).to.equal("Mon-spot.qxf");
    expect(((await run("venue.library", { search: added.model })) as unknown[]).length).to.be.greaterThan(0);
    const again = await run("fixture.definition.add", { name: "Mon spot.qxf", xml: xml.replace("</FixtureDefinition>", "<!-- v2 --></FixtureDefinition>") }).then(() => "added", (e: Error) => e.message);
    expect(again).to.match(/existe déjà/);
    // the refusal carries a detail the interface reads to offer « Remplacer »
    const v2 = xml.replace("</FixtureDefinition>", "<!-- v2 --></FixtureDefinition>");
    const refused = await run("fixture.definition.add", { name: "Mon spot.qxf", xml: v2 }).catch((e: unknown) => e);
    expect(refused).to.be.instanceOf(CommandError);
    expect((refused as CommandError).detail).to.deep.equal({ exists: true, file: "Mon-spot.qxf" });
    // an identical file is accepted, replace: true overwrites a different one and creates a missing one
    await run("fixture.definition.add", { name: "Mon spot.qxf", xml });
    await run("fixture.definition.add", { name: "Mon spot.qxf", xml: v2, replace: true });
    expect(readFileSync(join(dataRoot, "fixtures", "Mon-spot.qxf"), "utf8")).to.equal(v2);
    await run("fixture.definition.add", { name: "Neuf.qxf", xml, replace: true });
    expect(existsSync(join(dataRoot, "fixtures", "Neuf.qxf"))).to.equal(true);
  });

  it("lists venues with their shows, detaches a shared one, and attaches a show to another", async () => {
    await run("show.create", { name: "Concert" }); // same venue as the first show
    type VenueRow = { id: string; fixtures: number; shows: string[]; shared: boolean; active: boolean };
    const venues = async () => (await run("venue.list")) as VenueRow[];
    const shared = (await venues()).find((v) => v.id === "default")!;
    expect(shared).to.deep.include({ shared: true, active: true });
    expect(shared.shows).to.have.members(["default", "concert"]);
    const count = ((await run("venue.fixture.list")) as unknown[]).length;
    // the copy is the open show's own: removing a fixture there leaves the other show's venue whole
    expect(await run("show.venue.detach")).to.deep.include({ detached: true, from: "default", venue: "concert", sharedWith: ["default"] });
    const mine = (await run("venue.fixture.list")) as { id: string }[];
    await run("venue.fixture.delete", { id: mine[0]!.id, force: true });
    expect(((await run("venue.fixture.list")) as unknown[]).length).to.equal(count - 1);
    await run("show.open", { id: "default" });
    expect(((await run("venue.fixture.list")) as unknown[]).length).to.equal(count);
    expect(await run("show.venue.detach")).to.deep.include({ detached: false, venue: "default" }); // nothing shared: nothing copied
    // back onto the shared venue
    expect(await run("show.venue.set", { show: "concert", venue: "default" })).to.deep.include({ venue: "default", was: "concert", sharedWith: ["default"] });
    expect((await venues()).find((v) => v.id === "default")!.shared).to.equal(true);
    await run("show.venue.set", { venue: "nope" }).then(
      () => expect.fail("an unknown venue is refused"),
      (e: Error) => expect(e.message).to.contain("nope"),
    );
  });

  it("refuses to unpatch a fixture of a venue shared with other shows unless forced, and names those shows", async () => {
    await run("show.create", { name: "Concert" }); // shares the venue with the first show, and is open
    await run("venue.fixture.put", { fixture: { id: "libre", name: "Libre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 3, address: 1 } });
    const refused = await run("venue.fixture.delete", { id: "libre" }).then(() => "", (e: Error) => e.message);
    expect(refused).to.contain("lieu partagé").and.contain("force: true");
    expect(refused).to.contain(((await run("show.list")) as ShowRow[]).find((x) => !x.active)!.name); // the other show is named
    expect(((await run("venue.fixture.list")) as { id: string }[]).some((f) => f.id === "libre")).to.equal(true);
    // used as well: the uses come first, then the warning
    const used = await run("venue.fixture.delete", { id: ((await run("venue.fixture.list")) as { id: string }[])[0]!.id }).then(() => "", (e: Error) => e.message);
    expect(used).to.contain("encore utilisé").and.contain("ce lieu est partagé");
    await run("venue.fixture.delete", { id: "libre", force: true });
    expect(((await run("venue.fixture.list")) as { id: string }[]).some((f) => f.id === "libre")).to.equal(false);
  });

  it("moves the fixtures of a venue to where another one has them, after showing what would move", async () => {
    await run("show.create", { name: "Autre", venue: "copy" }); // opens on its own copy of the venue
    const placed = ((await run("venue.fixture.list")) as { id: string }[])[0]!;
    await run("venue.fixture.put", { fixture: { ...placed, position: { x: 5, y: 1, z: 3 }, mount: "truss" } });
    await run("show.open", { id: "default" });
    const positionOf = async () => ((await run("venue.fixture.list")) as { id: string; position?: object }[]).find((f) => f.id === placed.id)!.position;
    expect(await positionOf()).to.equal(undefined);
    const preview = (await run("venue.positions.import", { from: "autre" })) as { applied: boolean; moves: { id: string; name: string; from: string; by: string; changed: string[] }[]; notInSource: unknown[] };
    expect(preview.applied).to.equal(false);
    expect(preview.moves).to.deep.include({ id: placed.id, name: preview.moves[0]!.name, from: placed.id, by: "id", changed: ["position", "mount"] });
    expect(preview.notInSource).to.deep.equal([]);
    expect(await positionOf()).to.equal(undefined); // nothing written without apply
    await run("venue.positions.import", { from: "autre", apply: true });
    expect(await positionOf()).to.deep.equal({ x: 5, y: 1, z: 3 });
    expect(((await run("venue.positions.import", { from: "autre", apply: true })) as { moves: unknown[] }).moves).to.deep.equal([]); // already there
    await run("venue.positions.import", { from: "default" }).then(
      () => expect.fail("the open venue is not a source"),
      () => undefined,
    );
  });

  it("keeps the absent list where it means something: copies, a new venue, a reset, a deletion, another venue", async () => {
    const [first, second] = ((await run("venue.fixture.list")) as { id: string }[]).map((f) => f.id);
    const absentOf = (show: string) => (JSON.parse(readFileSync(join(dataRoot, "shows", show, "show.json"), "utf8")) as { absentFixtures?: string[] }).absentFixtures ?? [];
    await run("venue.fixture.presence", { fixtures: [first, second], present: false });
    // patched again under an absent id: said at once, it stays dark
    const listed = ((await run("venue.fixture.list")) as { id: string }[]).find((f) => f.id === first)!;
    expect(((await run("venue.fixture.put", { fixture: listed })) as { warning?: string }).warning).to.match(/absent/);
    await run("show.create", { name: "Copie", from: "default", venue: "copy", open: false });
    expect(absentOf("copie")).to.deep.equal([first, second].sort()); // its venue is a copy: the same fixtures are absent
    await run("show.create", { name: "Neuf", from: "default", venue: "new", open: false });
    expect(absentOf("neuf")).to.deep.equal([]); // an empty venue: nothing to be absent from
    await run("show.reset");
    expect(absentOf("default")).to.deep.equal([first, second].sort()); // the venue kept, so is what is not installed
    await run("venue.fixture.delete", { id: first, force: true });
    expect(absentOf("default")).to.deep.equal([second]); // gone from the patch, gone from the list
    // on another venue, the ids are kept; only those it has are reported as dark
    expect(await run("show.venue.set", { venue: "neuf" })).to.deep.include({ venue: "neuf", absent: [] });
    await run("venue.fixture.presence", { fixtures: [], present: false });
    expect(absentOf("default")).to.deep.equal([second]); // an edit on this venue keeps the other venue's ids
    expect(await run("show.venue.set", { venue: "default" })).to.deep.include({ absent: [second] });
  });

  it("keeps a restored show on the venue it was restored into, and refuses a venue that is not an id", async () => {
    await run("show.create", { name: "Autre", open: false }); // shares the venue
    const { file } = (await run("backup.create")) as { file: string };
    await run("show.venue.detach"); // the open show now on its own copy
    await run("backup.restore", { file }); // packed when it played on the shared venue
    expect(saved.venue).to.equal("default-2");
    expect((JSON.parse(readFileSync(join(dataRoot, "shows", "default", "show.json"), "utf8")) as { venue: string }).venue).to.equal("default-2");
    expect(((await run("show.list")) as ShowRow[]).find((s) => s.id === "default")!.venue).to.equal("default-2");
    // a hand-edited show.json naming a path
    writeFileSync(join(dataRoot, "shows", "autre", "show.json"), JSON.stringify({ name: "Autre", venue: "../shows/default" }));
    for (const [command, args] of [["show.open", { id: "autre" }], ["show.venue.detach", { show: "autre" }]] as const) {
      await run(command, args).then(
        () => expect.fail(`${command} follows a venue outside data/venues`),
        (e: Error) => expect(e.message).to.match(/invalid|invalide/),
      );
    }
  });

  it("previews a position import from a damaged venue without failing on it", async () => {
    await run("show.create", { name: "Source", venue: "copy" });
    const placed = ((await run("venue.fixture.list")) as { id: string }[])[0]!;
    await run("stage.zone.put", { zone: { id: "ailleurs", name: "Ailleurs", polygon: [[0, 0], [1, 0], [1, 1]] } });
    await run("venue.fixture.put", { fixture: { ...placed, position: { x: 1, y: 1, z: 1 }, target: "ailleurs" } });
    await run("show.open", { id: "default" });
    writeFileSync(join(dataRoot, "venues", "source", "fixtures", "broken.json"), "{ not json");
    const preview = (await run("venue.positions.import", { from: "source" })) as { moves: { id: string; changed: string[]; skipped?: string[] }[]; unreadable?: string[] };
    expect(preview.unreadable).to.deep.equal(["broken.json"]);
    expect(preview.moves.find((m) => m.id === placed.id)).to.deep.include({ changed: ["position"], skipped: ["target"] }); // no such zone here
  });

  it("keeps named backups on the server", async () => {
    const { file } = (await run("backup.create", { label: "Avant répétition" })) as { file: string };
    expect(file).to.match(/^default-.*-avant-repetition\.lightshow$/);
    const unknown = await run("backup.restore", { file: "../machine/config.json" }).then(() => "restored", (e: Error) => e.message);
    expect(unknown).to.match(/sauvegarde inconnue/);
  });
});
