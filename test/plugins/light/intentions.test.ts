import { expect } from "chai";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { CommandError, systemContext } from "../../../src/plugins/light/commands/registry.js";
import { loadKnowledgeLayers, normalizeMood, proposeLook } from "../../../src/plugins/light/knowledge/knowledge.js";
import { mergeKnowledge, stackIntentions, type Intention } from "../../../src/plugins/light/knowledge/intentions.js";
import { intentionUses } from "../../../src/plugins/light/show/references.js";

const intention = (id: string, colors: string[], more: Partial<Intention> = {}): Intention => ({ id, label: id, colors, energy: "pose", family: "", ...more });

describe("intentions (T15)", () => {
  describe("keys and layers (pure)", () => {
    it("gives one key to a label whatever its case, accents, spaces or punctuation", () => {
      expect(normalizeMood("Joie")).to.equal("joie");
      expect(normalizeMood("joie !")).to.equal("joie");
      expect(normalizeMood("  Lever de rideau ")).to.equal("lever-de-rideau");
      expect(normalizeMood("Lever-de-rideau")).to.equal("lever-de-rideau");
      expect(normalizeMood("Intimité")).to.equal("intimite");
      expect(normalizeMood("?!")).to.equal("");
      // every shipped key is already one
      for (const k of Object.keys(loadKnowledgeLayers().generic.moods)) expect(normalizeMood(k)).to.equal(k);
    });

    it("finds the same intention by its label, its key or a word with spaces (proposeLook, usesOf)", () => {
      const kb = mergeKnowledge(loadKnowledgeLayers(), [], [intention("lever-de-rideau", ["#112233"], { label: "Lever de rideau" })]);
      for (const word of ["Lever de rideau", "lever-de-rideau", "LEVER DE RIDEAU !"]) expect(proposeLook(kb, { mood: [word] }).unknownMoods, word).to.deep.equal([]);
      const songs = [{ id: "a", title: "Chant A", mood: ["Lever de rideau"], sections: [] }];
      const looks = [{ id: "l", name: "Look L", canvas: "mur", tags: ["ambiance:lever de rideau"] }, { id: "m", name: "Autre", canvas: "mur", tags: ["dossier:lever-de-rideau"] }];
      expect(intentionUses("lever-de-rideau", { songs, looks })).to.deep.equal(["chant « Chant A »", "look « Look L »"]);
      expect(intentionUses("joie", { songs: [{ id: "b", title: "B", mood: ["joie !"], sections: [] }], looks: [] })).to.have.length(1);
    });

    it("stacks shipped < private file < personal < show, and a show mask hides what is below", () => {
      const dir = mkdtempSync(join(tmpdir(), "light-intent-"));
      // a private key with spaces and accents comes down to the same key as everywhere else
      writeFileSync(join(dir, "k.json"), JSON.stringify({ moods: { "Lever de Rideau": { label: "Lever", colors: ["#010101"], energy: "pose" }, joie: { colors: ["#020202"] } } }));
      const layers = loadKnowledgeLayers(join(dir, "k.json"));
      expect(layers.private!.moods).to.have.keys("lever-de-rideau", "joie");
      const personal = [intention("joie", ["#030303"]), intention("douceur", ["#040404"])];
      const show = [intention("douceur", ["#050505"]), intention("calme", ["#060606"], { hidden: true }), intention("inconnue", ["#070707"], { hidden: true })];
      const stack = stackIntentions(layers, personal, show);
      expect(stack.get("paix")).to.include({ origin: "generic", hidden: false });
      expect(stack.get("lever-de-rideau")).to.include({ origin: "private" });
      expect(stack.get("lever-de-rideau")!.over).to.equal(undefined);
      expect(stack.get("joie")).to.include({ origin: "personal", over: "private" });
      expect(stack.get("douceur")).to.include({ origin: "show", over: "personal" });
      expect(stack.get("calme")).to.include({ origin: "show", over: "generic", hidden: true });
      expect(stack.has("inconnue")).to.equal(false); // a mask of nothing means nothing
      const kb = mergeKnowledge(layers, personal, show);
      expect(kb.moods.joie!.colors).to.deep.equal(["#030303"]);
      expect(kb.moods.douceur!.colors).to.deep.equal(["#050505"]);
      expect(kb.moods.calme).to.equal(undefined);
      expect(proposeLook(kb, { mood: ["calme"] }).unknownMoods).to.deep.equal(["calme"]);
    });
  });

  describe("commands", () => {
    let dataRoot: string;
    let plugin: LightPlugin;
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    const refusal = (p: Promise<unknown>) =>
      p.then(
        () => undefined,
        (e: Error) => e,
      );
    type Kb = { moods: Record<string, { label?: string; colors: string[]; origin: string; over?: string; usedBy: string[] }>; hidden: { id: string; origin: string; over?: string }[] };
    const kb = async () => (await run("knowledge.get")) as Kb;

    beforeEach(async () => {
      dataRoot = join(mkdtempSync(join(tmpdir(), "light-intent-")), "data");
      mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
      copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
      let cfg: Record<string, unknown> = { discovery: false, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async (c) => void (cfg = c as Record<string, unknown>) }, dataRoot, midiNative: null });
      await run("venue.fixture.put", { fixture: { id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1 } });
      await run("venue.canvas.put", { canvas: { id: "mur", name: "Mur", cells: 4, render: [0, 1, 2, 3].map((h) => ({ from: h, to: h, targets: [{ fixture: "bar", head: h }] })) } });
    });

    it("creates an intention in the show, used at once by look.from_intent, and changes its proposal without a restart", async () => {
      const made = (await run("intention.put", { intention: { label: "Lever de rideau", colors: ["#FF0000", "#0000ff"], energy: "pose", family: "chaud" } })) as { intention: Intention; origin: string };
      expect(made.intention).to.include({ id: "lever-de-rideau", label: "Lever de rideau" });
      expect(made.intention.colors).to.deep.equal(["#ff0000", "#0000ff"]); // lower case
      expect(made.origin).to.equal("show");
      expect(existsSync(join(dataRoot, "shows", "default", "intentions", "lever-de-rideau.json"))).to.equal(true);
      expect((await kb()).moods["lever-de-rideau"]).to.include({ origin: "show", label: "Lever de rideau" });
      const first = (await run("look.from_intent", { name: "Ouverture", canvas: "mur", mood: ["Lever de rideau"] })) as { look: { technique: { kind: string } }; unknownMoods: string[] };
      expect(first.unknownMoods).to.deep.equal([]);
      expect(first.look.technique.kind).to.equal("respiration");
      // edited by its key: the label changes, the key stays, the proposal follows at once
      await run("intention.put", { intention: { id: "lever-de-rideau", label: "Lever du rideau", colors: ["#ff0000", "#0000ff", "#00ff00"], energy: "survolte" } });
      const second = (await run("look.from_intent", { name: "Ouverture", canvas: "mur", mood: ["lever-de-rideau"] })) as { look: { timing: { order: string } } };
      expect(second.look.timing.order).to.equal("random");
      expect((await kb()).moods["lever-de-rideau"]!.label).to.equal("Lever du rideau");
      expect(readdirSync(join(dataRoot, "shows", "default", "intentions"))).to.deep.equal(["lever-de-rideau.json"]);
      // proposed before it is written, like a look (show.diff)
      const diff = (await run("show.diff", { command: "intention.put", args: { intention: { id: "lever-de-rideau", label: "Rideau", colors: ["#ff0000"], energy: "pose" } } })) as { valid: boolean; new: boolean; changes: { path: string }[] };
      expect(diff).to.include({ valid: true, new: false });
      expect(diff.changes.map((c) => c.path)).to.include("label");
      expect((await refusal(run("show.diff", { command: "intention.put", args: { scope: "personal", intention: { id: "x", label: "x", colors: ["#ff0000"] } } })))?.message).to.match(/bibliothèque personnelle/);
    });

    it("refuses a key already taken, an empty label, a key that is not one, and a bad colour", async () => {
      await run("intention.put", { intention: { label: "Douceur", colors: ["#ffeedd"] } });
      const taken = await refusal(run("intention.put", { intention: { label: "douceur !", colors: ["#000000"] } }));
      expect(taken).to.be.instanceOf(CommandError);
      expect((taken as CommandError).detail).to.deep.equal({ exists: "douceur" });
      expect((await refusal(run("intention.put", { intention: { label: " ?! ", colors: ["#000000"] } })))?.message).to.match(/libellé vide/);
      expect((await refusal(run("intention.put", { intention: { id: "Douceur", label: "x", colors: ["#000000"] } })) as CommandError).detail).to.deep.equal({ expected: "douceur" });
      expect((await refusal(run("intention.put", { intention: { label: "Brume", colors: ["rouge"] } })))?.message).to.match(/#rrggbb/);
      // a shipped key is not taken: the new one is a touch-up of it for this show
      const joy = (await run("intention.put", { intention: { label: "Joie", colors: ["#123456"] } })) as { origin: string; over: string };
      expect(joy).to.include({ origin: "show", over: "generic" });
      expect((await kb()).moods.joie!.colors).to.deep.equal(["#123456"]);
    });

    it("refuses to delete an intention a song or a look uses, names them, and deletes on force", async () => {
      await run("intention.put", { intention: { label: "Lever de rideau", colors: ["#112233"] } });
      await run("song.put", { song: { id: "ouverture", title: "Ouverture", mood: ["Lever de rideau"], sections: [] } });
      await run("look.from_intent", { name: "Rideau", canvas: "mur", mood: ["lever de rideau"], save: true });
      expect((await kb()).moods["lever-de-rideau"]!.usedBy).to.deep.equal(["chant « Ouverture »", "look « Rideau »"]);
      expect(((await run("show.references", { kind: "intention", id: "Lever de rideau" })) as { uses: string[] }).uses).to.have.length(2);
      const refused = (await refusal(run("intention.delete", { id: "lever-de-rideau" }))) as CommandError;
      expect(refused.message).to.match(/« Lever de rideau » est encore utilisé : chant « Ouverture », look « Rideau »/);
      expect(refused.detail).to.deep.equal({ uses: ["chant « Ouverture »", "look « Rideau »"] });
      const done = (await run("intention.delete", { id: "Lever de rideau", force: true })) as { action: string; usedBy: string[] };
      expect(done.action).to.equal("deleted");
      expect(done.usedBy).to.have.length(2);
      expect((await kb()).moods["lever-de-rideau"]).to.equal(undefined);
      const lint = (await run("show.lint")) as { issues: { where: string; message: string }[] };
      expect(lint.issues.some((i) => i.where === "chant ouverture" && /intention inconnue « Lever de rideau »/.test(i.message))).to.equal(true);
    });

    it("masks a shipped intention for the show (refused while used), lists it hidden, and brings it back", async () => {
      await run("song.put", { song: { id: "s", title: "Chant", mood: ["joie"], sections: [] } });
      expect((await refusal(run("intention.delete", { id: "joie" })))?.message).to.match(/encore utilisé : chant « Chant »/);
      const hidden = (await run("intention.delete", { id: "joie", force: true })) as { action: string; origin: string };
      expect(hidden).to.include({ action: "hidden", origin: "generic" });
      const masked = await kb();
      expect(masked.moods.joie).to.equal(undefined);
      expect(masked.hidden.map((h) => h.id)).to.deep.equal(["joie"]);
      expect(((await run("look.from_intent", { name: "x", canvas: "mur", mood: ["joie"] })) as { unknownMoods: string[] }).unknownMoods).to.deep.equal(["joie"]);
      const lint = (await run("show.lint")) as { issues: { message: string }[] };
      expect(lint.issues.some((i) => /intention inconnue « joie » \(masquée dans ce show\)/.test(i.message))).to.equal(true);
      // the mask deleted: the shipped one is back, unguarded (nothing becomes unknown)
      expect(await run("intention.delete", { id: "joie" })).to.deep.include({ action: "restored", origin: "generic" });
      expect((await kb()).moods.joie).to.include({ origin: "generic" });
      // a touch-up deleted gives the shipped one back, even while used
      await run("intention.put", { intention: { id: "joie", label: "Joie", colors: ["#010203"] } });
      expect(await run("intention.delete", { id: "joie" })).to.deep.include({ action: "reverted", origin: "generic" });
      expect((await kb()).moods.joie!.colors).to.not.deep.equal(["#010203"]);
    });

    it("keeps personal intentions for every show of the machine, below the show's, never in the show folder", async () => {
      const own = (await run("intention.put", { intention: { label: "Douceur", colors: ["#aabbcc"] }, scope: "personal" })) as { origin: string; scope: string };
      expect(own).to.include({ origin: "personal", scope: "personal" });
      expect(existsSync(join(dataRoot, "private", "intentions", "douceur.json"))).to.equal(true);
      expect(existsSync(join(dataRoot, "shows", "default", "intentions"))).to.equal(false);
      await run("song.put", { song: { id: "s", title: "Chant", mood: ["douceur"], sections: [] } });
      // the lint says it does not travel with the show
      const lint = (await run("show.lint")) as { issues: { message: string }[] };
      expect(lint.issues.some((i) => /« Douceur » de la bibliothèque personnelle : elle ne voyage pas/.test(i.message))).to.equal(true);
      // « copy into the show »: the same key put in the show, which wins
      await run("intention.put", { intention: { id: "douceur", label: "Douceur", colors: ["#aabbcc"] } });
      expect((await kb()).moods.douceur).to.include({ origin: "show", over: "personal" });
      const again = (await run("intention.put", { intention: { id: "douceur", label: "Douceur", colors: ["#000001"] }, scope: "personal" })) as { shadowedBy?: string };
      expect(again.shadowedBy).to.equal("show");
      // another show: the personal one is there, the show's is not; the cached files are not reloaded
      await run("show.create", { name: "Autre" });
      const other = await kb();
      expect(other.moods.douceur).to.include({ origin: "personal" });
      expect(other.moods.douceur!.colors).to.deep.equal(["#000001"]);
      expect(other.moods.joie).to.include({ origin: "generic" });
      await run("intention.put", { intention: { label: "Brume", colors: ["#cccccc"] } });
      await run("show.open", { id: "default" });
      const back = await kb();
      expect(back.moods.brume).to.equal(undefined);
      expect(back.moods.douceur).to.include({ origin: "show" });
      // a personal one deleted (no show copy here): gone for every show
      await run("show.open", { id: "autre" });
      expect(await run("intention.delete", { id: "douceur" })).to.deep.include({ action: "deleted" });
      expect(existsSync(join(dataRoot, "private", "intentions", "douceur.json"))).to.equal(false);
    });

    it("previews an unsaved intention: technique, explanation and contrast, nothing written", async () => {
      const p = (await run("intention.preview", { intention: { label: "Brume", colors: ["#ff0000", "#ff1000"], energy: "dynamique" } })) as { technique: { kind: string }; explanation: string[]; contrast: number };
      expect(p.technique.kind).to.equal("damier");
      expect(p.explanation[0]).to.contain("« Brume »");
      expect(p.contrast).to.be.below(25);
      expect(p.explanation.join(" ")).to.match(/contraste faible/);
      expect((await kb()).moods.brume).to.equal(undefined);
    });

    it("travels in a .lightshow: restored into another show as packed, counted in the preview; an archive without any replaces them", async () => {
      await run("show.rename", { name: "Principal" }); // a show with something to pack
      const without = ((await run("backup.create", { label: "sans" })) as { file: string }).file;
      await run("intention.put", { intention: { label: "Douceur", colors: ["#ffeedd"] } });
      await run("intention.put", { intention: { label: "Lever de rideau", colors: ["#112233", "#445566"], energy: "survolte", notes: "ouverture" } });
      await run("intention.delete", { id: "paix" }); // a mask travels too
      const withThem = ((await run("backup.create", { label: "avec" })) as { file: string }).file;
      const packed = await kb();
      // into an empty show
      await run("show.create", { name: "Vide" });
      expect((await kb()).moods.douceur).to.equal(undefined);
      const preview = (await run("backup.restore", { file: withThem, dryRun: true })) as { intentions: { added: number; changed: number; removed: number } };
      expect(preview.intentions).to.deep.equal({ added: 3, changed: 0, removed: 0 });
      await run("backup.restore", { file: withThem });
      const restored = await kb();
      expect(restored.moods.douceur).to.deep.equal(packed.moods.douceur);
      expect(restored.moods["lever-de-rideau"]).to.deep.equal(packed.moods["lever-de-rideau"]);
      expect(restored.hidden.map((h) => h.id)).to.deep.equal(["paix"]);
      // an older archive, without intentions/: they go, like every collection of the show (decision 2026-11-11)
      const older = (await run("backup.restore", { file: without, dryRun: true })) as { intentions: { removed: number } };
      expect(older.intentions).to.deep.include({ removed: 3 });
      await run("backup.restore", { file: without });
      const after = await kb();
      expect(after.moods.douceur).to.equal(undefined);
      expect(after.moods.paix).to.include({ origin: "generic" });
      expect(after.hidden).to.deep.equal([]);
      // a reset empties them too
      await run("backup.restore", { file: withThem });
      await run("show.reset");
      expect((await kb()).moods.douceur).to.equal(undefined);
    });
  });
});
