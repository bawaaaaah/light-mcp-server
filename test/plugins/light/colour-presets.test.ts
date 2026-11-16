import { expect } from "chai";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext, type CommandContext } from "../../../src/plugins/light/commands/registry.js";
import { citedColours, colourUses, favoritesInOrder, newColourId, reorderFavorites, stackColours, withFavorite } from "../../../src/plugins/light/show/colour-presets.js";
import { nextManual, recolour, underManual } from "../../../src/plugins/light/show/manual-colour.js";
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

    it("makes ids that do not come from the name, and orders the favourites by rank then name", () => {
      expect(newColourId(1_700_000_000_000, () => 0.5)).to.match(/^c-[a-z0-9]+-[a-z0-9]{4}$/);
      const order = favoritesInOrder([
        { id: "b", name: "Bleu", favorite: 2 },
        { id: "a", name: "Ambre" },
        { id: "z", name: "Zinc", favorite: 1 },
        { id: "c", name: "Cyan", favorite: 2 },
      ]).map((e) => e.id);
      expect(order).to.deep.equal(["z", "b", "c"]);
    });

    it("recolours at the looks' brightness, fades in from what showed, and back", () => {
      // the hue of the preset at the brightness of what the look paints; white and the rest go to 0
      expect(recolour({ red: 0.5, white: 0.2 }, { red: 0, green: 0, blue: 1 })).to.deep.equal({ red: 0, green: 0, blue: 0.5 });
      // a dim preset gives the same hue as a bright one
      expect(recolour({ green: 1 }, { red: 0.5, green: 0.25, blue: 0 })).to.deep.equal({ red: 1, green: 0.5, blue: 0 });
      expect(recolour({}, { red: 1 })).to.deep.equal({ red: 0, green: 0, blue: 0 });
      const look = { red: 1, green: 0, blue: 0 };
      const blue = nextManual(undefined, { red: 0, green: 0, blue: 1 }, "#0000ff", 0, 1000);
      expect(underManual(blue, look, 0)).to.deep.equal(look);
      const half = underManual(blue, look, 500);
      expect(half.red).to.be.closeTo(0.5, 1e-9);
      expect(half.blue).to.be.closeTo(0.5, 1e-9);
      expect(underManual(blue, look, 1000)).to.deep.equal({ red: 0, green: 0, blue: 1 });
      // another colour mid-fade starts from what shows then, not from the look
      const green = nextManual(blue, { red: 0, green: 1, blue: 0 }, "#00ff00", 500, 1000);
      expect(underManual(green, look, 500).blue).to.be.closeTo(0.5, 1e-9);
      // released: back to the look
      const back = nextManual(green, null, null, 2000, 1000);
      expect(underManual(back, look, 2000)).to.deep.equal({ red: 0, green: 1, blue: 0 });
      expect(underManual(back, look, 3000)).to.deep.equal(look);
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
    type Listed = { presets: { id: string; name: string; color: string; origin: string; over?: string; favorite?: number; usedBy: string[] }[]; favorites: string[] };
    const list = async () => (await run("colour.preset.list")) as Listed;
    const put = async (preset: object, more: object = {}) => ((await run("colour.preset.put", { preset, ...more })) as { preset: { id: string } }).preset.id;
    let now = 0;
    /** One frame of the engine at the test's clock, `ms` later. */
    const during = (ms: number) => {
      for (let t = 0; t < ms; t += 20) {
        (plugin.engine as unknown as { frame(now: number): void }).frame(now);
        now += 20;
      }
    };
    const out = (from: number, n: number) => [...plugin.engine.output.get(1).slice(from - 1, from - 1 + n)];
    const start = () => {
      const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null, now: () => now });
    };

    beforeEach(() => {
      now = 0;
      dataRoot = join(mkdtempSync(join(tmpdir(), "light-colours-")), "data");
      mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
      for (const f of ["par-rgb.qxf", "wheel-spot.qxf", "machine.qxf"]) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(dataRoot, "fixtures", f));
      start();
      plugin.venue.fixtures.put({ id: "par", name: "Par", manufacturer: "Test", model: "Par RGB", mode: "3 Channel", universe: 1, address: 1 });
      plugin.venue.fixtures.put({ id: "par2", name: "Par 2", manufacturer: "Test", model: "Par RGB", mode: "3 Channel", universe: 1, address: 4 });
      plugin.venue.fixtures.put({ id: "wheel", name: "Roue", manufacturer: "Test", model: "Wheel Spot", mode: "Standard", universe: 1, address: 11 });
      plugin.venue.fixtures.put({ id: "smoke", name: "Fumée", manufacturer: "Test", model: "Machine 1", mode: "1 Channel", universe: 1, address: 20 });
      plugin.venue.canvases.put({ id: "all", name: "Tout", topology: "line", cells: 3, render: [{ from: 0, to: 0, targets: [{ fixture: "par", head: -1 }] }, { from: 1, to: 1, targets: [{ fixture: "par2", head: -1 }] }, { from: 2, to: 2, targets: [{ fixture: "wheel", head: -1 }] }] });
      plugin.venue.canvases.put({ id: "one", name: "Par seul", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "par", head: -1 }] }] });
      plugin.runtime.groups.put({ id: "face", name: "Face", members: { fixtures: ["par", "par2"] } });
      plugin.runtime.looks.put({ id: "rouge", name: "Rouge", canvas: "all", technique: { kind: "plat", color: "#ff0000" } });
      plugin.runtime.looks.put({ id: "demi", name: "Demi", canvas: "all", technique: { kind: "plat", color: "#800000" } });
      plugin.runtime.looks.put({ id: "seul", name: "Seul", canvas: "one", technique: { kind: "plat", color: "#00ff00" } });
    });
    afterEach(async () => {
      await plugin.stop();
    });

    it("creates in the show or the personal library, the show's winning; favourites are ranks on the presets themselves", async () => {
      const ambre = await put({ name: "Ambre", color: "#FFAA00" });
      expect(ambre).to.match(/^c-/);
      expect(existsSync(join(dataRoot, "shows", "default", "colours", `${ambre}.json`))).to.equal(true);
      const bleu = await put({ name: "Bleu", color: "#0000ff" }, { scope: "personal", favorite: true });
      expect(existsSync(join(dataRoot, "private", "colours", `${bleu}.json`))).to.equal(true);
      await run("colour.preset.favorite", { id: ambre, index: 0 });
      let l = await list();
      expect(l.favorites).to.deep.equal([ambre, bleu]);
      expect(l.presets.find((p) => p.id === ambre)).to.include({ origin: "show", color: "#ffaa00", favorite: 1 });
      expect(l.presets.find((p) => p.id === bleu)).to.include({ origin: "personal", favorite: 2 });
      // a copy of the personal one into the show covers it, and keeps its rank
      await put({ id: bleu, name: "Bleu du show", color: "#0011ff" });
      expect((await list()).presets.find((p) => p.id === bleu)).to.include({ origin: "show", over: "personal", name: "Bleu du show", favorite: 2 });
      await run("colour.preset.order", { ids: [bleu] });
      expect((await list()).favorites).to.deep.equal([bleu, ambre]);
      // deleting the show's copy gives the personal one back, favourite at the rank it had in the library
      expect(await run("colour.preset.delete", { id: bleu })).to.include({ action: "reverted" });
      l = await list();
      expect(l.presets.find((p) => p.id === bleu)).to.include({ origin: "personal", name: "Bleu" });
      expect(l.favorites).to.deep.equal([ambre, bleu]);
      // another show sees the personal one, a favourite there too; not the show's
      await run("show.create", { name: "Autre" });
      l = await list();
      expect(l.presets.map((p) => p.id)).to.deep.equal([bleu]);
      expect(l.favorites).to.deep.equal([bleu]);
      // taken out of the favourites: in every show
      await run("colour.preset.favorite", { id: bleu, favorite: false });
      expect((await list()).favorites).to.deep.equal([]);
      // invalid input refused
      expect((await failure(put({ name: "X", color: "rouge" }))).message).to.match(/#rrggbb/);
      expect((await failure(put({ name: "  ", color: "#000000" }))).message).to.match(/name/);
      expect((await failure(run("colour.preset.favorite", { id: "nope" }))).message).to.match(/inconnu/);
    });

    it("migrates the favourites a show.json still lists into ranks, in that order, and drops the list", async () => {
      const a = await put({ name: "A", color: "#110000" });
      const b = await put({ name: "B", color: "#220000" }, { scope: "personal" });
      plugin.runtime.saveSettings({ colourFavorites: [b, "inconnu", a] });
      expect((await list()).favorites).to.deep.equal([b, a]);
      expect(plugin.runtime.settings.colourFavorites).to.equal(undefined);
      expect(plugin.colours.personal.get(b)!.favorite).to.equal(1);
    });

    it("refuses to delete a preset a mapping uses, unless force; its versions bring it back", async () => {
      const id = await put({ name: "Rouge", color: "#ff0000" }, { favorite: true });
      await run("midi.mapping.put", { mapping: { id: "m1", label: "Pad rouge", input: { type: "note", channel: 1, number: 36 }, mode: "trigger", on: { command: "colour.apply", args: { id, group: "face" } } } });
      expect((await list()).presets[0]!.usedBy).to.deep.equal(["mapping MIDI « Pad rouge »"]);
      const refused = await failure(run("colour.preset.delete", { id }));
      expect(refused.message).to.match(/Pad rouge/);
      expect(await run("colour.preset.delete", { id, force: true })).to.include({ action: "deleted" });
      expect((await list()).favorites).to.deep.equal([]);
      const deleted = (await run("history.deleted", { collection: "colours" })) as { id: string; stamp: string }[];
      expect(deleted[0]!.id).to.equal(id);
      await run("history.restore", { collection: "colours", id, stamp: deleted[0]!.stamp });
      expect((await list()).presets.map((p) => p.name)).to.deep.equal(["Rouge"]);
    });

    it("replaces the look's colour on the fixtures at its brightness, with a fade, and gives it back with a fade", async () => {
      const id = await put({ name: "Bleu", color: "#0000ff" });
      await run("look.go", { id: "demi" });
      during(200);
      expect(out(1, 3)).to.deep.equal([128, 0, 0]);
      const done = (await run("colour.apply", { id, group: "face" })) as { applied: string[] };
      expect(done.applied).to.deep.equal(["par", "par2"]);
      // half way through the default 1 s fade: between red and blue
      during(500);
      const mid = out(1, 3);
      expect(mid[0]).to.be.within(20, 110);
      expect(mid[2]).to.be.within(20, 110);
      // replaced (no mix with the look's red), at the look's brightness, on the group only
      during(700);
      expect(out(1, 3)).to.deep.equal([0, 0, 128]);
      expect(out(4, 3)).to.deep.equal([0, 0, 128]);
      expect(plugin.runtime.manualColour("par")).to.equal("#0000ff");
      // no channel fader is created for it
      expect(plugin.runtime.faders.list()).to.deep.equal([]);
      await run("colour.release", { fixtures: ["par"], fade: 0 });
      during(40);
      expect(out(1, 3)).to.deep.equal([128, 0, 0]);
      expect(out(4, 3)).to.deep.equal([0, 0, 128]);
      // a fixture no look lights stays dark
      await run("look.stopall");
      during(2000);
      expect(out(4, 3)).to.deep.equal([0, 0, 0]);
    });

    it("lets a new look on the fixtures, or the Panic, take the colour back; a look elsewhere leaves it", async () => {
      await run("look.go", { id: "rouge" });
      await run("colour.apply", { color: "#00ff00", group: "face", fade: 0 });
      during(100);
      expect(out(1, 3)).to.deep.equal([0, 255, 0]);
      // a look painting only « par »: par goes back to the looks, par2 keeps its colour
      await run("look.go", { id: "seul" });
      expect(plugin.runtime.manualColour("par")).to.equal(undefined);
      expect(plugin.runtime.manualColour("par2")).to.equal("#00ff00");
      await run("colour.apply", { color: "#0000ff", fixtures: ["par2"], fade: 0 });
      await run("panic");
      expect(plugin.runtime.manualColour("par2")).to.equal(undefined);
    });

    it("turns a colour wheel to its slot nearest the colour, and leaves out what cannot take a colour", async () => {
      await run("look.go", { id: "rouge" });
      during(3000);
      expect(out(13, 1)[0]).to.be.within(10, 19); // red slot
      const r = (await run("colour.apply", { color: "#0000ff", fixtures: ["wheel", "smoke"], fade: 0 })) as { applied: string[]; skipped: { fixture: string }[] };
      expect(r.applied).to.deep.equal(["wheel"]);
      expect(r.skipped.map((x) => x.fixture)).to.deep.equal(["smoke"]);
      during(3000);
      expect(out(13, 1)[0]).to.be.within(60, 69); // blue slot
      expect((await failure(run("colour.apply", { color: "#00ff00", fixtures: ["smoke"] }))).message).to.match(/aucun appareil/);
      expect((await failure(run("colour.apply", { fixtures: ["par"] }))).message).to.match(/l'un des deux/);
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
