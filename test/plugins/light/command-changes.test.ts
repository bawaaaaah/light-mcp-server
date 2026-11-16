import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import type { Domain } from "../../../src/plugins/light/commands/domains.js";

/**
 * What a command declares it changes (`CommandDef.changes`, T45) is what the screens read again on: a domain changed
 * but not declared leaves a screen stale. Each command of a sample runs on a show; what every domain shows (read through
 * its read commands) is compared before and after, and a reload of the show counts as `show`.
 */
describe("what a command changes, measured (T45)", () => {
  let plugin: LightPlugin;
  let reloads = 0;
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  const read = async (name: string, args: unknown = {}) => JSON.stringify(await run(name, args));
  /** A list read without some of its fields: what another domain shows in it (a look playing, a show's last change). */
  const readWithout = async (name: string, keys: string[], args: unknown = {}) =>
    JSON.stringify(((await run(name, args)) as Record<string, unknown>[]).map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)))));

  /** What each domain shows, as its screens read it. */
  const observe = async (): Promise<Partial<Record<Domain, string>>> => ({
    patch: await read("venue.fixture.list"),
    canvases: await read("venue.canvas.list"),
    zones: await read("stage.zone.list"),
    looks: (await readWithout("look.list", ["active"], { brief: false })) + (await read("palette.list")),
    groups: await read("group.list"),
    faders: await read("fader.list"),
    settings: await read("show.settings"),
    // the last change of a show moves with any write: no screen reads its list again for it
    shows: await readWithout("show.list", ["changedAt"]),
    snapshots: await read("snapshot.list"),
    songs: (await read("song.list")) + (await read("setlist.list")),
    rules: (await read("rule.list")) + (await read("program.list")),
    targets: await read("target.list"),
    positions: await read("position.preset.list"),
    "colour-presets": await read("colour.preset.list"),
    colours: await read("colour.applied"),
    dashboards: await read("dashboard.list"),
    playback: JSON.stringify(plugin.runtime.activeLooks()),
    motion: await read("position.list"),
    output: JSON.stringify(plugin.state().blackout),
  });

  /** The domains a command really changed: its reads differ, or it reloaded the show. */
  const measure = async (name: string, args: unknown = {}): Promise<Domain[]> => {
    const before = await observe();
    const reloadsBefore = reloads;
    await run(name, args);
    const after = await observe();
    const changed = (Object.keys(after) as Domain[]).filter((d) => after[d] !== before[d]);
    return reloads > reloadsBefore ? ["show", ...changed] : changed;
  };
  const undeclared = (name: string, changed: Domain[]): Domain[] => {
    const declared = plugin.commands.get(name)!.changes ?? [];
    // `show`: the show or its venue replaced as a whole, every screen reads everything again
    return declared.includes("show") ? [] : changed.filter((d) => !declared.includes(d));
  };

  before(async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-changes-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    const resetLive = plugin.runtime.resetLive.bind(plugin.runtime);
    plugin.runtime.resetLive = () => {
      reloads++;
      resetLive();
    };
  });

  it("declares every domain each command of a sample really changes", async () => {
    const fixtures = ((await run("venue.fixture.list")) as { id: string }[]).map((f) => f.id);
    const looks = ((await run("look.list")) as { id: string }[]).map((l) => l.id);
    const canvases = ((await run("venue.canvas.list")) as { id: string }[]).map((c) => c.id);
    // a dashboard of its own: without one, dashboard.list makes a default one from the groups and looks
    await run("dashboard.generate", {});
    const sample: [string, unknown][] = [
      ["look.go", { id: looks[0] }],
      ["colour.apply", { color: "#00ff00", fixtures: fixtures.slice(0, 2) }],
      ["grandmaster.set", { level: 0.5 }],
      ["program.put", { program: { id: "p1", name: "Prière" } }],
      ["program.select", { id: "p1" }],
      ["snapshot.save", { id: "s1", name: "Essai" }],
      ["look.stopall", {}],
      ["snapshot.recall", { id: "s1" }],
      ["panic", {}],
      ["panic.undo", {}],
      ["show.settings.set", { absentFixtures: [fixtures[0]] }],
      ["show.settings.set", { absentFixtures: [], folders: ["Dossier"], name: "Autre nom" }],
      ["venue.fixture.presence", { fixtures: [fixtures[1]], present: false }],
      ["venue.fixture.presence", { fixtures: [fixtures[1]], present: true }],
      ["show.folder.create", { folder: "Neuf" }],
      ["look.exclusive", { looks: looks.slice(0, 2), create: { name: "Excl" } }],
      ["group.put", { group: { id: "g1", name: "Face", members: { fixtures: fixtures.slice(0, 2) } } }],
      ["group.level", { id: "g1", level: 0.4 }],
      ["fader.put", { fader: { id: "f1", name: "Blanc", channels: [{ fixture: fixtures[0], offset: 0 }] } }],
      ["stage.zone.put", { zone: { id: "z1", name: "Scène", polygon: [[-2, 0], [2, 0], [2, 3], [-2, 3]] } }],
      ["song.put", { song: { id: "chant", title: "Chant", mood: ["joie"], sections: [{ id: "a", name: "Couplet" }] } }],
      ["song.grid_fill", { song: "chant", canvas: canvases[0], save: true }],
      ["snapshot.delete", { id: "s1", force: true }],
      ["show.rename", { name: "Renommé" }],
    ];
    const wrong: string[] = [];
    for (const [name, args] of sample) {
      const missing = undeclared(name, await measure(name, args));
      if (missing.length) wrong.push(`${name} ${JSON.stringify(args)}: ${missing.join(", ")}`);
    }
    expect(wrong).to.deep.equal([]);
  });

  it("calls `show` every command that reloads the open show (its live state is reset)", async () => {
    for (const [name, args] of [["show.rename", { name: "Encore" }], ["show.reset", {}]] as const) {
      expect(await measure(name, args), name).to.include("show");
      expect(plugin.commands.get(name)!.changes, name).to.include("show");
    }
  });
});
