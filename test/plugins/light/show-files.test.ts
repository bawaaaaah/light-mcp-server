import { expect } from "chai";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

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
    await run("venue.fixture.delete", { id: "bar-0" });
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

  it("keeps named backups on the server", async () => {
    const { file } = (await run("backup.create", { label: "Avant répétition" })) as { file: string };
    expect(file).to.match(/^default-.*-avant-repetition\.lightshow$/);
    const unknown = await run("backup.restore", { file: "../machine/config.json" }).then(() => "restored", (e: Error) => e.message);
    expect(unknown).to.match(/sauvegarde inconnue/);
  });
});
