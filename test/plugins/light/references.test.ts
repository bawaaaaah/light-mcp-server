import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { usesOf, type ShowParts } from "../../../src/plugins/light/show/references.js";

describe("references: what uses a look, a group, a fader or a canvas", () => {
  const empty: ShowParts = { groups: [], faders: [], mappings: [], dashboards: [], snapshots: [], looks: [], songs: [] };

  it("finds every place, once per place", () => {
    const show: ShowParts = {
      looks: [
        { id: "warm", name: "Chaud", canvas: "mur" },
        { id: "cold", name: "Froid", canvas: "mur" },
      ],
      groups: [
        { id: "master", name: "Master", members: { looks: [], groups: ["front"] } },
        { id: "scenes", name: "Scènes", members: { looks: ["warm"], groups: [] } },
      ],
      faders: [{ id: "uv", name: "UV", dca: "front" }],
      mappings: [
        { id: "cc-1", label: "Fader 1", on: { command: "group.level", args: { id: "front" } } },
        { id: "n-36", on: { command: "look.go", args: { id: "warm" } } },
      ],
      dashboards: [{ id: "main", name: "Principal", widgets: [{ kind: "group-fader", target: "front" }, { kind: "group-fader", target: "front" }, { kind: "look", target: "warm" }] }],
      snapshots: [{ id: "s", name: "Accueil", looks: ["warm"], groups: { front: {} }, faders: { uv: 0.5 } }],
      songs: [{ id: "a", title: "Chant A", sections: [{ id: "intro", name: "Intro", look: "warm" }], cues: [{ command: "group.flash", args: { id: "front" } }] }],
      safeLook: "warm",
    };
    expect(usesOf("group", "front", show)).to.deep.equal([
      "groupe « Master » (sous-groupe)",
      "fader de canaux « UV » (DCA)",
      "mapping MIDI « Fader 1 »",
      "dashboard « Principal »",
      "instantané « Accueil »",
      "chant « Chant A » (1 action de la piste)",
    ]);
    expect(usesOf("look", "warm", show)).to.deep.equal(["groupe « Scènes »", "mapping MIDI « n-36 »", "dashboard « Principal »", "instantané « Accueil »", "chant « Chant A » (Intro)", "secours du Panic"]);
    expect(usesOf("fader", "uv", show)).to.deep.equal(["instantané « Accueil »"]);
    expect(usesOf("canvas", "mur", show)).to.deep.equal(["look « Chaud »", "look « Froid »", "instantané « Accueil »", "secours du Panic (look de secours)"]);
    expect(usesOf("canvas", "parvis", show)).to.deep.equal([]);
    expect(usesOf("group", "nobody", show)).to.deep.equal([]);
    expect(usesOf("look", "warm", empty)).to.deep.equal([]);
  });

  it("finds where a patched fixture is used: groups, channel faders, raw channels of looks, canvases, mappings and song cues", () => {
    const target = { fixture: "bar-0" };
    const show: ShowParts = {
      ...empty,
      groups: [{ id: "avant", name: "Avant", members: { looks: [], groups: [], fixtures: ["bar-0", "bar-1"] } }, { id: "autre", name: "Autre", members: { looks: [], groups: [], fixtures: ["bar-1"] } }],
      faders: [{ id: "uv", name: "UV", channels: [target] }, { id: "fog", name: "Fumée", channels: [{ fixture: "bar-1" }] }],
      looks: [{ id: "smoke", name: "Fumée seule", canvas: "mur", channels: { targets: [target] } }, { id: "plain", name: "Plat", canvas: "mur" }],
      canvases: [{ id: "mur", name: "Mur", render: [{ targets: [target] }] }, { id: "autre", name: "Autre mur", render: [{ targets: [{ fixture: "bar-1" }] }] }],
      mappings: [{ id: "m1", label: "Couleur", on: { command: "venue.fixture.mark", args: { id: "bar-0" } } }, { id: "m2", on: { command: "look.go", args: { id: "bar-0" } } }],
      songs: [{ id: "a", title: "Chant A", sections: [], cues: [{ command: "venue.fixture.mark", args: { id: "bar-0" } }] }],
      // a snapshot holds looks, groups and faders, never a fixture
      snapshots: [{ id: "s", name: "Accueil", looks: [], groups: {}, faders: { uv: 1 } }],
    };
    expect(usesOf("fixture", "bar-0", show)).to.deep.equal([
      "groupe « Avant »",
      "fader de canaux « UV »",
      "look « Fumée seule » (canaux bruts)",
      "canevas « Mur »",
      "mapping MIDI « Couleur »",
      "chant « Chant A » (1 action de la piste)",
    ]);
    expect(usesOf("fixture", "bar-9", show)).to.deep.equal([]);
  });

  it("finds a fixture named by any command's fixture or fixtures, and the rules scoped to it", () => {
    const show: ShowParts = {
      ...empty,
      mappings: [
        { id: "m1", label: "Viser", on: { command: "position.aim", args: { fixture: "bar-0", zone: "scene" } } },
        { id: "m2", label: "Installer", on: { command: "venue.fixture.presence", args: { fixtures: ["bar-1", "bar-0"], present: true } } },
        { id: "m3", label: "Autre", on: { command: "position.release", args: { fixture: "bar-1" } } },
      ],
      songs: [{ id: "a", title: "Chant A", sections: [], cues: [{ command: "position.set", args: { fixture: "bar-0", pan: 0.5 } }, { command: "fader.fromChannel", args: { fixture: "bar-0", offset: 0 } }] }],
      rules: [{ id: "r1", name: "Pas de strobe", scope: { fixture: "bar-0" } }, { id: "r2", name: "Tous", scope: {} }],
      venueRules: [{ id: "r3", name: "", scope: { fixture: "bar-0" } }],
    };
    expect(usesOf("fixture", "bar-0", show)).to.deep.equal([
      "règle du show « Pas de strobe »",
      "règle du lieu « r3 »",
      "mapping MIDI « Viser »",
      "mapping MIDI « Installer »",
      "chant « Chant A » (2 actions de la piste)",
    ]);
    // another kind is never named by `fixture`: a look's mapping with a fixture argument is not the look's
    expect(usesOf("look", "bar-0", show)).to.deep.equal([]);
  });

  describe("in the show", () => {
    let plugin: LightPlugin;
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());

    beforeEach(async () => {
      const dataRoot = join(mkdtempSync(join(tmpdir(), "light-refs-")), "data");
      mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
      copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
      const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
      await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    });

    it("refuses to delete a DCA a channel fader depends on, unless forced", async () => {
      await run("group.put", { group: { id: "master-b", name: "Master", members: { fixtures: [], looks: [], groups: [] }, master: { level: 1, mute: false } } });
      await run("fader.put", { fader: { id: "keys", name: "Claviers", channels: [{ fixture: "bar-0", offset: 0 }], level: 0, dca: "master-b" } });
      expect(await run("show.references", { kind: "group", id: "master-b" })).to.deep.equal({ uses: ["fader de canaux « Claviers » (DCA)"] });
      let refused = "";
      await run("group.delete", { id: "master-b" }).catch((e: Error) => (refused = e.message));
      expect(refused).to.contain("fader de canaux « Claviers »");
      expect(plugin.runtime.groups.get("master-b")).to.not.equal(undefined);
      await run("group.delete", { id: "master-b", force: true });
      expect(plugin.runtime.groups.get("master-b")).to.equal(undefined);
    });

    it("refuses to delete a canvas a look plays on, names the look, deletes it once unused or forced", async () => {
      const canvas = { id: "test-mur", name: "Mur test", cells: 2, render: [{ from: 0, to: 1, targets: [{ fixture: "bar-0", head: -1 }] }] };
      await run("venue.canvas.put", { canvas });
      await run("look.put", { look: { id: "test-look", name: "Look du mur", canvas: "test-mur", technique: { kind: "plat", color: "#ff0000" } } });
      expect(await run("show.references", { kind: "canvas", id: "test-mur" })).to.deep.equal({ uses: ["look « Look du mur »"] });
      let refused = "";
      await run("venue.canvas.delete", { id: "test-mur" }).catch((e: Error) => (refused = e.message));
      expect(refused).to.contain("look « Look du mur »");
      expect(plugin.runtime.venue.canvases.get("test-mur")).to.not.equal(undefined);
      await run("look.delete", { id: "test-look" });
      expect(await run("venue.canvas.delete", { id: "test-mur" })).to.deep.equal({ deleted: true });
      expect(plugin.runtime.venue.canvases.get("test-mur")).to.equal(undefined);
      // forced: deleted although a look still names it
      await run("venue.canvas.put", { canvas });
      await run("look.put", { look: { id: "test-look", name: "Look du mur", canvas: "test-mur", technique: { kind: "plat", color: "#ff0000" } } });
      expect(await run("venue.canvas.delete", { id: "test-mur", force: true })).to.deep.equal({ deleted: true });
      expect(plugin.runtime.venue.canvases.get("test-mur")).to.equal(undefined);
      // an unknown id is an error
      refused = "";
      await run("venue.canvas.delete", { id: "nulle-part" }).catch((e: Error) => (refused = e.message));
      expect(refused).to.equal("canevas inconnu : nulle-part");
    });

    it("refuses to unpatch a fixture the show uses, names the uses, unpatches it once forced or unused", async () => {
      await run("group.put", { group: { id: "avant", name: "Avant", members: { fixtures: ["bar-0"], looks: [], groups: [] }, master: { level: 1, mute: false } } });
      await run("fader.put", { fader: { id: "uv", name: "UV", channels: [{ fixture: "bar-0", offset: 0 }], level: 0 } });
      await run("midi.mapping.put", { mapping: { id: "m-mark", label: "Couleur", input: { type: "note", channel: 1, number: 9 }, on: { command: "venue.fixture.mark", args: { id: "bar-0" } } } });
      const uses = ((await run("show.references", { kind: "fixture", id: "bar-0" })) as { uses: string[] }).uses;
      expect(uses).to.include.members(["groupe « Avant »", "fader de canaux « UV »", "mapping MIDI « Couleur »"]);
      let refused = "";
      await run("venue.fixture.delete", { id: "bar-0" }).catch((e: Error) => (refused = e.message));
      expect(refused).to.contain("groupe « Avant »").and.contain("fader de canaux « UV »").and.contain("force: true");
      expect(plugin.runtime.venue.fixtures.get("bar-0")).to.not.equal(undefined);
      const forced = (await run("venue.fixture.delete", { id: "bar-0", force: true })) as { deleted: boolean; usedBy: string[] };
      expect(forced.deleted).to.equal(true);
      expect(forced.usedBy).to.include.members(uses);
      expect(plugin.runtime.venue.fixtures.get("bar-0")).to.equal(undefined);
      // nothing uses a new fixture: no force needed, and an unknown id is not an error
      await run("venue.fixture.put", { fixture: { id: "libre", name: "Libre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 3, address: 1 } });
      expect(await run("venue.fixture.delete", { id: "libre" })).to.deep.include({ deleted: true });
      expect(await run("venue.fixture.delete", { id: "nulle-part" })).to.deep.include({ deleted: false });
    });

    it("answers deleted: false for an id out of the patch, even when a mapping still names it", async () => {
      await run("midi.mapping.put", { mapping: { id: "m-stale", label: "Ancien", input: { type: "note", channel: 1, number: 10 }, on: { command: "position.release", args: { fixture: "parti" } } } });
      expect(await run("venue.fixture.delete", { id: "parti" })).to.deep.equal({ deleted: false, usedBy: [] });
    });

    it("refuses to patch on a universe the output does not have, and says when a fixture ends past channel 512", async () => {
      const fixture = { id: "loin", name: "Loin", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 99, address: 1 };
      let refused = "";
      await run("venue.fixture.put", { fixture }).catch((e: Error) => (refused = e.message));
      expect(refused).to.contain("univers 99 hors de 1..");
      const put = (await run("venue.fixture.put", { fixture: { ...fixture, universe: 1, address: 505 } })) as { warning?: string };
      expect(put.warning).to.contain("512");
    });

    it("deletes what nothing uses, and the check flags names used twice", async () => {
      await run("fader.put", { fader: { id: "spare", name: "Master", channels: [{ fixture: "bar-0", offset: 0 }], level: 0 } });
      await run("fader.put", { fader: { id: "spare-2", name: "master ", channels: [{ fixture: "bar-0", offset: 1 }], level: 0 } });
      const lint = (await run("show.lint")) as { issues: { where: string; message: string }[] };
      expect(lint.issues.find((i) => i.where === "fader spare-2")?.message).to.contain("même nom que spare");
      expect(await run("fader.delete", { id: "spare-2" })).to.deep.equal({ deleted: true });
      // mappings: one label for two targets is flagged, for the same target (note on/off pairs…) not
      const mapping = (id: string, label: string, number: number, target: string) => ({ id, label, input: { type: "cc", channel: 5, number }, on: { command: "group.level", args: { id: target } }, levelArg: "level" });
      await run("midi.mapping.put", { mapping: mapping("cc-a", "Master", 1, "master") });
      await run("midi.mapping.put", { mapping: mapping("cc-b", "Master", 2, "master") });
      await run("midi.mapping.put", { mapping: mapping("cc-c", "master", 3, "other") });
      await run("midi.mapping.put", { mapping: { id: "note-d", label: "MASTER", input: { type: "note", channel: 5, number: 4 }, on: { command: "look.go", args: { id: "master" } } } }); // a button for the same object
      const again = (await run("show.lint")) as { issues: { where: string; message: string }[] };
      expect(again.issues.filter((i) => i.message.includes("même libellé")).map((i) => i.where)).to.deep.equal(["mapping cc-c"]);
    });
  });
});
