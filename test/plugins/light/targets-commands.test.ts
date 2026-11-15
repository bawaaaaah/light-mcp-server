import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext, type CommandContext } from "../../../src/plugins/light/commands/registry.js";
import { MidiMapper, MappingSchema } from "../../../src/plugins/light/midi/mapping.js";
import { parseMidi } from "../../../src/plugins/light/midi/parse.js";
import { usesOf, type ShowParts } from "../../../src/plugins/light/show/references.js";
import type { HeadMotionEntry } from "../../../src/plugins/light/show/motion-report.js";

/**
 * Targets through their commands (T24, lot 2; docs/specs/venue-fixtures-stage.md, « Cible »): target.put / .set /
 * .engage / .zone / .list / .delete, a MIDI fader on nx, the references, the Panic and its undo, the snapshots,
 * « Vérifier le show », a proposal, the hard lock and « Rendre la main ».
 */
describe("targets: the commands (T24)", () => {
  let plugin: LightPlugin;
  let now = 0;
  const run = (name: string, args: unknown = {}, ctx: CommandContext = systemContext()) => plugin.commands.invoke(name, args, ctx);
  const frame = () => {
    (plugin.engine as unknown as { frame(now: number): void }).frame(now);
    now += 20;
  };
  const during = (ms: number) => {
    for (let t = 0; t < ms; t += 20) frame();
  };
  type Listed = { id: string; point: { x: number; y: number; z: number }; engaged: boolean; priority?: number; sharesWith: string[]; effectiveBounds: { min: { x: number }; max: { x: number; z: number } }; heads: { id: string; state: string; reason?: string; by?: string | null }[] };
  const listed = async (id: string) => ((await run("target.list")) as Listed[]).find((t) => t.id === id)!;
  const failure = async (p: Promise<unknown>): Promise<Error & { code?: string }> => {
    try {
      await p;
    } catch (e) {
      return e as Error & { code?: string };
    }
    throw new Error("expected a refusal");
  };

  beforeEach(async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-targets-cmds-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    for (const f of ["spot.qxf", "par-rgb.qxf"]) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(dataRoot, "fixtures", f));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    now = 0;
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null, now: () => now });
    plugin.venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: -1, y: 2, z: 5 }, mount: "hung" });
    plugin.venue.fixtures.put({ id: "spot2", name: "Spot 2", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 11, position: { x: 1, y: 2, z: 5 }, mount: "hung" });
    plugin.venue.canvases.put({ id: "lyres", name: "Lyres", topology: "line", cells: 2, render: [{ from: 0, to: 0, targets: [{ fixture: "spot", head: -1 }] }, { from: 1, to: 1, targets: [{ fixture: "spot2", head: -1 }] }] });
    plugin.runtime.groups.put({ id: "lyres", name: "Lyres", members: { fixtures: ["spot", "spot2"] } });
    await run("stage.zone.put", { zone: { id: "scene", name: "Scène", polygon: [[-4, 0], [4, 0], [4, 6], [-4, 6]] } });
  });
  afterEach(async () => {
    await plugin.stop();
  });

  it("target.put creates a target bounded to the stage, keeps its live state on an edit, refuses unknown heads", async () => {
    const t = (await run("target.put", { target: { id: "chant", name: "Chanteur", group: "lyres" } })) as Listed;
    // no point given: the middle of the stage volume (the zone, 0.5 m around), at a standing person's face
    expect(t.point).to.deep.equal({ x: 0, y: 3, z: 1.5 });
    expect(t.engaged).to.equal(false);
    const far = (await run("target.put", { target: { id: "chant", name: "Chanteur", group: "lyres", point: { x: 9, y: -9, z: 9 } } })) as Listed;
    expect(far.point).to.deep.equal({ x: 4.5, y: -0.5, z: 5.5 }); // bounded, never refused
    await run("target.engage", { id: "chant", on: true });
    // an edit of its design (name, heads, bounds) keeps it engaged: engaging is target.engage's
    const edited = (await run("target.put", { target: { id: "chant", name: "Chant", fixtures: ["spot"], engaged: false } })) as Listed;
    expect(edited.engaged).to.equal(true);
    expect(edited.point).to.deep.equal({ x: 4.5, y: -0.5, z: 5.5 });
    expect((await failure(run("target.put", { target: { id: "x", name: "X", fixtures: ["ghost"] } }))).message).to.match(/ghost/);
    expect((await failure(run("target.put", { target: { id: "x", name: "X", group: "ghost" } }))).message).to.match(/ghost/);
    // a fixture without pan or tilt cannot follow a point
    plugin.venue.fixtures.put({ id: "par", name: "Par", manufacturer: "Test", model: "Par RGB", mode: "3 Channel", universe: 1, address: 21 });
    expect((await failure(run("target.put", { target: { id: "x", name: "X", fixtures: ["par"] } }))).message).to.match(/« Par » n'est pas une lyre|“Par” is not a moving head/);
  });

  it("target.set takes nx past 0 or 1 (an OSC float) as its end; target.delete says the target was engaged", async () => {
    await run("target.put", { target: { id: "t", name: "T", group: "lyres", point: { x: 0, y: 2, z: 1 }, bounds: { min: { x: -2, y: 0, z: 0 }, max: { x: 2, y: 4, z: 4 } } } });
    expect(((await run("target.set", { id: "t", nx: 1.0000001 })) as Listed).point.x).to.equal(2);
    expect(((await run("target.set", { id: "t", nx: -0.02, nz: 1.5 })) as Listed).point).to.deep.equal({ x: -2, y: 2, z: 4 });
    await run("target.engage", { id: "t", on: true });
    expect(await run("target.delete", { id: "t" })).to.deep.equal({ deleted: true, engaged: true });
    await run("target.put", { target: { id: "u", name: "U", group: "lyres" } });
    expect(await run("target.delete", { id: "u" })).to.deep.equal({ deleted: true });
  });

  it("target.engage on a target already engaged puts it back on top", async () => {
    await run("target.put", { target: { id: "a", name: "A", fixtures: ["spot"] } });
    await run("target.put", { target: { id: "b", name: "B", fixtures: ["spot"] } });
    await run("target.engage", { id: "a", on: true });
    await run("target.engage", { id: "b", on: true });
    expect(await listed("a")).to.include({ priority: 2 });
    await run("target.engage", { id: "a", on: true });
    expect(await listed("a")).to.include({ priority: 1 });
    during(1200);
    expect(plugin.runtime.motionStatus().get("spot")!.pan.owner).to.equal("target:a");
  });

  it("look.put refuses a move following an unknown target; a proposal bounds a new target's point", async () => {
    const look = (target: string) => ({ look: { id: "suit", name: "Suit", canvas: "lyres", technique: { kind: "aucune" }, move: { shape: "fixe", at: { target } } } });
    expect((await failure(run("look.put", look("ghost")))).message).to.match(/cible inconnue : ghost|unknown target: ghost/);
    await run("target.put", { target: { id: "t", name: "T", group: "lyres" } });
    await run("look.put", look("t"));
    // a target deleted since (forced): the look stays editable, « Vérifier le show » says it
    await run("target.delete", { id: "t", force: true });
    await run("look.put", { look: { ...look("t").look, name: "Suit encore" } });
    const p = (await run("show.propose", { changes: [{ command: "target.put", args: { target: { id: "n", name: "N", group: "lyres", point: { x: 99, y: 0, z: 0 } } } }] })) as { id: string; valid: boolean };
    expect(p.valid).to.equal(true);
    await run("show.apply", { id: p.id });
    expect(plugin.runtime.targets.get("n")!.point).to.deep.equal({ x: 4.5, y: 0, z: 0 });
  });

  it("target.set moves the point in metres or 0..1 of its bounds, partially, and refuses x with nx", async () => {
    await run("target.put", { target: { id: "t", name: "T", group: "lyres", point: { x: 0, y: 2, z: 1 }, bounds: { min: { x: -2, y: 0, z: 0 }, max: { x: 2, y: 4, z: 4 } } } });
    expect(((await run("target.set", { id: "t", x: 1.5 })) as Listed).point).to.deep.equal({ x: 1.5, y: 2, z: 1 });
    expect(((await run("target.set", { id: "t", nx: 1, nz: 0.5 })) as Listed).point).to.deep.equal({ x: 2, y: 2, z: 2 });
    expect(((await run("target.set", { id: "t", y: 99 })) as Listed).point.y).to.equal(4);
    const both = await failure(run("target.set", { id: "t", x: 1, nx: 0.5 }));
    expect(both.message).to.match(/x et nx|x and nx/);
    expect((await failure(run("target.set", { id: "ghost", x: 0 }))).message).to.match(/ghost/);
    // a MIDI fader mapped on nx (levelArg) moves it across its bounds
    const mapper = new MidiMapper();
    mapper.setMappings([MappingSchema.parse({ id: "cc", input: { type: "cc", channel: 1, number: 7 }, on: { command: "target.set", args: { id: "t" } }, levelArg: "nx" })]);
    for (const call of mapper.handle(parseMidi([0xb0, 7, 127])).calls) await run(call.command, call.args);
    expect(plugin.runtime.targets.get("t")!.point.x).to.equal(2);
    for (const call of mapper.handle(parseMidi([0xb0, 7, 32])).calls) await run(call.command, call.args);
    expect(plugin.runtime.targets.get("t")!.point.x).to.be.closeTo(-2 + (4 * 32) / 127, 0.01);
  });

  it("target.engage makes the heads follow; target.list and position.list say who holds them, and who wins between two targets", async () => {
    await run("target.put", { target: { id: "a", name: "Cible A", group: "lyres", point: { x: -1, y: 1, z: 0 } } });
    await run("target.put", { target: { id: "b", name: "Cible B", fixtures: ["spot2"], point: { x: 1, y: 3, z: 0 } } });
    expect((await listed("a")).heads.map((h) => h.state)).to.deep.equal(["idle", "idle"]);
    expect(await run("target.engage", { id: "a", on: true })).to.deep.include({ id: "a", engaged: true, heads: ["spot", "spot2"] });
    during(1200);
    expect((await listed("a")).heads.map((h) => h.state)).to.deep.equal(["follows", "follows"]);
    await run("target.engage", { id: "b", on: true });
    during(1200);
    const a = await listed("a");
    expect(a.heads).to.deep.equal([{ id: "spot", name: "Spot", state: "follows" }, { id: "spot2", name: "Spot 2", state: "masked", by: "target:b", layer: "target" }]);
    expect(a).to.include({ priority: 2 });
    expect(a.sharesWith).to.deep.equal(["b"]);
    expect(await listed("b")).to.include({ priority: 1 });
    const heads = (await run("position.list")) as (HeadMotionEntry & { id: string })[];
    expect(heads.find((h) => h.id === "spot2")!.motion!.pan).to.include({ layer: "target", owner: "target:b", name: "Cible B" });
    expect(heads.find((h) => h.id === "spot2")!.motion!.masked).to.deep.equal([{ owner: "target:a", name: "Cible A" }]);
    // held: out of reach (straight above the hung heads)
    await run("target.set", { id: "b", x: 1, y: 2, z: 5.5 });
    during(100);
    const held = (await listed("b")).heads[0]!;
    expect(held).to.include({ state: "held" });
    expect(held.reason).to.match(/hors de portée|out of reach/);
    // « rendre la main » releases the target on its heads; target:<id> is said
    expect(await run("position.releaseTop", { fixtures: ["spot2"] })).to.deep.equal({ fixtures: [{ fixture: "spot2", released: ["target:b"] }] });
    during(100);
    expect((await listed("b")).heads[0]).to.include({ state: "released" });
    expect(await run("target.engage", { id: "b", on: false })).to.deep.include({ engaged: false });
  });

  it("target.zone puts the point on a zone, and refuses a closed no-aim zone", async () => {
    await run("target.put", { target: { id: "t", name: "T", group: "lyres", point: { x: 0, y: 1, z: 0 } } });
    await run("stage.zone.put", { zone: { id: "estrade", name: "Estrade", polygon: [[0, 2], [2, 2], [2, 4], [0, 4]], floorHeight: 0.4 } });
    expect(((await run("target.zone", { id: "t", zone: "estrade" })) as Listed).point).to.deep.equal({ x: 1, y: 3, z: 1.9 });
    expect(((await run("target.zone", { id: "t", zone: "estrade", height: 0 })) as Listed).point.z).to.equal(0.4);
    await run("stage.zone.put", { zone: { id: "pupitre", name: "Pupitre", polygon: [[-1, 0], [0, 0], [0, 1], [-1, 1]], noAim: true } });
    expect((await failure(run("target.zone", { id: "t", zone: "pupitre" }))).message).to.match(/Pupitre/);
    expect((await failure(run("target.zone", { id: "t", zone: "ghost" }))).message).to.match(/ghost/);
    // what is checked is the point once bounded: a zone beyond the bounds lands on their edge, here in the lectern
    await run("target.put", { target: { id: "b", name: "B", group: "lyres", point: { x: -1, y: 0.5, z: 0 }, bounds: { min: { x: -3, y: 0, z: 0 }, max: { x: -0.5, y: 3, z: 3 } } } });
    await run("stage.zone.put", { zone: { id: "jardin", name: "Jardin", polygon: [[1, 0], [3, 0], [3, 1], [1, 1]] } });
    expect((await failure(run("target.zone", { id: "b", zone: "jardin" }))).message).to.match(/Pupitre/);
    // and a no-aim zone whose centre, bounded, lands outside it is no refusal
    await run("stage.zone.put", { zone: { id: "loin", name: "Loin", polygon: [[2, 2], [3, 2], [3, 3], [2, 3]], noAim: true } });
    expect(((await run("target.zone", { id: "b", zone: "loin" })) as Listed).point).to.deep.equal({ x: -0.5, y: 2.5, z: 1.5 });
  });

  it("target.delete is refused while a look, a mapping, a snapshot or a song uses it, unless forced; a target uses its fixtures and group", async () => {
    await run("target.put", { target: { id: "t", name: "Chanteur", group: "lyres", fixtures: ["spot"] } });
    await run("look.put", { look: { id: "suit", name: "Suit", canvas: "lyres", technique: { kind: "aucune" }, move: { shape: "cercle", at: { target: "t" } } } });
    expect(((await run("show.references", { kind: "target", id: "t" })) as { uses: string[] }).uses).to.deep.equal(["look « Suit » (mouvement)"]);
    expect((await failure(run("target.delete", { id: "t" }))).message).to.match(/Suit/);
    // the target uses its fixture and its group
    expect(((await run("show.references", { kind: "fixture", id: "spot" })) as { uses: string[] }).uses).to.include("cible « Chanteur »");
    expect(((await run("show.references", { kind: "group", id: "lyres" })) as { uses: string[] }).uses).to.include("cible « Chanteur »");
    expect(await run("target.delete", { id: "t", force: true })).to.deep.equal({ deleted: true });
    expect(await run("target.delete", { id: "t", force: true })).to.deep.equal({ deleted: false });
  });

  it("references: a widget, a mapping, a snapshot and a song cue naming a target", () => {
    const parts: ShowParts = {
      groups: [],
      faders: [],
      mappings: [{ id: "m", label: "Pad", on: { command: "target.set", args: { id: "t" } } }],
      dashboards: [{ id: "d", name: "Live", widgets: [{ kind: "target", target: "t" }, { kind: "xy", target: "t" }] }],
      snapshots: [{ id: "s", name: "Fin", looks: [], groups: {}, faders: {}, targets: { t: {} } }],
      looks: [],
      targets: [{ id: "t", name: "T", fixtures: [] }],
      songs: [{ id: "c", title: "Chant", sections: [], cues: [{ command: "target.engage", args: { id: "t", on: true } }] }],
    };
    expect(usesOf("target", "t", parts)).to.deep.equal(["mapping MIDI « Pad »", "dashboard « Live »", "instantané « Fin »", "chant « Chant » (1 action de la piste)"]);
  });

  it("the Panic disengages every target, the heads stay where they are; its undo and a snapshot put them back", async () => {
    await run("target.put", { target: { id: "t", name: "T", group: "lyres", point: { x: 0, y: 1, z: 0 } } });
    await run("target.put", { target: { id: "u", name: "U", fixtures: ["spot"], point: { x: -2, y: 3, z: 0 } } });
    await run("target.engage", { id: "t", on: true });
    await run("target.engage", { id: "u", on: true });
    during(1200);
    await run("snapshot.save", { name: "Deux cibles", id: "deux" });
    const sent = plugin.runtime.sentPosition("spot")!;
    await run("panic");
    expect(plugin.runtime.targets.list().map((x) => x.engaged)).to.deep.equal([false, false]);
    during(1200);
    const after = plugin.runtime.sentPosition("spot")!;
    expect(after.pan).to.be.closeTo(sent.pan, 1e-4);
    expect(after.tilt).to.be.closeTo(sent.tilt, 1e-4);
    // the undo engages them again, in the order they had: u still wins spot
    await run("panic.undo");
    expect(plugin.runtime.targets.list().map((x) => x.engaged)).to.deep.equal([true, true]);
    during(1200);
    expect(plugin.runtime.motionStatus().get("spot")!.pan.owner).to.equal("target:u");
    // a snapshot: the point and engagement as saved, the targets it does not list disengaged
    await run("target.engage", { id: "u", on: false });
    await run("target.set", { id: "t", x: 2 });
    await run("target.put", { target: { id: "v", name: "V", fixtures: ["spot2"] } });
    await run("target.engage", { id: "v", on: true });
    await run("snapshot.recall", { id: "deux" });
    const now2 = Object.fromEntries(plugin.runtime.targets.list().map((x) => [x.id, { engaged: x.engaged, x: x.point.x }]));
    expect(now2).to.deep.equal({ t: { engaged: true, x: 0 }, u: { engaged: true, x: -2 }, v: { engaged: false, x: 0 } });
    expect(plugin.runtime.targets.get("u")!.engagedAt!).to.be.above(plugin.runtime.targets.get("t")!.engagedAt!);
  });

  it("a hard lock: the frozen heads ignore the target, listed in frozen; the rest follows", async () => {
    await run("target.put", { target: { id: "t", name: "T", group: "lyres" } });
    plugin.runtime.setMotionLock({ level: "off", heads: { spot: "hard" } });
    expect(await run("target.engage", { id: "t", on: true })).to.deep.include({ frozen: ["spot"] });
    expect(await run("target.set", { id: "t", x: 1 })).to.deep.include({ frozen: ["spot"] });
    during(1200);
    expect((await listed("t")).heads.map((h) => h.state)).to.deep.equal(["masked", "follows"]);
  });

  it("« Vérifier le show » names a look following a target gone, a target's unknown heads, and targets sharing heads", async () => {
    await run("target.put", { target: { id: "a", name: "A", group: "lyres" } });
    await run("target.put", { target: { id: "b", name: "B", fixtures: ["spot2"] } });
    // a look following a target gone (look.put refuses an unknown one: written as a force-deleted target leaves it)
    plugin.runtime.looks.put({ id: "suit", name: "Suit", canvas: "lyres", technique: { kind: "aucune" }, move: { shape: "fixe", at: { target: "ghost" } } } as never);
    plugin.runtime.targets.put({ id: "c", name: "C", fixtures: ["nobody"], point: { x: 0, y: 0, z: 0 } });
    const { issues } = (await run("show.lint")) as { issues: { level: string; where: string; message: string }[] };
    const about = (where: string) => issues.filter((i) => i.where === where).map((i) => `${i.level}: ${i.message}`);
    expect(about("look suit")).to.deep.include("erreur: cible inconnue ghost (mouvement) : ses lyres restent où elles sont");
    expect(about("cible c")).to.deep.equal(["erreur: projecteur inconnu nobody", "attention: « C » ne déplace aucune lyre installée"]);
    expect(about("cible a")).to.deep.equal(["info: « A » et « B » partagent Spot 2 : engagées ensemble, la dernière engagée les prend"]);
  });

  it("a version put back changes a target's design, not its point nor its engagement", async () => {
    await run("target.put", { target: { id: "t", name: "Avant", group: "lyres", point: { x: 1, y: 1, z: 1 } } });
    await run("target.put", { target: { id: "t", name: "Après", group: "lyres" } });
    await run("target.engage", { id: "t", on: true });
    await run("target.set", { id: "t", x: -1 });
    const versions = (await run("history.list", { collection: "targets", id: "t" })) as { stamp: string }[];
    expect(versions.length).to.be.above(0);
    await run("history.restore", { collection: "targets", id: "t", stamp: versions.at(-1)!.stamp });
    expect(plugin.runtime.targets.get("t")).to.deep.include({ name: "Avant", engaged: true, point: { x: -1, y: 1, z: 1 } });
  });

  it("a deleted look that followed a target deleted since comes back only once the target is restored first", async () => {
    await run("target.put", { target: { id: "t", name: "T", group: "lyres" } });
    await run("look.put", { look: { id: "suit", name: "Suit", canvas: "lyres", technique: { kind: "aucune" }, move: { shape: "fixe", at: { target: "t" } } } });
    await run("look.delete", { id: "suit", force: true });
    await run("target.delete", { id: "t", force: true });
    const look = ((await run("history.list", { collection: "looks", id: "suit" })) as { stamp: string }[])[0]!;
    expect((await failure(run("history.restore", { collection: "looks", id: "suit", stamp: look.stamp }))).message).to.match(/cible inconnue : t|unknown target: t/);
    const target = ((await run("history.list", { collection: "targets", id: "t" })) as { stamp: string }[])[0]!;
    await run("history.restore", { collection: "targets", id: "t", stamp: target.stamp });
    await run("history.restore", { collection: "looks", id: "suit", stamp: look.stamp });
    expect(plugin.runtime.looks.get("suit")!.move!.at).to.deep.equal({ target: "t" });
  });

  it("a proposal of target.put keeps the point and engagement, which are live", async () => {
    await run("target.put", { target: { id: "t", name: "T", group: "lyres", point: { x: 1, y: 1, z: 1 } } });
    await run("target.engage", { id: "t", on: true });
    const diff = (await run("show.diff", { command: "target.put", args: { target: { id: "t", name: "Chanteur", group: "lyres" } } })) as { valid: boolean; changes: { path: string }[] };
    expect(diff.valid).to.equal(true);
    expect(diff.changes.map((c) => c.path)).to.deep.equal(["name"]);
    const fresh = (await run("show.diff", { command: "target.put", args: { target: { id: "n", name: "N" } } })) as { valid: boolean; new: boolean };
    expect(fresh).to.include({ valid: true, new: true });
    const p = (await run("show.propose", { changes: [{ command: "target.put", args: { target: { id: "t", name: "Chanteur", group: "lyres" } } }] })) as { id: string };
    await run("show.apply", { id: p.id });
    expect(plugin.runtime.targets.get("t")).to.deep.include({ name: "Chanteur", engaged: true, point: { x: 1, y: 1, z: 1 } });
  });
});
