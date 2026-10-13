import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { deltaE, loadKnowledge, proposeLook } from "../../../src/plugins/light/knowledge/knowledge.js";

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
