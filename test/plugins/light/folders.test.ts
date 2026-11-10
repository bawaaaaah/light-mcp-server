import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

describe("show folders: the looks' dossier: tag moved, renamed, disbanded", () => {
  let plugin: LightPlugin;
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  const tags = async (id: string) => ((await run("look.get", { id })) as { tags: string[] }).tags;
  const freeTags = (list: string[]) => list.filter((t) => !t.startsWith("dossier:"));
  const folderTags = (list: string[]) => list.filter((t) => t.startsWith("dossier:"));

  before(async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-folders-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
  });

  it("moves whole looks into a folder and back, and refuses entirely on an unknown id", async () => {
    const before = freeTags(await tags("checker"));
    const paletteFree = freeTags(await tags("palette"));
    expect(before).to.not.be.empty; // the import's technique tags stay whatever the folder does
    await run("show.folder.move", { ids: ["checker", "palette"], folder: "Scènes" });
    expect(folderTags(await tags("checker"))).to.deep.equal(["dossier:Scènes"]);
    expect(freeTags(await tags("palette"))).to.deep.equal(paletteFree); // the other tags are kept
    let refused = "";
    await run("show.folder.move", { ids: ["breath", "nope"], folder: "Autre" }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("nope");
    expect(folderTags(await tags("breath"))).to.deep.equal([]); // refused before any write
    await run("show.folder.move", { ids: ["checker", "palette"] });
    expect(folderTags(await tags("checker"))).to.deep.equal([]);
    expect(freeTags(await tags("checker"))).to.deep.equal(before);
  });

  it("cleans an empty, doubled or untrimmed folder tag as the look is saved, and counts a look under its first folder", async () => {
    const look = (await run("look.get", { id: "hole" })) as Record<string, unknown>;
    await run("look.put", { look: { ...look, tags: ["dossier:", "dossier: A /", "dossier:A", "libre"] } });
    const saved = await tags("hole");
    expect(saved).to.include("libre"); // the free tags of the look are kept
    expect(folderTags(saved)).to.deep.equal(["dossier:A"]); // one tag, its path trimmed: the folder « A » renames and disbands
    await run("show.folder.rename", { from: "A", to: "C" });
    expect(folderTags(await tags("hole"))).to.deep.equal(["dossier:C"]);
    await run("show.folder.move", { ids: ["hole"], folder: " Foo / Bar " });
    expect(folderTags(await tags("hole"))).to.deep.equal(["dossier:Foo/Bar"]); // a name given to a command is trimmed the same way
    await run("show.folder.delete", { folder: "Foo" });
    expect(folderTags(await tags("hole"))).to.deep.equal([]);
  });

  it("refuses a whole folder command when one of its looks no longer passes, before any write", async () => {
    await run("show.folder.move", { ids: ["checker", "palette"], folder: "Lot" });
    const broken: Record<string, unknown> = { ...((await run("look.get", { id: "palette" })) as Record<string, unknown>), canvas: "gone" };
    delete broken.active;
    delete broken.swatch;
    plugin.runtime.looks.put(broken as never); // stored past look.put: its canvas has since gone
    let refused = "";
    await run("show.folder.rename", { from: "Lot", to: "Autre lot" }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("gone");
    expect(refused).to.contain("(palette)"); // the look that holds the folder back is named
    expect(folderTags(await tags("checker"))).to.deep.equal(["dossier:Lot"]); // nothing renamed half way
    plugin.runtime.looks.put({ ...broken, canvas: (await run("look.get", { id: "checker" }) as { canvas: string }).canvas } as never);
    await run("show.folder.delete", { folder: "Lot" });
  });

  it("reads the folders named ahead normalised, as the looks' tags are", async () => {
    plugin.runtime.saveSettings({ folders: [" A / B ", "A/B", " / "] });
    expect(((await run("show.settings")) as { folders: string[] }).folders).to.deep.equal(["A/B"]);
    await run("show.folder.delete", { folder: "A" });
    expect(((await run("show.settings")) as { folders: string[] }).folders).to.deep.equal([]);
  });

  it("refuses to nest a folder where one of the same name already sits, rather than merge them unseen", async () => {
    await run("show.folder.move", { ids: ["checker"], folder: "X/B" });
    await run("show.folder.move", { ids: ["palette"], folder: "B" });
    let refused = "";
    await run("show.folder.nest", { src: "B", under: "X" }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("X/B");
    expect(folderTags(await tags("palette"))).to.deep.equal(["dossier:B"]);
    await run("show.folder.delete", { folder: "X" });
    await run("show.folder.delete", { folder: "B" });
  });

  it("renames onto an existing folder to merge the two, and disbands keeps the looks", async () => {
    await run("show.folder.move", { ids: ["masks"], folder: "Duo" });
    await run("show.folder.move", { ids: ["breath"], folder: "Autre" });
    await run("show.folder.rename", { from: "Duo", to: "Autre" });
    expect(folderTags(await tags("masks"))).to.deep.equal(["dossier:Autre"]);
    await run("show.folder.delete", { folder: "Autre" });
    expect(folderTags(await tags("masks"))).to.deep.equal([]);
    expect(folderTags(await tags("breath"))).to.deep.equal([]);
  });

  it("names folders ahead: they exist empty, rename and disband keep the list truthfully", async () => {
    const named = async () => ((await run("show.settings")) as { folders: string[] }).folders;
    await run("show.folder.create", { folder: "Vide" });
    await run("show.folder.create", { folder: "Vide" });
    expect(await named()).to.deep.equal(["Vide"]); // named twice, stored once
    await run("show.folder.create", { folder: "Éclairage" });
    expect(await named()).to.deep.equal(["Éclairage", "Vide"]);
    await run("show.folder.rename", { from: "Éclairage", to: "Lumière" });
    expect(await named()).to.deep.equal(["Lumière", "Vide"]); // an empty folder renames too
    await run("show.folder.delete", { folder: "Vide" });
    expect(await named()).to.deep.equal(["Lumière"]);
    // a named folder with a look inside: the look is emptied and the folder stops existing
    await run("show.folder.move", { ids: ["checker"], folder: "Lumière" });
    await run("show.folder.delete", { folder: "Lumière" });
    expect(folderTags(await tags("checker"))).to.deep.equal([]);
    expect(await named()).to.deep.equal([]);
  });

  it("nests folders by path: a rename, a nesting or a disbanding carries the subtree along", async () => {
    const named = async () => ((await run("show.settings")) as { folders: string[] }).folders;
    await run("show.folder.create", { folder: "A/B" });
    await run("show.folder.move", { ids: ["palette"], folder: "A" });
    await run("show.folder.move", { ids: ["hole"], folder: "A/B" });
    await run("show.folder.rename", { from: "A", to: "Rig" });
    expect(folderTags(await tags("palette"))).to.deep.equal(["dossier:Rig"]);
    expect(folderTags(await tags("hole"))).to.deep.equal(["dossier:Rig/B"]); // the sub keeps its tail
    expect(await named()).to.deep.equal(["Rig/B"]); // the named list follows the path
    await run("show.folder.create", { folder: "Famille" });
    await run("show.folder.nest", { src: "Rig/B", under: "Famille" });
    expect(folderTags(await tags("hole"))).to.deep.equal(["dossier:Famille/B"]);
    expect(await named()).to.deep.equal(["Famille", "Famille/B"]);
    // a folder cannot nest in its own branch: refused, and nothing written
    let refused = "";
    await run("show.folder.nest", { src: "Famille", under: "Famille/B" }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("Famille");
    expect(await named()).to.deep.equal(["Famille", "Famille/B"]);
    // disbanding the top takes the whole branch
    await run("show.folder.delete", { folder: "Famille" });
    expect(folderTags(await tags("hole"))).to.deep.equal([]);
    expect(folderTags(await tags("palette"))).to.deep.equal(["dossier:Rig"]); // « Rig » stands out of the disbanded branch
    expect(await named()).to.deep.equal([]);
    await run("show.folder.delete", { folder: "Rig" });
    expect(folderTags(await tags("palette"))).to.deep.equal([]);
  });
});
