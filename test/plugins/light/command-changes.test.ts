import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import type { Domain } from "../../../src/plugins/light/commands/domains.js";

/** A head with a Reset range (reset-protection.test.ts), for fixture.reset. */
const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition">
 <Manufacturer>Test</Manufacturer><Model>Head</Model><Type>Moving Head</Type>
 <Channel Name="Pan" Preset="PositionPan"/>
 <Channel Name="Tilt" Preset="PositionTilt"/>
 <Channel Name="Dimmer" Preset="IntensityDimmer"/>
 <Channel Name="Control"><Group Byte="0">Maintenance</Group><Capability Min="0" Max="199">No function</Capability><Capability Min="200" Max="255">Reset</Capability></Channel>
 <Mode Name="4 Channel"><Channel Number="0">Pan</Channel><Channel Number="1">Tilt</Channel><Channel Number="2">Dimmer</Channel><Channel Number="3">Control</Channel></Mode>
</FixtureDefinition>`;

/**
 * Commands that write and are not measured here, with why: they need hardware, the network or another program, or
 * what they change is not read back by any command. A new command that writes must be measured or listed.
 */
const UNMEASURED: Record<string, string> = {
  "ableset.configure": "starts following an AbleSet server on the network",
  "ableset.jump": "asks the AbleSet server on the network to jump",
  "midi.rtp.connect": "opens an RTP-MIDI session on the network",
  "midi.rtp.disconnect": "closes an RTP-MIDI session on the network",
  "midi.rtp.keep": "an RTP-MIDI session on the network",
  "midi.profile.select": "opens the MIDI ports of the profile (hardware)",
  "midi.in": "relays bytes to the MIDI hub: the commands its mappings call are events of their own",
  "midi.web.closed": "tells the MIDI hub an input is gone: the releases it makes are events of their own",
  "output.route": "opens Art-Net / sACN / USB outputs (network, serial ports)",
  "export.liveset": "writes into an Ableton Live set file given by path",
  "export.ableton.rack": "writes an Ableton rack next to a shell file given by path",
  "export.ableton.programs": "writes Ableton clips next to a shell file given by path",
  "library.merge": "needs two definitions of one model in the library (library.test.ts)",
  "library.unalias": "needs a model alias left by library.merge (library.test.ts)",
  "history.undo": "needs an activity line of a change (history.test.ts); history.restore is measured",
  "show.apply": "declares `show`: a proposal can hold any put",
  "show.revert": "declares `show`, like show.apply",
};

/**
 * What a command declares it changes (`CommandDef.changes`, T45) is what the screens read again on: a domain changed but
 * not declared leaves a screen stale. Every command that writes runs on a show with its arguments; what each domain
 * shows (read through its read commands) is compared before and after, and a reload of the show counts as `show`.
 */
describe("what a command changes, measured (T45)", () => {
  let plugin: LightPlugin;
  let reloads = 0;
  // the command line: where a confirmation can be answered (a voluntary reset is accepted there)
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext("cli"));
  // a read refused (a fixture not patched yet) is a state of its own
  const read = async (name: string, args: unknown = {}) => run(name, args).then((r) => JSON.stringify(r), (e: Error) => `refused: ${e.message}`);
  /** A list read without some of its fields: what another domain shows in it (a look playing, a show's last change). */
  const readWithout = async (name: string, keys: string[], args: unknown = {}) =>
    JSON.stringify(((await run(name, args)) as Record<string, unknown>[]).map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)))));

  /** The library as its page shows it, but for what uses each definition (the patch's) and the trash. */
  const definitions = async () => {
    const { definitions: rows, aliases } = (await run("library.list")) as { definitions: Record<string, unknown>[]; aliases: Record<string, unknown>[] };
    const without = (list: Record<string, unknown>[], key: string) => list.map(({ [key]: _, ...rest }) => rest);
    return JSON.stringify([without(rows, "usedBy"), without(aliases, "fixtures")]) + (await read("library.trash"));
  };

  /** The intentions as the show sees them, but for their uses (by songs and looks: those domains'). */
  const intentions = async () => {
    const { moods } = (await run("knowledge.get")) as { moods: Record<string, { usedBy?: unknown }> };
    return JSON.stringify(Object.entries(moods).map(([id, { usedBy: _, ...mood }]) => [id, mood]));
  };

  /** What each domain shows, as its screens read it. */
  const observe = async (): Promise<Partial<Record<Domain, string>>> => {
    const state = plugin.state();
    return {
      patch:
        (await read("venue.fixture.list")) +
        (await read("venue.fixture.channels")) +
        (await read("venue.fixture.travel", { fixture: "spot" })) +
        (await read("venue.fixture.heads", { fixture: "bar-0" })) +
        (await read("venue.tracks.get", { fixture: "spot" })) +
        (await read("venue.wheel.get", { id: "roue" })),
      canvases: await read("venue.canvas.list"),
      zones: await read("stage.zone.list"),
      // the named folders too: the show list groups its looks under them
      looks: (await readWithout("look.list", ["active"], { brief: false })) + (await read("palette.list")) + JSON.stringify(((await run("show.settings")) as { folders: string[] }).folders),
      groups: await read("group.list"),
      faders: await read("fader.list"),
      settings: (await read("show.settings")) + JSON.stringify(state.grandMaster),
      // the last change of a show moves with any write: no screen reads its list again for it
      shows: await readWithout("show.list", ["changedAt"]),
      snapshots: await read("snapshot.list"),
      songs: (await read("song.list")) + (await read("setlist.list")),
      rules: (await read("rule.list")) + (await read("program.list")) + JSON.stringify(state.program),
      targets: await read("target.list"),
      positions: await read("position.preset.list"),
      "colour-presets": await read("colour.preset.list"),
      colours: await read("colour.applied"),
      dashboards: await read("dashboard.list"),
      intentions: await intentions(),
      midi: await read("midi.mapping.list"),
      calibration: await read("calibration.list", { fixture: "spot" }),
      // what uses a definition is the patch's
      definitions: await definitions(),
      backups: await read("backup.list"),
      proposals: await read("show.proposals"),
      playback: JSON.stringify([plugin.runtime.activeLooks(), await run("song.state"), ((await run("tempo.get")) as { bpm: number }).bpm]),
      motion: (await read("position.list")) + JSON.stringify(state.motionLock),
      output: JSON.stringify([state.blackout, state.parked, plugin.engine.parked(1)]),
      machine: JSON.stringify(state.standby),
    };
  };

  /** The domains a command really changed: its reads differ, or it reloaded the show. */
  const measure = async (name: string, args: unknown = {}): Promise<Domain[]> => {
    const before = await observe();
    const reloadsBefore = reloads;
    await run(name, args);
    const after = await observe();
    const changed = (Object.keys(after) as Domain[]).filter((d) => after[d] !== before[d]);
    return reloads > reloadsBefore ? ["show", ...changed] : changed;
  };
  const undeclared = (name: string, changed: Domain[], declared = plugin.commands.get(name)!.changes ?? []): Domain[] =>
    // `show`: the show or its venue replaced as a whole, every screen reads everything again
    declared.includes("show") ? [] : changed.filter((d) => !declared.includes(d));

  /** A command measured: run once its `setup` (not measured) has run; `args`, a function, is computed then. */
  type Step = [name: string, args?: unknown, setup?: () => Promise<unknown>];
  const ids: Record<string, string> = {};
  const definition = async (model: string) => ((await run("library.list")) as { definitions: { id: string; model: string }[] }).definitions.find((d) => d.model === model)!.id;
  const steps = (): Step[] => [
    ["venue.fixture.put", { fixture: { id: "spot", name: "Lyre", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 100, position: { x: 0, y: 2, z: 5 }, mount: "hung" } }],
    ["venue.fixture.put", { fixture: { id: "roue", name: "Roue", manufacturer: "Test", model: "Wheel Spot", mode: "Standard", universe: 1, address: 130 } }],
    ["venue.fixture.put", { fixture: { id: "h1", name: "Tête", manufacturer: "Test", model: "Head", mode: "4 Channel", universe: 1, address: 160 } }],
    ["venue.fixture.mark", { id: "bar-0", name: "Barre jardin" }],
    ["venue.fixture.orient", { id: "spot", facing: "audience" }],
    ["venue.fixture.heads.set", { fixture: "bar-0", scope: "fixture", follow: false }],
    ["venue.fixture.heads.clear", { fixture: "bar-0", scope: "fixture" }],
    ["venue.fixture.travel.set", { fixture: "spot", scope: "fixture", panMax: 500 }],
    ["venue.tracks.put", { fixtures: ["spot"], enabled: true, fade: ["Dimmer"] }],
    ["venue.tracks.clear", { fixture: "spot" }],
    ["venue.wheel.put", { id: "roue", scope: "fixture", wheel: { doubles: false } }],
    ["venue.wheel.clear", { id: "roue", scope: "fixture" }],
    ["stage.zone.put", { zone: { id: "z1", name: "Scène", polygon: [[-3, 0], [3, 0], [3, 4], [-3, 4]], aim: { height: 1.5 } } }],
    ["venue.fixture.arrange", { fixtures: ["bar-1", "bar-0"], zone: "z1", edge: "front", facing: "audience" }],
    ["venue.grouping.apply", { tags: ["barre"] }],
    ["venue.canvas.auto", { id: "auto", name: "Auto", fixtures: ["bar-0", "bar-1"] }],
    ["venue.canvas.edit", { id: "auto", ops: [{ op: "remove", cells: [0] }], force: true, shared: true }],
    ["venue.canvas.put", async () => ({ canvas: { ...((await run("venue.canvas.get", { id: "auto" })) as { canvas: object }).canvas, name: "Auto 2" }, force: true, shared: true })],
    ["venue.canvas.delete", { id: "auto", force: true }],
    ["venue.fixture.presence", { fixtures: ["bar-1"], present: false }],
    ["venue.fixture.presence", { fixtures: ["bar-1"], present: true }],
    // a moving head not installed leaves the pad's list
    ["venue.fixture.presence", { fixtures: ["spot"], present: false }],
    ["venue.fixture.presence", { fixtures: ["spot"], present: true }],
    ["show.settings.set", { absentFixtures: ["bar-0"] }],
    ["show.settings.set", { absentFixtures: [], name: "Autre nom" }],
    ["show.settings.set", { folders: ["Dossier"] }],
    // where a head points is read on a rendered frame: the engine runs for the calibration
    ["calibration.record", { fixture: "spot", zone: "z1" }, async () => (plugin.engine.start(), new Promise((done) => setTimeout(done, 100)))],
    ["calibration.record", { fixture: "spot", point: { x: 2, y: 1, z: 0 } }],
    ["calibration.solve", { fixture: "spot", apply: true }, async () => run("calibration.record", { fixture: "spot", point: { x: -2, y: 3, z: 0 } })],
    ["calibration.correct", { fixture: "spot", point: { x: 1, y: 1, z: 0 }, apply: true }],
    ["calibration.clear", { fixture: "spot" }, async () => plugin.engine.stop()],
    ["fixture.definition.add", { name: "head2.qxf", xml: HEAD.replace("<Model>Head</Model>", "<Model>Head 2</Model>") }],
    ["library.duplicate", async () => ({ id: await definition("Head 2"), model: "Head 3" })],
    ["library.delete", async () => ({ id: await definition("Head 3"), force: true })],
    ["library.restore", async () => ({ id: ((await run("library.trash")) as { id: string }[])[0]!.id })],
    ["library.trash.empty", {}, async () => run("library.delete", { id: await definition("Head 3"), force: true })],
    ["palette.put", { palette: { id: "chaude", name: "Chaude", colors: ["#ff8800", "#ff0000"] } }],
    ["look.put", async () => ({ look: { ...((await run("look.get", { id: ids.look0! })) as Record<string, unknown>), id: "copie", name: "Copie", active: undefined, swatch: undefined } })],
    ["look.go", () => ({ id: ids.look0 })],
    ["colour.apply", { color: "#00ff00", fixtures: ["bar-0", "bar-1"], fade: 0 }],
    ["look.go", () => ({ id: ids.look1 })],
    ["colour.release", { fixtures: ["bar-0", "bar-1"], fade: 0 }, async () => run("colour.apply", { color: "#00ff00", fixtures: ["bar-0", "bar-1"], fade: 0 })],
    ["look.stop", () => ({ id: ids.look1 })],
    ["look.stopall", {}, async () => run("look.go", { id: "copie" })],
    ["look.delete", { id: "copie", force: true }, async () => run("look.go", { id: "copie" })],
    ["look.exclusive", () => ({ looks: [ids.look0, ids.look1], create: { name: "Excl" } })],
    ["look.from_intent", () => ({ name: "Joie", canvas: ids.canvas, mood: ["joie"], save: true, id: "joie" })],
    ["look.rebuild", { save: true }],
    ["show.folder.create", { folder: "Neuf" }],
    ["show.folder.move", () => ({ ids: [ids.look0], folder: "Neuf" })],
    ["show.folder.rename", { from: "Neuf", to: "Autre" }],
    ["show.folder.nest", { src: "Autre", under: "Parent" }, async () => run("show.folder.create", { folder: "Parent" })],
    ["show.folder.delete", { folder: "Parent" }],
    ["group.put", { group: { id: "g1", name: "Face", members: { fixtures: ["bar-0", "bar-1"] }, master: { level: 1, mute: false } } }],
    ["group.level", { id: "g1", level: 0.4 }],
    ["group.mute", { id: "g1", mute: true }],
    ["group.flash", { id: "g1", on: true }],
    ["group.flash", { id: "g1", on: false }],
    ["live.adjust", { dca: { id: "g1", level: 0.5 } }, async () => run("show.settings.set", { liveAi: true })],
    ["fader.put", { fader: { id: "f1", name: "Blanc", channels: [{ fixture: "bar-0", offset: 0 }] } }],
    ["fader.level", { id: "f1", level: 0.6 }],
    ["fader.channel", { fixture: "bar-1", offset: 1 }],
    ["fader.delete", { id: "f1", force: true }],
    ["grandmaster.set", { level: 0.8 }],
    ["rule.put", { where: "show", rule: { id: "lent", name: "Lent", level: "show", scope: { fixture: "spot" }, target: {}, maxDegPerSecond: 20 } }],
    ["rule.delete", { id: "lent" }],
    ["program.put", { program: { id: "p1", name: "Prière" } }],
    ["program.select", { id: "p1" }],
    ["program.select", { id: null }],
    ["snapshot.save", { id: "s1", name: "Essai" }, async () => (await run("program.select", { id: "p1" }), run("grandmaster.set", { level: 1 }))],
    ["snapshot.recall", { id: "s1" }, async () => (await run("program.select", { id: null }), await run("grandmaster.set", { level: 0.3 }), run("look.stopall"))],
    // the Panic recalls the safe snapshot: its program and grand master come back
    ["show.settings.set", { safeSnapshot: "s1" }],
    ["panic", {}, async () => (await run("program.select", { id: null }), await run("grandmaster.set", { level: 0.3 }), run("look.go", { id: ids.look0 }))],
    ["panic.undo", {}],
    // the safe snapshot deleted: the setting naming it goes
    ["snapshot.delete", { id: "s1" }],
    ["program.delete", { id: "p1" }],
    ["blackout", { on: true }],
    ["blackout", { on: false }],
    ["dmx.set", { universe: 1, channel: 1, value: 200 }],
    ["dmx.release", { universe: 1, channels: [1] }],
    ["fixture.reset", { id: "h1", confirm: true }],
    ["fixture.channel.mode", { fixture: "h1", channel: "Control", mode: "No function" }],
    ["output.standby", { on: true }],
    ["output.standby", { on: false }],
    ["position.set", { fixtures: ["spot"], pan: 0.3, tilt: 0.6 }],
    ["position.preset.save", { fixtures: ["spot"], id: "pos1", name: "Face" }],
    ["position.preset.put", async () => ({ position: { ...((await run("position.preset.list")) as { id: string }[]).find((p) => p.id === "pos1"), name: "Face 2" } })],
    ["position.preset.refresh", { id: "pos1", how: "keep" }],
    ["position.home", { fixtures: ["spot"] }],
    ["position.preset.go", { id: "pos1", fixtures: ["spot"] }],
    ["position.aim", { fixtures: ["spot"], zone: "z1" }],
    ["position.release", { fixtures: ["spot"] }],
    ["position.releaseTop", { fixtures: ["spot"] }],
    ["position.rest.set", { fixtures: ["spot"], pan: 0.5, tilt: 0.4 }],
    ["position.rest.clear", { fixtures: ["spot"] }],
    ["position.preset.delete", { id: "pos1", force: true }],
    ["motion.freeze", { level: "hard" }],
    ["motion.unfreeze", {}],
    ["target.put", { target: { id: "t1", name: "Chanteur", fixtures: ["spot"], point: { x: 0, y: 1, z: 1.5 } } }],
    ["target.set", { id: "t1", x: 1 }],
    ["target.zone", { id: "t1", zone: "z1" }],
    ["target.engage", { id: "t1", on: true }],
    ["target.engage", { id: "t1", on: false }],
    ["target.delete", { id: "t1", force: true }],
    ["colour.preset.put", { preset: { id: "vert", name: "Vert", color: "#00ff00" }, favorite: true }],
    ["colour.preset.favorite", { id: "vert", favorite: false }],
    ["colour.preset.order", { ids: ["vert"] }, async () => run("colour.preset.favorite", { id: "vert", favorite: true })],
    ["colour.preset.delete", { id: "vert", scope: "show", force: true }],
    ["intention.put", { intention: { id: "paix", label: "Paix", colors: ["#123456"] } }],
    ["intention.delete", { id: "paix", force: true }],
    ["song.put", { song: { id: "chant", title: "Chant", mood: ["joie"], sections: [{ id: "a", name: "Couplet" }, { id: "b", name: "Refrain" }] } }],
    ["song.grid_fill", () => ({ song: "chant", canvas: ids.canvas, save: true })],
    ["setlist.put", { setlist: { id: "set", name: "Dimanche", songs: ["chant"] } }],
    ["setlist.select", { id: "set" }],
    ["setlist.next", {}],
    ["setlist.prev", {}],
    ["song.select", { id: "chant" }],
    ["song.play", { song: "chant" }],
    ["song.next", {}],
    ["song.prev", {}],
    ["song.section.go", { song: "chant", section: "b" }],
    ["song.stop", {}],
    ["song.follow", { on: false }],
    ["tempo.set", { bpm: 98 }],
    ["tempo.tap", {}],
    ["export.mid", { song: "chant", inline: true }],
    ["midi.mapping.put", () => ({ mapping: { id: "n1", input: { type: "note", channel: 1, number: 40 }, on: { command: "look.go", args: { id: ids.look0 } } } })],
    ["midi.mapping.delete", { id: "n1" }],
    ["midi.profile.save", { name: "x", profile: { inputs: [], rtp: { enabled: false } } }],
    ["midi.portloss.set", { web: "keep" }],
    ["selftest.run", {}],
    ["dashboard.generate", { id: "d1", name: "Principal" }],
    ["dashboard.put", async () => ({ dashboard: { ...((await run("dashboard.list")) as { id: string }[]).find((d) => d.id === "d1"), name: "Principal 2" } })],
    ["dashboard.delete", { id: "d1" }],
    ["notes.set", { collection: "fixtures", id: "bar-0", notes: "à vérifier" }],
    ["notes.set", { collection: "groups", id: "g1", notes: "face" }],
    ["show.autopresets", () => ({ canvas: ids.canvas, apply: true })],
    ["history.restore", async () => {
      const versions = (await run("history.list", { collection: "looks", id: ids.look0 })) as { stamp: string }[];
      return { collection: "looks", id: ids.look0, stamp: versions[0]!.stamp };
    }],
    ["show.propose", { changes: [{ command: "intention.put", args: { intention: { id: "brume", label: "Brume", colors: ["#aabbcc"] } } }] }],
    ["show.discard", async () => ({ id: ((await run("show.proposals")) as { id: string }[])[0]!.id })],
    ["song.delete", { id: "chant" }],
    ["group.delete", { id: "g1", force: true }],
    ["stage.zone.delete", { id: "z1", force: true }],
    ["venue.fixture.mode", { id: "spot", mode: "Basic", force: true }],
    // a fixture not installed, held in a named position: its line in the settings and the position go with it
    ["venue.fixture.delete", { id: "h1", force: true }, async () => (await run("position.preset.save", { fixtures: ["h1"], id: "pos-h1", name: "Tête" }), run("venue.fixture.presence", { fixtures: ["h1"], present: false }))],
    ["backup.create", { label: "essai" }],
    ["backup.restore", async () => ({ file: ((await run("backup.list")) as { file: string }[])[0]!.file })],
    ["import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true, replace: true, force: true }],
    ["show.rename", { name: "Renommé" }],
    ["show.create", { name: "Autre", venue: "new", open: false }],
    ["venue.positions.import", async () => ({ from: ((await run("venue.list")) as { id: string }[]).find((v) => v.id !== "default")!.id, apply: true })],
    ["show.venue.set", async () => ({ venue: ((await run("venue.list")) as { id: string }[]).find((v) => v.id !== "default")!.id })],
    ["show.venue.detach", {}],
    ["show.open", async () => ({ id: ((await run("show.list")) as { id: string; active: boolean }[]).find((s) => !s.active)!.id })],
    ["show.delete", async () => ({ id: ((await run("show.list")) as { id: string; active: boolean }[]).find((s) => !s.active)!.id })],
    ["show.reset", {}],
  ];

  before(async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-changes-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    for (const f of ["bar4.qxf", "spot.qxf", "wheel-spot.qxf"]) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(dataRoot, "fixtures", f));
    writeFileSync(join(dataRoot, "fixtures", "head.qxf"), HEAD);
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    const looks = (await run("look.list")) as { id: string }[];
    ids.look0 = looks[0]!.id;
    ids.look1 = looks[1]!.id;
    ids.canvas = ((await run("venue.canvas.list")) as { id: string }[])[0]!.id;
    // a dashboard of its own: without one, dashboard.list makes a default one from the groups, looks and faders
    await run("dashboard.generate", { id: "main", name: "Principal" });
    const resetLive = plugin.runtime.resetLive.bind(plugin.runtime);
    plugin.runtime.resetLive = () => {
      reloads++;
      resetLive();
    };
  });

  it("measures or lists every command that writes", () => {
    const measured = new Set(steps().map(([name]) => name));
    const writers = plugin.commands.list().filter((c) => !c.readOnly);
    expect(writers.filter((c) => !measured.has(c.name) && !(c.name in UNMEASURED)).map((c) => c.name)).to.deep.equal([]);
    expect(Object.keys(UNMEASURED).filter((n) => measured.has(n) || !writers.some((c) => c.name === n))).to.deep.equal([]);
  });

  it("declares every domain each command really changes", async () => {
    const wrong: string[] = [];
    for (const [name, args, setup] of steps()) {
      try {
        await setup?.();
        const given = typeof args === "function" ? await (args as () => unknown)() : args;
        const missing = undeclared(name, await measure(name, given));
        if (missing.length) wrong.push(`${name} ${JSON.stringify(given).slice(0, 80)}: ${missing.join(", ")}`);
      } catch (err) {
        // a step that cannot run measures nothing: said, never skipped silently
        wrong.push(`${name}: ${(err as Error).message.slice(0, 160)}`);
      }
    }
    expect(wrong, `\n${wrong.join("\n")}\n`).to.deep.equal([]);
  });

  it("calls `show` every command that reloads the open show (its live state is reset)", async () => {
    for (const [name, args] of [["show.rename", { name: "Encore" }], ["show.reset", {}]] as const) {
      expect(await measure(name, args), name).to.include("show");
      expect(plugin.commands.get(name)!.changes, name).to.include("show");
    }
  });
});
