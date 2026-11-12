import { expect } from "chai";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext, type CommandError } from "../../../src/plugins/light/commands/registry.js";
import { aliasesAfter } from "../../../src/plugins/light/commands/design-commands.js";
import { loadKnowledgeLayers } from "../../../src/plugins/light/knowledge/knowledge.js";
import { duplicateLabels, migratedRef, migrateMood, migrateTags, newIntentionId, refKey, resolveIntention, stackIntentions, type Intention } from "../../../src/plugins/light/knowledge/intentions.js";
import { intentionTwins, keepMachineTwins, sameIntention } from "../../../src/plugins/light/data/archive-intentions.js";
import { readArchive } from "../../../src/plugins/light/data/archive.js";

const intention = (id: string, label: string, colors: string[] = ["#123456"], more: Partial<Intention> = {}): Intention => ({ id, label, colors, energy: "pose", family: "", ...more });

describe("intentions by generated id (T15b)", () => {
  describe("ids, names and migration (pure)", () => {
    it("makes a new id from the time and four random characters, a valid key of its own", () => {
      expect(newIntentionId(0, () => 0)).to.equal("i-0-0000");
      expect(newIntentionId(36 ** 3, () => 0.5)).to.equal("i-1000-i000");
      expect(newIntentionId(Date.now())).to.match(/^i-[a-z0-9]+-[a-z0-9]{4}$/);
    });

    it("finds by id first, then by label before a former label, the visible before the masked, then show > personal > private > shipped", () => {
      const layers = loadKnowledgeLayers();
      const personal = [intention("i-perso", "Douceur"), intention("i-ancien", "Tendresse", ["#000000"], { aliases: ["Rideau"] })];
      const show = [intention("i-show", "douceur !"), intention("i-rideau", "Rideau")];
      const stack = stackIntentions(layers, personal, show);
      // an id, or a key typed with case and accents (what songs wrote before ids were generated)
      expect(resolveIntention(stack, "joie")).to.deep.include({ by: "id" });
      expect(resolveIntention(stack, "JOIE")!.entry.id).to.equal("joie");
      expect(resolveIntention(stack, "i-perso")!.entry.id).to.equal("i-perso");
      // one label, two intentions: the show's wins, both are candidates
      const r = resolveIntention(stack, "Douceur")!;
      expect(r.by).to.equal("label");
      expect(r.entry.id).to.equal("i-show");
      expect(r.candidates.map((c) => c.id)).to.deep.equal(["i-show", "i-perso"]);
      // a current label before a former one, whatever the layer
      expect(resolveIntention(stack, "rideau")!.candidates.map((c) => c.id)).to.deep.equal(["i-rideau", "i-ancien"]);
      expect(resolveIntention(stack, "Tendresse")!.entry.id).to.equal("i-ancien");
      // a free word stays a word
      expect(resolveIntention(stack, "inconnue")).to.equal(undefined);
      expect(refKey(stack)("inconnue !")).to.equal("inconnue");
      expect(refKey(stack)("Tendresse")).to.equal("i-ancien");
      // two of one label are said
      expect(duplicateLabels(stack).map((d) => [d.key, d.entries.map((e) => e.id)])).to.deep.equal([["douceur", ["i-show", "i-perso"]]]);
    });

    it("migrates only a name one visible intention answers to, leaves ids, ambiguous names, masked ones and free words", () => {
      const layers = loadKnowledgeLayers();
      const stack = stackIntentions(layers, [intention("i-a", "Aube"), intention("i-b", "Brume"), intention("i-c", "Brume")], [intention("paix", "Paix", ["#000000"], { hidden: true })]);
      expect(migratedRef(stack, "aube")).to.equal("i-a");
      expect(migratedRef(stack, "Brume")).to.equal(undefined); // ambiguous
      expect(migratedRef(stack, "joie")).to.equal(undefined); // already an id
      expect(migratedRef(stack, "i-a")).to.equal(undefined);
      expect(migratedRef(stack, "rien")).to.equal(undefined);
      expect(migrateMood(stack, ["Aube", "Brume", "joie", "rien"])).to.deep.equal({ mood: ["i-a", "Brume", "joie", "rien"], changed: true });
      expect(migrateMood(stack, ["i-a"]).changed).to.equal(false);
      expect(migrateTags(stack, ["dossier:aube", "ambiance:aube", "ambiance:brume"])).to.deep.equal({ tags: ["dossier:aube", "ambiance:i-a", "ambiance:brume"], changed: true });
    });

    it("keeps the label an intention leaves as a former one, once, without its own label or id", () => {
      expect(aliasesAfter("i-x", "Tendresse", { label: "Douceur" })).to.deep.equal(["Douceur"]);
      expect(aliasesAfter("i-x", "Douceur", { label: "Tendresse", aliases: ["Douceur", "Calme"] })).to.deep.equal(["Calme", "Tendresse"]);
      // a key-id answers to its old label anyway
      expect(aliasesAfter("joie", "Allégresse", { label: "Joie" })).to.equal(undefined);
      // given ones replace them (history, proposals)
      expect(aliasesAfter("i-x", "A", { label: "B", aliases: ["C"] }, [])).to.equal(undefined);
    });

    it("compares an archive's copy aware of former labels, finds the twins of another machine and keeps this machine's on demand", () => {
      const ours = JSON.stringify({ id: "i-a", label: "Douceur", colors: ["#ffeedd"], energy: "pose", family: "", aliases: ["Tendre", "Calme"] });
      expect(sameIntention(ours, JSON.stringify({ id: "i-a", label: "Douceur", colors: ["#ffeedd"], energy: "pose", family: "", aliases: ["calme"] }))).to.equal(true);
      expect(sameIntention(ours, JSON.stringify({ id: "i-a", label: "Douceur", colors: ["#ffeedd"], energy: "pose", family: "", aliases: ["Autre"] }))).to.equal(false);
      expect(sameIntention(ours, JSON.stringify({ id: "i-a", label: "Douceur", colors: ["#000000"], energy: "pose", family: "", aliases: ["Tendre"] }))).to.equal(false);
      const show = {
        "intentions/i-b.json": JSON.stringify({ id: "i-b", label: "douceur", colors: ["#ffeedd"] }),
        "intentions/joie.json": JSON.stringify({ id: "joie", label: "Joie", colors: ["#ffeedd"] }), // a touch-up: same id, no twin
        "intentions/i-m.json": JSON.stringify({ id: "i-m", label: "Brume", colors: ["#000000"], hidden: true }),
        // the show's own: never a twin, even of the same label (not in the manifest)
        "intentions/i-own.json": JSON.stringify({ id: "i-own", label: "Douceur", colors: ["#123456"] }),
        // a machine one the archive masks: not a twin to keep
        "intentions/i-y.json": JSON.stringify({ id: "i-y", label: "Aube", colors: ["#123456"], hidden: true }),
        "intentions/i-c.json": JSON.stringify({ id: "i-c", label: "Aube", colors: ["#654321"] }),
        "songs/s.json": JSON.stringify({ id: "s", title: "S", mood: ["i-b", "joie"] }),
        "looks/l.json": JSON.stringify({ id: "l", name: "L", tags: ["ambiance:i-b", "dossier:x"] }),
        "looks/m.json": JSON.stringify({ id: "m", name: "M", tags: ["ambiance:joie"] }),
      };
      const machine = [
        { id: "i-a", label: "Douceur", origin: "personal" as const, colors: ["#ffeedd"] },
        { id: "joie", label: "Joie", origin: "generic" as const, colors: ["#ffcc1a"] },
        { id: "i-z", label: "Brume", origin: "personal" as const, colors: ["#000000"] },
        { id: "i-y", label: "Aube", origin: "personal" as const, colors: ["#000000"] },
      ];
      const twins = intentionTwins(show, machine, ["i-b", "joie", "i-c"]);
      expect(twins).to.deep.equal([{ id: "i-b", label: "douceur", colors: ["#ffeedd"], machine: { id: "i-a", label: "Douceur", origin: "personal", colors: ["#ffeedd"] } }]);
      const kept = keepMachineTwins(show, twins, ["i-b"]);
      expect(kept["intentions/i-b.json"]).to.equal(undefined);
      expect((JSON.parse(kept["songs/s.json"]!) as { mood: string[] }).mood).to.deep.equal(["i-a", "joie"]);
      expect((JSON.parse(kept["looks/l.json"]!) as { tags: string[] }).tags).to.deep.equal(["ambiance:i-a", "dossier:x"]);
      expect(kept["looks/m.json"]).to.equal(show["looks/m.json"]); // untouched, as it was
      expect(keepMachineTwins(show, twins, [])).to.deep.equal(show);
    });
  });

  describe("commands", () => {
    let dataRoot: string;
    let plugin: LightPlugin;
    let clock = Date.parse("2026-11-12T10:00:00Z");
    const run = (name: string, args: unknown = {}, p: LightPlugin = plugin) => p.commands.invoke(name, args, systemContext());
    type Kb = { moods: Record<string, { label?: string; aliases?: string[]; origin: string; usedBy: string[] }>; hidden: { id: string }[] };
    const kb = async (p: LightPlugin = plugin) => (await run("knowledge.get", {}, p)) as Kb;
    const lint = async (p: LightPlugin = plugin) => ((await run("show.lint", {}, p)) as { issues: { level: string; where: string; message: string }[] }).issues;
    const make = (root: string) => {
      let cfg: Record<string, unknown> = { discovery: false, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      return new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async (c) => void (cfg = c as Record<string, unknown>) }, dataRoot: root, midiNative: null, now: () => (clock += 1000) });
    };
    const fresh = async () => {
      const root = join(mkdtempSync(join(tmpdir(), "light-ids-")), "data");
      mkdirSync(join(root, "fixtures"), { recursive: true });
      copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(root, "fixtures", "bar4.qxf"));
      const p = make(root);
      await run("venue.fixture.put", { fixture: { id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1 } }, p);
      await run("venue.canvas.put", { canvas: { id: "mur", name: "Mur", cells: 4, render: [0, 1, 2, 3].map((h) => ({ from: h, to: h, targets: [{ fixture: "bar", head: h }] })) } }, p);
      return { root, p };
    };
    const refusal = (p: Promise<unknown>) =>
      p.then(
        () => undefined,
        (e: Error) => e,
      );
    const created = async (label: string, scope: "show" | "personal" = "show", p: LightPlugin = plugin) => ((await run("intention.put", { intention: { label, colors: ["#ffeedd"] }, scope }, p)) as { intention: Intention }).intention.id;
    const look = (id: string, tags: string[]) => ({ look: { id, name: id.toUpperCase(), canvas: "mur", technique: { kind: "plat", color: "#ffffff" }, tags } });

    beforeEach(async () => {
      ({ root: dataRoot, p: plugin } = await fresh());
    });

    it("renames an intention without losing what names it, and a word typed before still finds it", async () => {
      const id = await created("Douceur");
      // a song and a look written by name: stored by id (one intention answers)
      const song = (await run("song.put", { song: { id: "s", title: "Chant", mood: ["douceur"], sections: [] } })) as { mood: string[] };
      expect(song.mood).to.deep.equal([id]);
      await run("look.put", look("l", ["ambiance:Douceur", "dossier:x"]));
      expect(((await run("look.get", { id: "l" })) as { tags: string[] }).tags).to.deep.equal([`ambiance:${id}`, "dossier:x"]);
      // renamed: the links hold, the label shows everywhere
      const renamed = (await run("intention.put", { intention: { id, label: "Tendresse", colors: ["#ffeedd"] } })) as { intention: Intention };
      expect(renamed.intention.aliases).to.deep.equal(["Douceur"]);
      expect((await kb()).moods[id]).to.deep.include({ label: "Tendresse", usedBy: ["chant « Chant »", "look « L »"] });
      expect(((await run("show.references", { kind: "intention", id })) as { uses: string[] }).uses).to.have.length(2);
      expect(((await run("song.list")) as { moodLabels: string[] }[])[0]!.moodLabels).to.deep.equal(["Tendresse"]);
      expect((await run("export.cuesheet")) as string).to.contain("· Tendresse").and.not.contain(id);
      expect((await run("export.board", { song: "s" })) as string).to.contain("Tendresse");
      // the former label still finds it (a song of another show, a word typed by hand)
      expect(((await run("look.from_intent", { name: "x", canvas: "mur", mood: ["douceur"] })) as { unknownMoods: string[]; look: { tags: string[] } }).look.tags).to.deep.equal([`ambiance:${id}`]);
      expect((await lint()).filter((i) => /inconnue/.test(i.message))).to.deep.equal([]);
      // the activity log says it by its label
      const lines = (await run("activity.list")) as { name: string; target?: string; targetLabel?: string }[];
      expect(lines.find((l) => l.name === "intention.put")).to.deep.include({ target: id, targetLabel: "Tendresse" });
      expect(lines.filter((l) => l.name === "intention.put").at(-1)).to.deep.include({ targetLabel: "Douceur" }); // the creation: no id given
      // deleted: its line keeps the label it bore
      await run("intention.delete", { id, force: true });
      const after = (await run("activity.list")) as { name: string; target?: string; targetLabel?: string }[];
      expect(after.find((l) => l.name === "intention.delete")).to.deep.include({ target: id, targetLabel: "Tendresse" });
    });

    it("lets two intentions share a label: a name goes to the most specific, the check says both and the ambiguous names", async () => {
      const mine = await created("Douceur", "personal");
      const show = await created("Douceur");
      expect(show).to.not.equal(mine);
      // ambiguous: left by name at the write, read as the show's
      const song = (await run("song.put", { song: { id: "s", title: "Chant", mood: ["Douceur"], sections: [] } })) as { mood: string[] };
      expect(song.mood).to.deep.equal(["Douceur"]);
      expect((await kb()).moods[show]!.usedBy).to.deep.equal(["chant « Chant »"]);
      expect((await kb()).moods[mine]!.usedBy).to.deep.equal([]);
      const issues = await lint();
      expect(issues.find((i) => /2 intentions portent ce libellé/.test(i.message))).to.deep.include({ level: "attention" });
      expect(issues.find((i) => i.where === "chant s" && /« Douceur » nomme 2 intentions/.test(i.message))!.message).to.match(new RegExp(`il va à « Douceur » \\(ce show, ${show}\\), la plus proche`));
      // picked by id, it is settled
      await run("song.put", { song: { id: "s", title: "Chant", mood: [mine], sections: [] } });
      expect((await lint()).some((i) => i.where === "chant s" && /nomme 2 intentions/.test(i.message))).to.equal(false);
      expect((await kb()).moods[mine]!.usedBy).to.deep.equal(["chant « Chant »"]);
    });

    it("migrates the words written by name once at load (a copy in the history), unambiguous ones only", async () => {
      const id = await created("Aube");
      await created("Brume");
      await created("Brume", "personal");
      // written by hand on disk, by name: read as they are by an older version
      const dir = join(dataRoot, "shows", "default");
      mkdirSync(join(dir, "songs"), { recursive: true });
      mkdirSync(join(dir, "looks"), { recursive: true });
      writeFileSync(join(dir, "songs", "s.json"), JSON.stringify({ id: "s", title: "Chant", mood: ["aube", "Brume", "joie", "mot libre"], sections: [] }));
      writeFileSync(join(dir, "looks", "l.json"), JSON.stringify({ id: "l", name: "L", canvas: "mur", technique: { kind: "plat", color: "#ffffff" }, tags: ["ambiance:Aube"] }));
      plugin = make(dataRoot);
      // not served (the offline CLI, a read): nothing written
      await run("song.list");
      expect((JSON.parse(readFileSync(join(dir, "songs", "s.json"), "utf8")) as { mood: string[] }).mood).to.deep.equal(["aube", "Brume", "joie", "mot libre"]);
      plugin.migrateIntentionRefs(); // what start() does
      expect((JSON.parse(readFileSync(join(dir, "songs", "s.json"), "utf8")) as { mood: string[] }).mood).to.deep.equal([id, "Brume", "joie", "mot libre"]);
      expect((JSON.parse(readFileSync(join(dir, "looks", "l.json"), "utf8")) as { tags: string[] }).tags).to.deep.equal([`ambiance:${id}`]);
      const versions = (await run("history.list", { collection: "looks", id: "l" })) as { stamp: string }[];
      expect(versions).to.have.length(1); // the look as it was, by name
      // loaded again: nothing more to write
      plugin = make(dataRoot);
      plugin.migrateIntentionRefs(); // what start() does
      expect(await run("history.list", { collection: "looks", id: "l" })).to.have.length(1);
      expect(readdirSync(join(dataRoot, "backups", "shows", "default")).length).to.be.greaterThan(0);
    });

    it("keeps the same ids through an archive, and reads an archive of names made before as it is", async () => {
      const id = await created("Lever de rideau");
      await run("song.put", { song: { id: "s", title: "Chant", mood: ["lever de rideau"], sections: [] } });
      const file = ((await run("backup.create", { label: "ids" })) as { file: string }).file;
      await run("show.create", { name: "Ailleurs" });
      await run("backup.restore", { file });
      const back = await kb();
      expect(back.moods[id]).to.include({ origin: "show", label: "Lever de rideau" });
      expect(((await run("song.list")) as { mood: string[] }[])[0]!.mood).to.deep.equal([id]);
      // an archive made before (key-ids, words by name): read as it is, nothing lost
      const old = join(mkdtempSync(join(tmpdir(), "light-old-")), "show");
      mkdirSync(join(old, "intentions"), { recursive: true });
      mkdirSync(join(old, "songs"), { recursive: true });
      writeFileSync(join(old, "intentions", "douceur.json"), JSON.stringify({ id: "douceur", label: "Douceur", colors: ["#ffeedd"], energy: "pose", family: "" }));
      writeFileSync(join(old, "songs", "t.json"), JSON.stringify({ id: "t", title: "Ancien", mood: ["Douceur"], sections: [] }));
      const { packArchive } = await import("../../../src/plugins/light/data/archive.js");
      writeFileSync(join(dataRoot, "backups", "ancien.lightshow"), packArchive({ show: { id: "ancien", dir: old } }));
      await run("backup.restore", { file: "ancien.lightshow" });
      expect((await kb()).moods.douceur).to.deep.include({ origin: "show", usedBy: ["chant « Ancien »"] });
      expect(((await run("song.list")) as { mood: string[] }[])[0]!.mood).to.deep.equal(["Douceur"]); // an id already (its key): left as written
    });

    it("says in the restore preview an intention made apart on another machine, and keeps one or the other", async () => {
      // machine A: a personal « Douceur » used by a song, packed
      const a = await created("Douceur", "personal");
      await run("song.put", { song: { id: "s", title: "Chant", mood: [a], sections: [] } });
      await run("look.put", look("l", [`ambiance:${a}`]));
      const file = ((await run("backup.create", { label: "machine-a" })) as { file: string }).file;
      expect(readArchive(new Uint8Array(readFileSync(join(dataRoot, "backups", file)))).manifest.intentions).to.deep.equal([a]);
      // machine B: its own « Douceur », another id
      const other = await fresh();
      const b = await created("Douceur", "personal", other.p);
      mkdirSync(join(other.root, "backups"), { recursive: true });
      copyFileSync(join(dataRoot, "backups", file), join(other.root, "backups", file));
      const preview = (await run("backup.restore", { file, dryRun: true }, other.p)) as { intentionTwins: { id: string; label: string; colors: string[]; machine: { id: string; origin: string } }[] };
      expect(preview.intentionTwins).to.deep.equal([{ id: a, label: "Douceur", colors: ["#ffeedd"], machine: { id: b, label: "Douceur", origin: "personal", colors: ["#ffeedd"] } }]);
      // restored as it is: a second « Douceur » (the show's), said by the check
      await run("backup.restore", { file }, other.p);
      expect((await kb(other.p)).moods[a]).to.include({ origin: "show" });
      expect((await lint(other.p)).some((i) => /2 intentions portent ce libellé/.test(i.message))).to.equal(true);
      // restored keeping this machine's: the song and the look name B's, the archive's copy is left out
      await run("backup.restore", { file, keepMachine: [a] }, other.p);
      expect((await kb(other.p)).moods[a]).to.equal(undefined);
      expect(((await run("song.list", {}, other.p)) as { mood: string[] }[])[0]!.mood).to.deep.equal([b]);
      expect(((await run("look.get", { id: "l" }, other.p)) as { tags: string[] }).tags).to.deep.equal([`ambiance:${b}`]);
      expect(existsSync(join(other.root, "shows", "default", "intentions", `${a}.json`))).to.equal(false);
      expect((await lint(other.p)).some((i) => /portent ce libellé/.test(i.message))).to.equal(false);
    });

    it("says that a keyword renamed in the private file breaks what named it", async () => {
      mkdirSync(join(dataRoot, "private"), { recursive: true });
      writeFileSync(join(dataRoot, "private", "knowledge.json"), JSON.stringify({ moods: { brume: { label: "Brume", colors: ["#aabbcc"] } } }));
      plugin = make(dataRoot);
      plugin.migrateIntentionRefs(); // what start() does
      await run("song.put", { song: { id: "s", title: "Chant", mood: ["brume"], sections: [] } });
      expect((await lint()).some((i) => /inconnue/.test(i.message))).to.equal(false);
      // the keyword and its label renamed by hand: its id is the keyword's key, the song no longer finds it
      writeFileSync(join(dataRoot, "private", "knowledge.json"), JSON.stringify({ moods: { brouillard: { label: "Brouillard", colors: ["#aabbcc"] } } }));
      plugin = make(dataRoot);
      plugin.migrateIntentionRefs(); // what start() does
      expect((await lint()).find((i) => i.where === "chant s" && /inconnue « brume »/.test(i.message))!.message).to.match(/mot-clé renommé dans le fichier privé/);
      // the keyword renamed, its label kept: the song finds it by name, and names it by its new id from the load on
      writeFileSync(join(dataRoot, "private", "knowledge.json"), JSON.stringify({ moods: { brouillard: { label: "Brume", colors: ["#aabbcc"] } } }));
      plugin = make(dataRoot);
      plugin.migrateIntentionRefs(); // what start() does
      expect((await lint()).some((i) => /inconnue/.test(i.message))).to.equal(false);
      expect(((await run("song.list")) as { mood: string[] }[])[0]!.mood).to.deep.equal(["brouillard"]);
    });

    it("gives a proposed new intention its id when proposed: applied, taken back and applied again, it is that one", async () => {
      const p = (await run("show.propose", { changes: [{ command: "intention.put", args: { intention: { label: "Aube", colors: ["#ffaa00"] } } }] })) as { id: string; preview: { id: string; new: boolean }[] };
      const id = p.preview[0]!.id;
      expect(id).to.match(/^i-/);
      expect(p.preview[0]!.new).to.equal(true);
      await run("show.apply", { id: p.id });
      expect((await kb()).moods[id]).to.include({ label: "Aube" });
      await run("show.revert", { id: p.id });
      expect((await kb()).moods[id]).to.equal(undefined);
      await run("show.apply", { id: p.id });
      expect((await kb()).moods[id]).to.include({ label: "Aube" });
      // an empty label is still refused
      expect(((await run("show.propose", { changes: [{ command: "intention.put", args: { intention: { label: "?!", colors: ["#ffaa00"] } } }] })) as { valid: boolean }).valid).to.equal(false);
    });

    it("starts with an unreadable private file: the shipped base serves, the check says it, nothing migrates", async () => {
      const id = await created("Aube");
      mkdirSync(join(dataRoot, "private"), { recursive: true });
      writeFileSync(join(dataRoot, "private", "knowledge.json"), "{ pas du json");
      const dir = join(dataRoot, "shows", "default");
      mkdirSync(join(dir, "songs"), { recursive: true });
      writeFileSync(join(dir, "songs", "s.json"), JSON.stringify({ id: "s", title: "Chant", mood: ["aube"], sections: [] }));
      plugin = make(dataRoot);
      plugin.migrateIntentionRefs();
      expect((JSON.parse(readFileSync(join(dir, "songs", "s.json"), "utf8")) as { mood: string[] }).mood).to.deep.equal(["aube"]);
      expect((await kb()).moods.joie).to.include({ origin: "generic" });
      expect((await lint()).find((i) => /fichier privé des intentions : private\/knowledge\.json/.test(i.message))).to.deep.include({ level: "attention" });
      // a write does not migrate either, and song.list still answers
      expect(((await run("song.put", { song: { id: "t", title: "Autre", mood: ["Aube"], sections: [] } })) as { mood: string[] }).mood).to.deep.equal(["Aube"]);
      expect(((await run("song.list")) as { moodLabels: string[] }[]).map((x) => x.moodLabels)).to.deep.include(["Aube"]);
      expect(id).to.match(/^i-/);
    });

    it("lets a show intention with a shipped one's label take its name, the key included (decision of 2026-11-12)", async () => {
      await run("song.put", { song: { id: "s", title: "Chant", mood: ["joie"], sections: [] } });
      const id = await created("Joie");
      // the song wrote « joie », the shipped one's key: the show's « Joie » is nearer, it wins, and it is said
      const k = await kb();
      expect(k.moods[id]!.usedBy).to.deep.equal(["chant « Chant »"]);
      expect(k.moods.joie!.usedBy).to.deep.equal([]);
      expect((await lint()).find((i) => i.where === "chant s")!.message).to.match(/« joie » nomme 2 intentions/);
      // not migrated (ambiguous); a write warns with the candidates
      const put = (await run("song.put", { song: { id: "s", title: "Chant", mood: ["joie"], sections: [] } })) as { mood: string[]; ambiguous: { chosen: { id: string }; candidates: { id: string }[] }[] };
      expect(put.mood).to.deep.equal(["joie"]);
      expect(put.ambiguous[0]!.chosen.id).to.equal(id);
      expect(put.ambiguous[0]!.candidates.map((c) => c.id)).to.deep.equal([id, "joie"]);
      const lk = (await run("look.put", look("l", ["ambiance:Joie"]))) as { ambiguous?: unknown[] };
      expect(lk.ambiguous).to.have.length(1);
      // the shipped one's row is still deleted (masked) by its id, and a name several answer to is refused
      expect(((await refusal(run("intention.delete", { id: "Joie" }))) as CommandError).detail).to.deep.include({ candidates: [{ id, label: "Joie", origin: "show" }, { id: "joie", label: "Joie", origin: "generic" }] });
      expect(await run("intention.delete", { id: "joie", force: true })).to.include({ action: "hidden" });
      // a generated id typed as such always names its own
      expect(((await run("look.from_intent", { name: "x", canvas: "mur", mood: [id] })) as { look: { tags: string[] } }).look.tags).to.deep.equal([`ambiance:${id}`]);
    });

    it("never lets a masked id take a word a visible intention answers to", async () => {
      await run("intention.delete", { id: "paix" }); // masked
      const id = await created("Paix");
      await run("song.put", { song: { id: "s", title: "Chant", mood: [id], sections: [] } });
      const lk = (await run("look.from_intent", { name: "x", canvas: "mur", mood: ["paix"] })) as { unknownMoods: string[]; look: { tags: string[] } };
      expect(lk.unknownMoods).to.deep.equal([]);
      expect(lk.look.tags).to.deep.equal([`ambiance:${id}`]); // the visible one only answers: migrated
    });

    it("takes a rename back exactly: apply then revert, or a version put back, give the file as it was", async () => {
      const id = await created("Aube");
      const file = join(dataRoot, "shows", "default", "intentions", `${id}.json`);
      const before = readFileSync(file, "utf8");
      const p = (await run("show.propose", { changes: [{ command: "intention.put", args: { intention: { id, label: "Aurore", colors: ["#ffeedd"] } } }] })) as { id: string };
      await run("show.apply", { id: p.id });
      expect((JSON.parse(readFileSync(file, "utf8")) as Intention).aliases).to.deep.equal(["Aube"]);
      await run("show.revert", { id: p.id });
      expect(readFileSync(file, "utf8")).to.equal(before);
      await run("intention.put", { intention: { id, label: "Aurore", colors: ["#ffeedd"] } });
      const versions = (await run("history.list", { collection: "intentions", id })) as { stamp: string }[];
      await run("history.restore", { collection: "intentions", id, stamp: versions.at(-1)!.stamp });
      expect(readFileSync(file, "utf8")).to.equal(before);
    });

    it("never takes the show's own intention of an archive for one of another machine", async () => {
      await created("Douceur", "personal");
      const own = await created("Douceur");
      await run("song.put", { song: { id: "s", title: "Chant", mood: [own], sections: [] } });
      const file = ((await run("backup.create", { label: "propre" })) as { file: string }).file;
      const preview = (await run("backup.restore", { file, dryRun: true })) as { intentionTwins: unknown[] };
      expect(preview.intentionTwins).to.deep.equal([]);
      await run("backup.restore", { file, keepMachine: [own] }); // even asked: not a twin, kept
      expect(((await run("song.list")) as { mood: string[] }[])[0]!.mood).to.deep.equal([own]);
      expect((await kb()).moods[own]).to.include({ origin: "show" });
    });
  });
});
