import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { usesOf, type ShowParts } from "../../../src/plugins/light/show/references.js";

describe("references: what uses a look, a group or a fader", () => {
  const empty: ShowParts = { groups: [], faders: [], mappings: [], dashboards: [], snapshots: [], songs: [] };

  it("finds every place, once per place", () => {
    const show: ShowParts = {
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
    expect(usesOf("group", "nobody", show)).to.deep.equal([]);
    expect(usesOf("look", "warm", empty)).to.deep.equal([]);
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
      const again = (await run("show.lint")) as { issues: { where: string; message: string }[] };
      expect(again.issues.filter((i) => i.message.includes("même libellé")).map((i) => i.where)).to.deep.equal(["mapping cc-c"]);
    });
  });
});
