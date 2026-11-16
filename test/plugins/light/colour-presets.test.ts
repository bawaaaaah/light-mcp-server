import { expect } from "chai";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext, type CommandContext } from "../../../src/plugins/light/commands/registry.js";
import { citedColours, colourUses, newColourId, reorderFavorites, rgbOf, stackColours, withFavorite } from "../../../src/plugins/light/show/colour-presets.js";
import { packArchive, readArchive } from "../../../src/plugins/light/data/archive.js";

/** Colour presets with favourites (T41; docs/specs/presets-songs-notes.md, « Presets de couleur »). */
describe("colour presets (T41)", () => {
  describe("pure", () => {
    it("stacks the personal library under the show: the show's wins and says what it covers", () => {
      const s = stackColours([{ id: "a", name: "Ambre", color: "#ffaa00" }, { id: "b", name: "Bleu", color: "#0000ff" }], [{ id: "b", name: "Bleu du show", color: "#0011ff" }]);
      expect(s.get("a")).to.include({ origin: "personal" });
      expect(s.get("b")).to.include({ origin: "show", over: "personal", color: "#0011ff" });
    });

    it("adds, moves and removes favourites; a new order keeps what it does not name", () => {
      expect(withFavorite(["a", "b"], "c", true)).to.deep.equal(["a", "b", "c"]);
      expect(withFavorite(["a", "b", "c"], "c", true, 0)).to.deep.equal(["c", "a", "b"]);
      expect(withFavorite(["a", "b", "c"], "a", true)).to.deep.equal(["a", "b", "c"]); // already there: stays where it is
      expect(withFavorite(["a", "b", "c"], "b", false)).to.deep.equal(["a", "c"]);
      expect(withFavorite(["a", "a", ""], "z", false)).to.deep.equal(["a"]);
      expect(reorderFavorites(["a", "b", "c"], ["c", "a"])).to.deep.equal(["c", "a", "b"]);
      expect(() => reorderFavorites(["a"], ["x"])).to.throw(/x/);
    });

    it("finds what cites a preset: mappings and song cues use it, favourites are cited but no use", () => {
      const mappings = [{ id: "m", label: "Pad 1", on: { command: "colour.apply", args: { id: "a", group: "g" } } }];
      const songs = [{ id: "s", title: "Chant", cues: [{ command: "colour.apply", args: { id: "b" } }] }];
      expect(colourUses("a", { mappings, songs })).to.deep.equal(["mapping MIDI « Pad 1 »"]);
      expect(colourUses("b", { mappings, songs })).to.deep.equal(["chant « Chant » (1 action de la piste)"]);
      expect(citedColours({ mappings, songs, favorites: ["c", "a"] })).to.deep.equal(["c", "a", "b"]);
    });

    it("makes ids that do not come from the name, and reads a colour's components", () => {
      expect(newColourId(1_700_000_000_000, () => 0.5)).to.match(/^c-[a-z0-9]+-[a-z0-9]{4}$/);
      expect(rgbOf("#ff8000")).to.deep.equal({ red: 1, green: 0.502, blue: 0 });
    });
  });

  describe("commands", () => {
    let plugin: LightPlugin;
    let dataRoot: string;
    const run = (name: string, args: unknown = {}, ctx: CommandContext = systemContext()) => plugin.commands.invoke(name, args, ctx);
    const failure = async (p: Promise<unknown>): Promise<Error & { detail?: unknown }> => {
      try {
        await p;
      } catch (e) {
        return e as Error & { detail?: unknown };
      }
      throw new Error("expected a refusal");
    };
    type Listed = { presets: { id: string; name: string; color: string; origin: string; over?: string; favorite?: number; usedBy: string[] }[]; favorites: string[]; missing: string[] };
    const list = async () => (await run("colour.preset.list")) as Listed;
    const put = async (preset: object, more: object = {}) => ((await run("colour.preset.put", { preset, ...more })) as { preset: { id: string } }).preset.id;
    const start = () => {
      const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    };

    beforeEach(() => {
      dataRoot = join(mkdtempSync(join(tmpdir(), "light-colours-")), "data");
      mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
      for (const f of ["par-rgb.qxf", "spot.qxf"]) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(dataRoot, "fixtures", f));
      start();
      plugin.venue.fixtures.put({ id: "par", name: "Par", manufacturer: "Test", model: "Par RGB", mode: "3 Channel", universe: 1, address: 1 });
      plugin.venue.fixtures.put({ id: "par2", name: "Par 2", manufacturer: "Test", model: "Par RGB", mode: "3 Channel", universe: 1, address: 4 });
      plugin.venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 11 });
      plugin.runtime.groups.put({ id: "face", name: "Face", members: { fixtures: ["par", "par2"] } });
    });
    afterEach(async () => {
      await plugin.stop();
    });

    it("creates in the show or the personal library, with a generated id, the show's winning; favourites keep their order", async () => {
      const ambre = await put({ name: "Ambre", color: "#FFAA00" });
      expect(ambre).to.match(/^c-/);
      expect(existsSync(join(dataRoot, "shows", "default", "colours", `${ambre}.json`))).to.equal(true);
      const bleu = await put({ name: "Bleu", color: "#0000ff" }, { scope: "personal", favorite: true });
      expect(existsSync(join(dataRoot, "private", "colours", `${bleu}.json`))).to.equal(true);
      await run("colour.preset.favorite", { id: ambre, index: 0 });
      let l = await list();
      expect(l.favorites).to.deep.equal([ambre, bleu]);
      expect(l.presets.find((p) => p.id === ambre)).to.include({ origin: "show", color: "#ffaa00", favorite: 0 });
      expect(l.presets.find((p) => p.id === bleu)).to.include({ origin: "personal", favorite: 1 });
      // a copy of the personal one into the show covers it
      await put({ id: bleu, name: "Bleu du show", color: "#0011ff" });
      expect((await list()).presets.find((p) => p.id === bleu)).to.include({ origin: "show", over: "personal", name: "Bleu du show" });
      await run("colour.preset.order", { ids: [bleu] });
      expect((await list()).favorites).to.deep.equal([bleu, ambre]);
      // deleting the show's copy gives the personal one back, still a favourite
      expect(await run("colour.preset.delete", { id: bleu })).to.include({ action: "reverted" });
      l = await list();
      expect(l.presets.find((p) => p.id === bleu)).to.include({ origin: "personal", name: "Bleu" });
      expect(l.favorites).to.deep.equal([bleu, ambre]);
      // another show sees the personal one, not the show's
      await run("show.create", { name: "Autre" });
      l = await list();
      expect(l.presets.map((p) => p.id)).to.deep.equal([bleu]);
      expect(l.favorites).to.deep.equal([]);
      // invalid input refused
      expect((await failure(put({ name: "X", color: "rouge" }))).message).to.match(/#rrggbb/);
      expect((await failure(put({ name: "  ", color: "#000000" }))).message).to.match(/name/);
      expect((await failure(run("colour.preset.favorite", { id: "nope" }))).message).to.match(/inconnu/);
    });

    it("refuses to delete a preset a mapping uses, unless force, and drops it from the favourites", async () => {
      const id = await put({ name: "Rouge", color: "#ff0000" }, { favorite: true });
      await run("midi.mapping.put", { mapping: { id: "m1", label: "Pad rouge", input: { type: "note", channel: 1, number: 36 }, mode: "trigger", on: { command: "colour.apply", args: { id, group: "face" } } } });
      expect((await list()).presets[0]!.usedBy).to.deep.equal(["mapping MIDI « Pad rouge »"]);
      const refused = await failure(run("colour.preset.delete", { id }));
      expect(refused.message).to.match(/Pad rouge/);
      expect(await run("colour.preset.delete", { id, force: true })).to.include({ action: "deleted" });
      expect((await list()).favorites).to.deep.equal([]);
      // its versions are kept, and it comes back through history.restore
      const deleted = (await run("history.deleted", { collection: "colours" })) as { id: string; stamp: string }[];
      expect(deleted[0]!.id).to.equal(id);
      await run("history.restore", { collection: "colours", id, stamp: deleted[0]!.stamp });
      expect((await list()).presets.map((p) => p.name)).to.deep.equal(["Rouge"]);
    });

    it("applies a colour by hand to a fixture or a group through its RGB channel faders, and gives it back", async () => {
      const id = await put({ name: "Orange", color: "#ff8000" });
      const done = (await run("colour.apply", { id, group: "face" })) as { applied: string[]; skipped: unknown[] };
      expect(done.applied).to.deep.equal(["par", "par2"]);
      const levels = () => Object.fromEntries(plugin.runtime.faders.list().map((f) => [`${f.channels[0]!.fixture}:${f.channels[0]!.offset}`, f.level]));
      expect(levels()).to.deep.include({ "par:0": 1, "par:1": 0.502, "par:2": 0, "par2:0": 1 });
      // a fixture with no red/green/blue is said, not an error when another took it
      const mixed = (await run("colour.apply", { color: "#00ff00", fixtures: ["par", "spot"] })) as { applied: string[]; skipped: { fixture: string }[] };
      expect(mixed.applied).to.deep.equal(["par"]);
      expect(mixed.skipped.map((s) => s.fixture)).to.deep.equal(["spot"]);
      expect(levels()).to.deep.include({ "par:0": 0, "par:1": 1 });
      expect((await failure(run("colour.apply", { color: "#00ff00", fixtures: ["spot"] }))).message).to.match(/aucun appareil/);
      expect((await failure(run("colour.apply", { fixtures: ["par"] }))).message).to.match(/l'un des deux/);
      await run("colour.release", { group: "face" });
      expect(levels()).to.deep.include({ "par:0": 0, "par:1": 0, "par:2": 0, "par2:0": 0 });
      // the faders are the panel's: one per channel, reused
      expect(plugin.runtime.faders.list().filter((f) => f.channels[0]!.fixture === "par")).to.have.length(3);
    });

    it("packs the personal presets the show cites into its archive, and leaves them in the library when restored on a machine that has them", async () => {
      const mine = await put({ name: "Ambre", color: "#ffaa00" }, { scope: "personal", favorite: true });
      const unused = await put({ name: "Gris", color: "#808080" }, { scope: "personal" });
      const own = await put({ name: "Rose", color: "#ff66aa" }, { favorite: true });
      const extra = plugin.showExtra();
      expect(Object.keys(extra).filter((k) => k.startsWith("colours/"))).to.deep.equal([`colours/${mine}.json`]);
      expect(Object.keys(extra)).to.not.include(`colours/${unused}.json`);
      const bytes = packArchive({ show: { id: "default", dir: join(dataRoot, "shows", "default"), extra } });
      const content = readArchive(bytes);
      expect(content.manifest.colours).to.deep.equal([mine]);
      expect(Object.keys(content.show)).to.include.members([`colours/${mine}.json`, `colours/${own}.json`]);
      // this machine has it as it is: it stays in the library
      expect(plugin.previewArchive(bytes).coloursKnown).to.deep.equal([{ id: mine, name: "Ambre" }]);
      // changed here since: the archive's copy comes back as the show's own
      await put({ id: mine, name: "Ambre foncé", color: "#cc8800" }, { scope: "personal" });
      expect(plugin.previewArchive(bytes).coloursKnown).to.deep.equal([]);
    });
  });
});
