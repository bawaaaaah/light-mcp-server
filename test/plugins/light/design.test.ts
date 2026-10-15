import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { deltaE, loadKnowledge, proposeLook } from "../../../src/plugins/light/knowledge/knowledge.js";
import { checkCadence } from "../../../src/plugins/light/commands/selftest-commands.js";

describe("colour knowledge and design", () => {
  const kb = loadKnowledge();

  it("measures perceptual contrast", () => {
    expect(deltaE("#ff0000", "#ff0000")).to.equal(0);
    expect(deltaE("#ff0000", "#0000ff")).to.be.above(100);
    expect(deltaE("#ff960f", "#ffa010")).to.be.below(10);
  });

  it("turns an intention into a technique, cadence and attack by energy", () => {
    const calm = proposeLook(kb, { mood: ["intimité"] });
    expect(calm.energy).to.equal("pose");
    expect(calm.technique.kind).to.equal("respiration");
    expect(calm.timing).to.include({ attack: 1 });
    const joy = proposeLook(kb, { mood: ["joie"] });
    expect(joy.technique.kind).to.equal("palette");
    expect(joy.timing.attack).to.be.below(0.2);
    const party = proposeLook(kb, { mood: ["fête"] });
    expect(party.timing.order).to.equal("random");
    expect(proposeLook(kb, { mood: ["inconnu"] }).unknownMoods).to.deep.equal(["inconnu"]);
  });

  it("merges a private knowledge base keyword by keyword", () => {
    const dir = mkdtempSync(join(tmpdir(), "light-kb-"));
    writeFileSync(join(dir, "k.json"), JSON.stringify({ moods: { Intimité: { colors: ["#123456"], energy: "pose" } }, rules: ["règle perso"] }));
    const merged = loadKnowledge(join(dir, "k.json"));
    expect(merged.moods.intimite!.colors).to.deep.equal(["#123456"]);
    expect(merged.moods.joie).to.not.equal(undefined);
    expect(merged.rules).to.include("règle perso");
  });

  describe("cadence check", () => {
    it("accepts whole numbers of steps within the tolerance", () => {
      expect(checkCadence([0, 500, 1000, 2000], 500)).to.include({ ok: true, measuredMs: 500 }); // 1000 = two identical steps
      expect(checkCadence([0, 510, 990, 1505], 500).ok).to.equal(true);
    });

    it("rejects a wrong cadence and too few changes", () => {
      const slow = checkCadence([0, 600, 1200, 1800], 500);
      expect(slow.ok).to.equal(false);
      expect(slow.detail).to.match(/cadence 600 ms au lieu de 500/);
      expect(checkCadence([0, 500], 500)).to.include({ ok: false });
    });

    it("tolerates one isolated hiccup of a busy machine, not two", () => {
      const one = checkCadence([0, 250, 500, 814, 1000], 250); // one interval 64 ms late, as seen on a CI runner
      expect(one.ok).to.equal(true);
      expect(one.detail).to.match(/un à-coup isolé de 64 ms, toléré/);
      const two = checkCadence([0, 314, 500, 814, 1000, 1250], 250); // two late frames
      expect(two.ok).to.equal(false);
      expect(two.detail).to.match(/2 à-coups/);
    });
  });

  describe("design commands", () => {
    let plugin: LightPlugin;
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    before(async () => {
      const dataRoot = join(mkdtempSync(join(tmpdir(), "light-design-")), "data");
      mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
      copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
      const cfg = { discovery: false, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
      await run("venue.fixture.put", { fixture: { id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1 } });
      await run("venue.canvas.put", { canvas: { id: "mur", name: "Mur", cells: 4, render: [0, 1, 2, 3].map((h) => ({ from: h, to: h, targets: [{ fixture: "bar", head: h }] })) } });
    });

    it("describes every technique for the editors and previews an unsaved look", async () => {
      const kinds = (await run("look.techniques")) as { kind: string; schema: { properties: Record<string, unknown> } }[];
      expect(kinds.map((k) => k.kind)).to.include.members(["plat", "damier", "onde", "pas", "aucune"]);
      expect(kinds.find((k) => k.kind === "creux")!.schema.properties).to.have.keys("kind", "colors", "block", "width", "floor");
      const preview = (await run("look.preview", { look: { id: "draft", name: "Brouillon", canvas: "mur", technique: { kind: "damier", colors: ["#ff0000", "#0000ff+w255"], block: 2 } } })) as { cells: number; steps: (string | null)[][] };
      expect(preview.cells).to.equal(4);
      expect(preview.steps).to.deep.equal([
        ["#ff0000", "#ff0000", "#ffffff", "#ffffff"], // blue + white shows as white
        ["#ffffff", "#ffffff", "#ff0000", "#ff0000"],
      ]);
      expect(plugin.runtime.looks.get("draft")).to.equal(undefined); // nothing saved
    });

    it("measures a look's cadence on the real output (self-test)", async () => {
      await run("look.put", { look: { id: "fast", name: "Rapide", canvas: "mur", technique: { kind: "damier", colors: ["#ff0000", "#0000ff"], block: 1 }, timing: { every: { seconds: 0.1 } } } });
      await run("look.put", { look: { id: "fade", name: "Fondu court", canvas: "mur", technique: { kind: "damier", colors: ["#ff0000", "#0000ff"], block: 1 }, timing: { every: { seconds: 0.2 }, attack: 0.3 } } });
      await run("look.put", { look: { id: "soft", name: "Doux", canvas: "mur", technique: { kind: "damier", colors: ["#ff0000", "#0000ff"] }, timing: { every: { seconds: 0.1 }, attack: 1 } } });
      const r = (await run("selftest.run", { cadence: true, looks: ["fast", "fade", "soft"] })) as { cadence: { looks: { look: string; ok: boolean; measuredMs?: number; detail?: string }[] } };
      const [fast, fade, soft] = r.cadence.looks;
      expect(fast).to.include({ look: "fast", ok: true });
      expect(fast!.measuredMs).to.be.closeTo(100, 15);
      expect(fade).to.include({ look: "fade", ok: true }); // a short fade counts once per step
      expect(fade!.measuredMs).to.be.closeTo(200, 15);
      expect(soft!.detail).to.match(/fondu/); // a full-step fade has no sharp change: skipped, said so
      expect(plugin.runtime.isActive("fast")).to.equal(false); // state restored
    });

    it("lights a new venue at once with automatic presets, without ever overwriting", async () => {
      const dry = (await run("show.autopresets", { canvas: "mur" })) as { applied: boolean; created: string[] };
      expect(dry.applied).to.equal(false);
      expect(plugin.runtime.looks.get("auto-joie")).to.equal(undefined);
      const r = (await run("show.autopresets", { canvas: "mur", apply: true })) as { created: string[]; safeLook?: string; looks: { technique: string }[] };
      expect(r.created).to.have.length(13); // 6 palettes, 6 looks, 1 group
      expect(r.looks.map((l) => l.technique)).to.deep.equal(["plat", "respiration", "onde", "palette", "damier", "creux"]);
      expect(r.safeLook).to.equal("auto-blanc-chaud");
      expect(plugin.runtime.settings.safeLook).to.equal("auto-blanc-chaud");
      for (const l of plugin.runtime.looks.list().filter((x) => x.id.startsWith("auto-"))) expect(plugin.runtime.stepsOf(l).flat().some((c) => c !== null), l.id).to.equal(true);
      // by reference: the palette drives the look
      expect(plugin.runtime.looks.get("auto-joie")!.palette).to.equal("auto-joie");
      await run("look.put", { look: { ...plugin.runtime.looks.get("auto-fete")!, name: "Fête retouchée" } });
      const again = (await run("show.autopresets", { canvas: "mur", apply: true })) as { created: string[]; kept: string[] };
      expect(again.created).to.deep.equal([]);
      expect(plugin.runtime.looks.get("auto-fete")!.name).to.equal("Fête retouchée"); // a hand edit survives
      expect(plugin.runtime.groups.get("auto")!.exclusive).to.equal(true);
      await run("show.settings.set", { safeLook: undefined });
    });

    it("shows the effective rule of each channel and where it comes from", async () => {
      await run("rule.put", { where: "venue", rule: { id: "type-dim", name: "Barres : dimmer max 50 %", level: "type", scope: { model: "Bar 4" }, target: { attribute: "intensity" }, max: 128 } });
      await run("rule.put", { where: "show", rule: { id: "show-dim", name: "Show : dimmer max 80 %", level: "show", target: { attribute: "intensity" }, max: 204 } });
      const eff = (await run("rule.effective", { fixture: "bar" })) as { channel: string; dmx: number; max?: number; from: Record<string, string> }[];
      const dimmer = eff.find((c) => c.dmx === 1)!;
      expect(dimmer).to.deep.include({ max: 204, from: { max: "Show : dimmer max 80 %" } }); // the show relaxed the type's limit
      await run("rule.delete", { where: "venue", id: "type-dim" });
      await run("rule.delete", { where: "show", id: "show-dim" });
    });

    it("proposes then saves a look from an intention", async () => {
      const dry = (await run("look.from_intent", { name: "Adoration", canvas: "mur", mood: ["adoration"] })) as { saved: boolean };
      expect(dry.saved).to.equal(false);
      expect(plugin.runtime.looks.get("adoration")).to.equal(undefined);
      await run("look.from_intent", { name: "Adoration", canvas: "mur", mood: ["adoration"], save: true });
      expect(plugin.runtime.looks.get("adoration")!.technique.kind).to.equal("respiration");
    });

    it("fills a song grid with contrasted sections and an exclusive group", async () => {
      await run("song.put", { song: { id: "s", title: "Chant", mood: ["louange", "joie"], sections: [{ id: "intro", name: "Intro" }, { id: "refrain", name: "Refrain" }, { id: "final", name: "Final" }] } });
      const r = (await run("song.grid_fill", { song: "s", canvas: "mur", save: true })) as { proposals: { section: string; look: { timing: { attack: number; order: string } } }[] };
      expect(r.proposals.map((p) => p.section)).to.deep.equal(["intro", "refrain", "final"]);
      expect(r.proposals[0]!.look.timing.attack).to.equal(1); // intro: posé, respire
      expect(r.proposals[2]!.look.timing.order).to.equal("random"); // final: survolté
      expect(plugin.runtime.groups.get("sections-s")!.exclusive).to.equal(true);
      const lint = (await run("show.lint")) as { ok: boolean; issues: unknown[] };
      expect(lint.ok).to.equal(true);
    });

    it("lint reports errors and warnings", async () => {
      await run("look.put", { look: { id: "pale", name: "Pâle", canvas: "mur", technique: { kind: "damier", colors: ["#ff960f", "#ffa010"] } } });
      await run("midi.mapping.put", { mapping: { id: "m1", input: { type: "note", channel: 1, number: 36 }, on: { command: "look.go", args: { id: "fantome" } } } });
      const lint = (await run("show.lint")) as { ok: boolean; issues: { where: string; message: string }[] };
      expect(lint.ok).to.equal(false);
      expect(lint.issues.map((i) => i.message).join(" | ")).to.match(/contraste faible/).and.match(/look inconnu fantome/);
    });

    it("lint finds broken references to groups, faders, programs and fixtures", async () => {
      const refused = await run("fader.put", { fader: { id: "f0", name: "F0", channels: [{ fixture: "bar", offset: 500 }] } }).then(() => "ok", (e: Error) => e.message);
      expect(refused).to.match(/canal 501 demandé/);
      await run("venue.fixture.put", { fixture: { id: "partie", name: "Partie", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 2, address: 1 } });
      await run("fader.put", { fader: { id: "f1", name: "F1", channels: [{ fixture: "partie", offset: 14 }] } });
      await run("venue.fixture.delete", { id: "partie" }); // removed from the patch afterwards
      await run("midi.mapping.put", { mapping: { id: "m2", input: { type: "cc", channel: 1, number: 7 }, on: { command: "group.level", args: { id: "disparu" } }, levelArg: "level" } });
      const text = ((await run("show.lint")) as { issues: { where: string; message: string }[] }).issues.map((i) => `${i.where}: ${i.message}`).join(" | ");
      expect(text).to.match(/fader f1: projecteur inconnu partie/).and.match(/mapping m2: groupe inconnu disparu/);
      await run("fader.delete", { id: "f1" });
      await run("midi.mapping.delete", { id: "m2" });
    });

    it("writes and finds notes on any object", async () => {
      await run("notes.set", { collection: "fixtures", id: "bar", notes: "attention : câble DMX sous la marche" });
      await run("notes.set", { collection: "looks", id: "adoration", notes: "pour les temps calmes" });
      const all = (await run("notes.search", {})) as { collection: string; id: string; notes: string }[];
      expect(all.map((n) => `${n.collection}/${n.id}`)).to.include.members(["fixtures/bar", "looks/adoration"]);
      const found = (await run("notes.search", { query: "câble" })) as { id: string; notes: string }[];
      expect(found.map((n) => n.id)).to.deep.equal(["bar"]);
      expect(found[0]!.notes).to.match(/\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/); // timestamped
      expect(plugin.venue.fixtures.get("bar")!.manufacturer).to.equal("Test"); // the rest of the object is kept
    });

    it("builds a canvas automatically from fixture heads", async () => {
      await run("venue.fixture.put", { fixture: { id: "bar2", name: "Barre 2", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 16 } });
      const c = (await run("venue.canvas.auto", { id: "mur2", name: "Mur 2", fixtures: ["bar", "bar2"], topology: "line-mirror" })) as { cells: number; render: { targets: { fixture: string; head: number }[] }[] };
      expect(c.cells).to.equal(8);
      expect(c.render[4]!.targets[0]).to.deep.equal({ fixture: "bar2", head: 0 });
    });

    it("models the stage and caps fixtures aiming at a protected zone", async () => {
      await run("stage.zone.put", { zone: { id: "public", name: "Public", type: "audience", polygon: [[-6, -10], [6, -10], [6, 0], [-6, 0]], protected: true } });
      await run("stage.zone.put", { zone: { id: "scene", name: "Scène", type: "stage", polygon: [[-4, 0], [4, 0], [4, 5], [-4, 5]], floorHeight: 0.6 } });
      await run("venue.fixture.put", { fixture: { id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1, role: "wash-public", position: { x: 0, y: 1, z: 3 }, target: "public" } });
      const q = (await run("stage.query", { aimingAt: "public" })) as { id: string; zone: string; why: string }[];
      expect(q).to.deep.equal([{ id: "bar", name: "Barre", role: "wash-public", zone: "scene", position: { x: 0, y: 1, z: 3 }, why: "vise public" }]);
      const text = (await run("stage.describe")) as string;
      expect(text).to.contain("Zone « Public » (audience, PROTÉGÉE)").and.contain("éclairée par Barre (wash-public)");
      await run("rule.put", { where: "venue", rule: { id: "public-max", level: "venue", scope: { zone: "public" }, target: { attribute: "intensity" }, max: 150 } });
      const buffers = plugin.engine.render();
      expect(buffers[0]![0]).to.equal(150); // dimmer capped although the master is full
    });
  });
});
