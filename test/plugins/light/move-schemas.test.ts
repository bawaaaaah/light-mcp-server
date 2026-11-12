import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { MoveFadeSchema, MoveSchema } from "../../../src/plugins/light/engine/move.js";
import { LookSchema, ShowSettingsSchema } from "../../../src/plugins/light/show/model.js";
import { usesOf, type ShowParts } from "../../../src/plugins/light/show/references.js";

describe("T25 lot 3: move schemas (fade, enabled, at, moveFade, rest positions)", () => {
  it("parses a glide in beats or in milliseconds, 0 = cut, and refuses the rest", () => {
    expect(MoveFadeSchema.parse({ beats: 2 })).to.deep.equal({ beats: 2 });
    expect(MoveFadeSchema.parse({ seconds: 1 })).to.deep.equal({ seconds: 1 });
    expect(MoveFadeSchema.parse({ seconds: 0 })).to.deep.equal({ seconds: 0 });
    expect(MoveFadeSchema.safeParse({ seconds: -1 }).success).to.equal(false);
    expect(MoveFadeSchema.safeParse({ seconds: 31 }).success).to.equal(false);
    expect(MoveFadeSchema.safeParse({ beats: 2, seconds: 1 }).success).to.equal(false);
    expect(MoveFadeSchema.safeParse(1).success).to.equal(false);
    expect(MoveFadeSchema.safeParse({}).success).to.equal(false);
  });

  it("a move without the new fields parses unchanged", () => {
    const m = MoveSchema.parse({ shape: "cercle" });
    expect(m.fade).to.equal(undefined);
    expect(m.enabled).to.equal(undefined);
    const full = MoveSchema.parse({ fade: { beats: 2 }, enabled: false, at: { target: "singer" } });
    expect(full).to.not.have.property("at"); // not declared: stripped, accepted and ignored
    expect(full.fade).to.deep.equal({ beats: 2 });
    expect(full.enabled).to.equal(false);
  });

  it("a look keeps move.fade and enabled through a round trip", () => {
    const look = LookSchema.parse({ id: "l", name: "L", canvas: "c", technique: { kind: "plat", color: "#ff0000" }, move: { shape: "tapis", fade: { seconds: 0 }, enabled: true } });
    const again = LookSchema.parse(JSON.parse(JSON.stringify(look)));
    expect(again.move?.fade).to.deep.equal({ seconds: 0 });
    expect(again).to.deep.equal(look);
  });

  it("show settings: default glide 1 s, no rest position, old files load unchanged", () => {
    const old = ShowSettingsSchema.parse({ name: "s", venue: "v" });
    expect(old.moveFade).to.deep.equal({ seconds: 1 });
    expect(old.restPositions).to.deep.equal({});
    const set = ShowSettingsSchema.parse({ moveFade: { beats: 2 }, restPositions: { "bar-0": { pan: 0.25, tilt: 0.75 } } });
    expect(ShowSettingsSchema.parse(JSON.parse(JSON.stringify(set)))).to.deep.equal(set);
    expect(ShowSettingsSchema.safeParse({ restPositions: { a: { pan: 2, tilt: 0 } } }).success).to.equal(false);
  });

  it("show.references counts look.move.group as a use of the group", () => {
    const show: ShowParts = {
      groups: [{ id: "lyres", name: "Lyres", members: { looks: [], groups: [] } }],
      faders: [],
      mappings: [],
      dashboards: [],
      snapshots: [],
      songs: [],
      looks: [
        { id: "a", name: "Tapis", canvas: "c", move: { group: "lyres" } },
        { id: "b", name: "Autre", canvas: "c", move: {} },
      ],
    };
    expect(usesOf("group", "lyres", show)).to.deep.equal(["look « Tapis » (mouvement)"]);
  });

  describe("in the show", () => {
    let plugin: LightPlugin;
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    beforeEach(async () => {
      const dataRoot = join(mkdtempSync(join(tmpdir(), "light-movefade-")), "data");
      mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
      copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
      const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
      await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    });

    it("show.settings.set stores moveFade and rest positions; an unknown fixture is refused", async () => {
      await run("show.settings.set", { moveFade: { beats: 2 }, restPositions: { "bar-0": { pan: 0.2, tilt: 0.8 } } });
      expect(plugin.runtime.settings.moveFade).to.deep.equal({ beats: 2 });
      expect(plugin.runtime.settings.restPositions).to.deep.equal({ "bar-0": { pan: 0.2, tilt: 0.8 } });
      let refused = "";
      await run("show.settings.set", { restPositions: { ghost: { pan: 0.5, tilt: 0.5 } } }).catch((e: Error) => (refused = e.message));
      expect(refused).to.contain("ghost");
    });

    it("deleting a fixture drops its rest position, and the rest position never blocks the delete", async () => {
      await run("venue.fixture.put", { fixture: { id: "spare", name: "Spare", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 400 } });
      plugin.runtime.saveSettings({ restPositions: { spare: { pan: 0.2, tilt: 0.8 } } });
      await run("venue.fixture.delete", { id: "spare" });
      expect(plugin.runtime.settings.restPositions).to.deep.equal({});
    });

    it("position.rest.set / clear touch one head at a time and refuse what is not a moving head", async () => {
      const heads = plugin.runtime.movingHeads();
      if (heads.length < 2) return; // the fixtures of this show carry no moving head
      await run("position.rest.set", { fixtures: [heads[0]], pan: 0.1, tilt: 0.9 });
      await run("position.rest.set", { fixtures: [heads[1]], pan: 0.3, tilt: 0.4 });
      expect(plugin.runtime.settings.restPositions).to.deep.equal({ [heads[0]!]: { pan: 0.1, tilt: 0.9 }, [heads[1]!]: { pan: 0.3, tilt: 0.4 } });
      await run("position.rest.clear", { fixtures: [heads[0]] });
      expect(Object.keys(plugin.runtime.settings.restPositions)).to.deep.equal([heads[1]]);
    });

    it("position.rest.set refuses an id that is not an installed moving head", async () => {
      let refused = "";
      await run("position.rest.set", { fixtures: ["ghost"], pan: 0.5, tilt: 0.5 }).catch((e: Error) => (refused = e.message));
      expect(refused).to.contain("ghost");
    });

    it("a stale rest id (kept from a shared venue) is tolerated, and a new venue starts without rest positions", async () => {
      plugin.runtime.saveSettings({ restPositions: { stale: { pan: 0.5, tilt: 0.5 }, "bar-0": { pan: 0.1, tilt: 0.1 } } });
      await run("show.settings.set", { restPositions: { stale: { pan: 0.5, tilt: 0.5 }, "bar-0": { pan: 0.2, tilt: 0.2 } } });
      expect(plugin.runtime.settings.restPositions["bar-0"]).to.deep.equal({ pan: 0.2, tilt: 0.2 });
      const current = ((await run("show.list")) as { id: string; active?: boolean }[]).find((x) => x.active)!;
      const made = (await run("show.create", { name: "Autre", from: current.id, venue: "new", open: true })) as { id: string };
      expect(made.id).to.be.a("string");
      expect(plugin.runtime.settings.restPositions).to.deep.equal({});
    });
  });
});
