import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext, type CommandContext } from "../../../src/plugins/light/commands/registry.js";
import { usesOf, type ShowParts } from "../../../src/plugins/light/show/references.js";

/**
 * Named positions through their commands (T32, lot 2; docs/specs/venue-fixtures-stage.md, « Positions nommées »):
 * position.preset.save / .go / .list / .put / .refresh / .delete, a recall as a manual gesture that follows a
 * readjustment, « Rendre la main », the hard lock, a 3D point aimed head by head, staleness and its choices, the
 * references, the versions and a proposal.
 */
describe("named positions: the commands (T32)", () => {
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
  const sent = (id: string) => plugin.runtime.sentPosition(id)!;
  const layer = (id: string) => plugin.runtime.motionStatus().get(id)!.pan;
  type Listed = { id: string; name: string; kind: string; values: Record<string, { pan: number; tilt: number }>; point?: object; aim?: object; basis: Record<string, string>; covers: { id: string }[]; stale: string[]; missing: string[] };
  const listed = async (id: string) => ((await run("position.preset.list")) as Listed[]).find((p) => p.id === id)!;
  const failure = async (p: Promise<unknown>): Promise<Error & { code?: string; data?: unknown }> => {
    try {
      await p;
    } catch (e) {
      return e as Error & { code?: string };
    }
    throw new Error("expected a refusal");
  };
  const near = (a: { pan: number; tilt: number }, b: { pan: number; tilt: number }, eps = 0.01) => {
    expect(a.pan).to.be.closeTo(b.pan, eps);
    expect(a.tilt).to.be.closeTo(b.tilt, eps);
  };

  beforeEach(async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-presets-cmds-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    for (const f of ["spot.qxf", "par-rgb.qxf"]) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(dataRoot, "fixtures", f));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    now = 0;
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null, now: () => now });
    plugin.venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: -1, y: 2, z: 5 }, mount: "hung" });
    plugin.venue.fixtures.put({ id: "spot2", name: "Spot 2", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 11, position: { x: 1, y: 2, z: 5 }, mount: "hung" });
    plugin.venue.fixtures.put({ id: "par", name: "Par", manufacturer: "Test", model: "Par RGB", mode: "3 Channel", universe: 1, address: 21 });
    plugin.venue.canvases.put({ id: "lyres", name: "Lyres", topology: "line", cells: 2, render: [{ from: 0, to: 0, targets: [{ fixture: "spot", head: -1 }] }, { from: 1, to: 1, targets: [{ fixture: "spot2", head: -1 }] }] });
    plugin.runtime.groups.put({ id: "lyres", name: "Lyres", members: { fixtures: ["spot", "spot2"] } });
    during(100);
  });
  afterEach(async () => {
    await plugin.stop();
  });

  it("save captures the pad's position of one head, under an id made from its name; a second one gets its own id", async () => {
    await run("position.set", { fixtures: ["spot"], pan: 0.2, tilt: 0.7 });
    const saved = (await run("position.preset.save", { name: "Avant-scène", fixtures: ["spot"] })) as { position: Listed; captured: string[] };
    expect(saved.position.id).to.equal("avant-scene");
    expect(saved.position.kind).to.equal("pantilt");
    expect(saved.position.values).to.deep.equal({ spot: { pan: 0.2, tilt: 0.7 } });
    expect(saved.position.basis.spot).to.equal(plugin.runtime.positionBasis("spot"));
    expect(saved.captured).to.deep.equal(["spot"]);
    expect(saved.position.stale).to.deep.equal([]);
    const again = (await run("position.preset.save", { name: "Avant-scène", fixtures: ["spot"] })) as { position: Listed };
    expect(again.position.id).to.equal("avant-scene-2");
    expect((await failure(run("position.preset.save", { fixtures: ["spot"] }))).message).to.match(/nom|name/);
    // a fixture that is no moving head names no head to save
    expect((await failure(run("position.preset.save", { name: "X", fixtures: ["par"] }))).message).to.match(/aucune lyre|no installed/);
  });

  it("save captures what a look shows at that instant, for every head by default", async () => {
    await run("look.put", { look: { id: "fixe", name: "Fixe", canvas: "lyres", technique: { kind: "aucune" }, move: { shape: "fixe", center: { pan: 0.3, tilt: 0.6 }, fan: 0.1, fade: { seconds: 0 } } } });
    await run("look.go", { id: "fixe" });
    during(200);
    const saved = (await run("position.preset.save", { name: "Éventail" })) as { position: Listed };
    expect(Object.keys(saved.position.values)).to.deep.equal(["spot", "spot2"]);
    near(saved.position.values.spot!, { pan: 0.2, tilt: 0.6 }, 1e-9);
    near(saved.position.values.spot2!, { pan: 0.4, tilt: 0.6 }, 1e-9);
  });

  it("go recalls the covered heads only, gliding, as a manual gesture; a subset can be recalled; Rendre la main lets go", async () => {
    await run("position.set", { fixtures: ["spot"], pan: 0.2, tilt: 0.7 });
    during(100);
    await run("position.preset.save", { name: "Avant-scène", fixtures: ["spot"] });
    await run("position.release");
    during(1500);
    near(sent("spot"), { pan: 0.5, tilt: 0.5 });
    // the group asks for both heads: only the covered one moves, the other is said
    const res = (await run("position.preset.go", { id: "avant-scene", group: "lyres" })) as { fixtures: string[]; notCovered?: string[] };
    expect(res.fixtures).to.deep.equal(["spot"]);
    expect(res.notCovered).to.deep.equal(["spot2"]);
    during(200);
    // a glide over the show's moveFade (1 s), not a jump
    expect(layer("spot").layer).to.equal("manual");
    expect(layer("spot").moving).to.equal(true);
    expect(layer("spot2").layer).to.equal("rest");
    during(1000);
    near(sent("spot"), { pan: 0.2, tilt: 0.7 });
    expect(plugin.runtime.recalledPreset("spot")).to.equal("avant-scene");
    expect(await run("position.releaseTop", { fixtures: ["spot"] })).to.deep.equal({ fixtures: [{ fixture: "spot", released: ["manual"] }] });
    expect(plugin.runtime.recalledPreset("spot")).to.equal(undefined);
    during(1200);
    near(sent("spot"), { pan: 0.5, tilt: 0.5 });
    // asking only for an uncovered head recalls nothing
    expect((await failure(run("position.preset.go", { id: "avant-scene", fixtures: ["spot2"] }))).message).to.match(/ne couvre pas|does not cover/);
  });

  it("a recalled position followed by its heads moves them when readjusted, without a new recall; readjusting keeps the heads not given", async () => {
    await run("position.set", { fixtures: ["spot", "spot2"], pan: 0.2, tilt: 0.7 });
    during(100);
    await run("position.preset.save", { name: "Douche", id: "douche" });
    await run("position.release");
    await run("position.preset.go", { id: "douche" });
    during(1300);
    near(sent("spot2"), { pan: 0.2, tilt: 0.7 });
    // readjust spot only, from the pad: spot2 keeps its pan/tilt
    await run("position.set", { fixtures: ["spot"], pan: 0.6, tilt: 0.4 });
    during(100);
    const re = (await run("position.preset.save", { id: "douche", fixtures: ["spot"] })) as { position: Listed };
    expect(re.position.values).to.deep.equal({ spot: { pan: 0.6, tilt: 0.4 }, spot2: { pan: 0.2, tilt: 0.7 } });
    // spot2 still recalled: a value changed by a put moves it
    await run("position.preset.put", { position: { ...re.position, values: { ...re.position.values, spot2: { pan: 0.8, tilt: 0.3 } } } });
    during(1300);
    near(sent("spot2"), { pan: 0.8, tilt: 0.3 });
    // the pad over a recalled head takes it as a fixed position, the axis not given where the position put it
    await run("position.set", { fixtures: ["spot2"], pan: 0.5 });
    expect(plugin.runtime.recalledPreset("spot2")).to.equal(undefined);
    expect(plugin.runtime.manualPosition("spot2")).to.deep.equal({ pan: 0.5, tilt: 0.3 });
  });

  it("a hard-frozen head is left out of a recall, which is refused when all are", async () => {
    await run("position.set", { fixtures: ["spot", "spot2"], pan: 0.2, tilt: 0.7 });
    during(100);
    await run("position.preset.save", { name: "Douche", id: "douche" });
    await run("position.release");
    await run("motion.freeze", { fixtures: ["spot"], level: "hard" });
    expect(await run("position.preset.go", { id: "douche" })).to.deep.equal({ id: "douche", fixtures: ["spot2"], refused: ["spot"] });
    await run("motion.freeze", { fixtures: ["spot2"], level: "hard" });
    expect((await failure(run("position.preset.go", { id: "douche" }))).message).to.match(/figées|frozen/);
    // a soft lock lets the recall through: it is a manual gesture
    await run("motion.unfreeze", { to: "soft" });
    expect(((await run("position.preset.go", { id: "douche" })) as { fixtures: string[] }).fixtures).to.deep.equal(["spot", "spot2"]);
  });

  it("a 3D point is aimed head by head on every placed head, never stale; an unplaced head is said", async () => {
    plugin.venue.fixtures.put({ id: "spot3", name: "Spot 3", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 31 });
    during(40);
    const saved = (await run("position.preset.save", { name: "Pupitre", point: { x: 0, y: 2, z: 1.5 } })) as { position: Listed };
    expect(saved.position.kind).to.equal("point");
    expect(saved.position.values).to.deep.equal({});
    const res = (await run("position.preset.go", { id: "pupitre" })) as { fixtures: string[]; unreachable?: { fixture: string }[] };
    expect(res.fixtures).to.deep.equal(["spot", "spot2"]);
    expect(res.unreachable!.map((u) => u.fixture)).to.deep.equal(["spot3"]);
    during(1300);
    // both point at the point: aimNow from where they are gives where they went
    near(sent("spot"), plugin.runtime.aimNow("spot", { x: 0, y: 2, z: 1.5 }) as { pan: number; tilt: number });
    // moving the point (save with its id) moves the heads that hold it
    await run("position.preset.save", { id: "pupitre", point: { x: 0, y: 4, z: 0 } });
    during(1300);
    near(sent("spot2"), plugin.runtime.aimNow("spot2", { x: 0, y: 4, z: 0 }) as { pan: number; tilt: number });
    // a point never goes stale, and never changes kind
    plugin.venue.fixtures.put({ ...plugin.venue.fixtures.get("spot")!, position: { x: -2, y: 2, z: 5 } });
    expect((await listed("pupitre")).stale).to.deep.equal([]);
    expect((await failure(run("position.preset.save", { id: "pupitre", fixtures: ["spot"] }))).message).to.match(/point/);
    expect((await failure(run("position.preset.save", { id: "pupitre", point: { x: 0, y: 0, z: 0 }, fixtures: ["spot"] }))).message).to.match(/point/);
  });

  it("a moved or recalibrated head makes a pan/tilt position stale; recompute from its aim point, or keep it as it is", async () => {
    // saved by aiming the heads at a point: its aim is kept
    const aimed = (await run("position.preset.save", { name: "Chœur", point: { x: 0, y: 3, z: 1.5 }, pantilt: true })) as { position: Listed };
    expect(aimed.position.kind).to.equal("pantilt");
    expect(aimed.position.aim).to.deep.equal({ x: 0, y: 3, z: 1.5 });
    const before = aimed.position.values.spot!;
    await run("position.set", { fixtures: ["spot", "spot2"], pan: 0.3, tilt: 0.3 });
    during(100);
    await run("position.preset.save", { name: "Contre-plongée", id: "contre" });
    expect((await listed("contre")).aim).to.equal(undefined);
    // moved, then recalibrated
    plugin.venue.fixtures.put({ ...plugin.venue.fixtures.get("spot")!, position: { x: -2, y: 2, z: 5 } });
    plugin.venue.fixtures.put({ ...plugin.venue.fixtures.get("spot2")!, orientation: { yaw: 0, invertPan: false, invertTilt: false, swapPanTilt: false, panOffset: 4, tiltOffset: 0 } });
    expect((await listed(aimed.position.id)).stale).to.deep.equal(["spot", "spot2"]);
    expect((await listed("contre")).stale).to.deep.equal(["spot", "spot2"]);
    // recompute: aimed again at its point from the head's new place
    const re = (await run("position.preset.refresh", { id: aimed.position.id, how: "recompute", fixtures: ["spot"] })) as { position: Listed; refreshed: string[] };
    expect(re.refreshed).to.deep.equal(["spot"]);
    expect(re.position.values.spot).to.not.deep.equal(before);
    near(re.position.values.spot!, plugin.runtime.aimNow("spot", { x: 0, y: 3, z: 1.5 }, before) as { pan: number; tilt: number }, 1e-9);
    expect(re.position.stale).to.deep.equal(["spot2"]);
    // a position never aimed cannot be recomputed: the other two choices are said
    expect((await failure(run("position.preset.refresh", { id: "contre", how: "recompute" }))).message).to.match(/position.preset.save|how: keep/);
    // keep: the pan/tilt stay, the position is fresh again
    const kept = (await run("position.preset.refresh", { id: "contre", how: "keep" })) as { position: Listed; refreshed: string[] };
    expect(kept.refreshed).to.deep.equal(["spot", "spot2"]);
    expect(kept.position.values.spot).to.deep.equal({ pan: 0.3, tilt: 0.3 });
    expect(kept.position.stale).to.deep.equal([]);
    // a put that leaves basis out keeps it for an unchanged head and renews it for a changed one
    const put = (await run("position.preset.put", { position: { id: "contre", name: "Contre-plongée", values: { spot: { pan: 0.3, tilt: 0.3 }, spot2: { pan: 0.4, tilt: 0.3 } } } })) as Listed;
    expect(put.basis).to.deep.equal(kept.position.basis);
  });

  it("put refuses a fixture that is no moving head, values and a point together, and an unknown fixture", async () => {
    expect((await failure(run("position.preset.put", { position: { id: "x", name: "X", values: { par: { pan: 0.5, tilt: 0.5 } } } }))).message).to.match(/« Par » n'est pas une lyre|“Par” is not a moving head/);
    expect((await failure(run("position.preset.put", { position: { id: "x", name: "X", values: { ghost: { pan: 0.5, tilt: 0.5 } } } }))).message).to.match(/ghost/);
    await failure(run("position.preset.put", { position: { id: "x", name: "X", values: { spot: { pan: 0.5, tilt: 0.5 } }, point: { x: 0, y: 0, z: 0 } } }));
    expect(((await run("position.preset.put", { position: { id: "x", name: "X", values: { spot: { pan: 0.5, tilt: 0.5 } } } })) as Listed).basis).to.deep.equal({ spot: plugin.runtime.positionBasis("spot") });
  });

  it("delete is refused while a mapping or a song uses the position, unless forced; a fixture it covers cannot be deleted silently", async () => {
    await run("position.preset.put", { position: { id: "p", name: "Avant-scène", values: { spot: { pan: 0.2, tilt: 0.7 } } } });
    await run("midi.mapping.put", { mapping: { id: "m", label: "Pad 1", input: { type: "note", channel: 1, number: 36 }, on: { command: "position.preset.go", args: { id: "p" } } } });
    expect(((await run("show.references", { kind: "position", id: "p" })) as { uses: string[] }).uses).to.deep.equal(["mapping MIDI « Pad 1 »"]);
    expect((await failure(run("position.preset.delete", { id: "p" }))).message).to.match(/Pad 1/);
    // the position uses the fixture it covers
    expect(((await run("show.references", { kind: "fixture", id: "spot" })) as { uses: string[] }).uses).to.include("position nommée « Avant-scène »");
    expect((await failure(run("venue.fixture.delete", { id: "spot" }))).message).to.match(/Avant-scène/);
    expect(await run("position.preset.delete", { id: "p", force: true })).to.deep.equal({ deleted: true });
  });

  it("references: a widget, a mapping, a song cue and a look's move naming a position; a snapshot holds none", () => {
    const parts: ShowParts = {
      groups: [],
      faders: [],
      mappings: [{ id: "m", label: "Pad", on: { command: "position.preset.go", args: { id: "p" } } }],
      dashboards: [{ id: "d", name: "Live", widgets: [{ kind: "position", target: "p" }, { kind: "target", target: "p" }] }],
      snapshots: [{ id: "s", name: "Fin", looks: [], groups: {}, faders: {} }],
      looks: [{ id: "l", name: "Look", canvas: "c", move: { at: { position: "p" } } }],
      positions: [{ id: "p", name: "P", values: { spot: {} } }],
      songs: [{ id: "c", title: "Chant", sections: [], cues: [{ command: "position.preset.go", args: { id: "p" } }] }],
    };
    expect(usesOf("position", "p", parts)).to.deep.equal(["look « Look » (mouvement)", "mapping MIDI « Pad »", "dashboard « Live »", "chant « Chant » (1 action de la piste)"]);
    expect(usesOf("fixture", "spot", parts)).to.deep.equal(["position nommée « P »"]);
  });

  it("a position keeps its versions (history), a proposal shows what a put would change, a deleted recalled position holds its heads", async () => {
    await run("position.preset.put", { position: { id: "p", name: "Avant-scène", values: { spot: { pan: 0.2, tilt: 0.7 } } } });
    await run("position.preset.put", { position: { id: "p", name: "Avant-scène", values: { spot: { pan: 0.4, tilt: 0.7 } } } });
    const versions = (await run("history.list", { collection: "positions", id: "p" })) as { stamp: string }[];
    expect(versions.length).to.be.greaterThan(0);
    await run("history.restore", { collection: "positions", id: "p", stamp: versions.at(-1)!.stamp });
    expect((await listed("p")).values.spot).to.deep.equal({ pan: 0.2, tilt: 0.7 });
    const diff = (await run("show.diff", { command: "position.preset.put", args: { position: { id: "p", name: "Avant-scène", values: { spot: { pan: 0.25, tilt: 0.7 } } } } })) as { valid: boolean; changes: { path: string }[] };
    expect(diff.valid).to.equal(true);
    // only the pan changes: the basis follows the head, it is no noise in the proposal
    expect(diff.changes.map((c) => c.path)).to.deep.equal(["values.spot.pan"]);
    // recalled, then deleted: the head stays where it is and says why
    await run("position.preset.go", { id: "p" });
    during(1300);
    const at = sent("spot");
    await run("position.preset.delete", { id: "p" });
    during(200);
    near(sent("spot"), at);
    expect(layer("spot").error).to.match(/unknown position/);
    expect((await run("position.releaseTop", { fixtures: ["spot"] })) as object).to.deep.equal({ fixtures: [{ fixture: "spot", released: ["manual"] }] });
  });

  // ---- lot 6: a look following a named position (move.at.position), its errors and « Vérifier le show »
  type Issue = { level: string; where: string; message: string };
  const lint = async () => ((await run("show.lint")) as { issues: Issue[] }).issues;
  const follow = (id: string, position: string, move: object = {}) => run("look.put", { look: { id, name: id, canvas: "lyres", technique: { kind: "aucune" }, move: { shape: "fixe", at: { position }, fade: { seconds: 0 }, ...move } } });

  it("a look following a position places the heads it covers, read at render: readjusted, the look follows without a relaunch", async () => {
    await run("position.preset.put", { position: { id: "p", name: "Avant-scène", values: { spot: { pan: 0.2, tilt: 0.7 } } } });
    await follow("suit", "p");
    await run("look.go", { id: "suit" });
    during(100);
    near(sent("spot"), { pan: 0.2, tilt: 0.7 });
    expect(layer("spot")).to.include({ layer: "look", owner: "look:suit" });
    // spot2 is not covered: the layer below (its rest) keeps it
    expect(layer("spot2").layer).to.equal("rest");
    await run("position.preset.put", { position: { id: "p", name: "Avant-scène", values: { spot: { pan: 0.3, tilt: 0.6 }, spot2: { pan: 0.7, tilt: 0.6 } } } });
    during(100);
    near(sent("spot"), { pan: 0.3, tilt: 0.6 });
    near(sent("spot2"), { pan: 0.7, tilt: 0.6 });
    expect(layer("spot2")).to.include({ layer: "look", owner: "look:suit" });
    // a shape around it: drawn around each head's own position
    await follow("cercle", "p", { shape: "cercle", size: { pan: 0.05, tilt: 0.05 }, every: { seconds: 1 } });
    await run("look.go", { id: "cercle" });
    during(400);
    const s = layer("spot");
    expect(s.owner).to.equal("look:cercle");
    expect(Math.abs(s.position - 0.3)).to.be.at.most(0.051);
    // the position is used by the looks: its delete is refused, the references name them
    expect(((await run("show.references", { kind: "position", id: "p" })) as { uses: string[] }).uses).to.deep.equal(["look « suit » (mouvement)", "look « cercle » (mouvement)"]);
    expect((await failure(run("position.preset.delete", { id: "p" }))).message).to.match(/suit/);
  });

  it("a look following a point aims it head by head; recalled by hand over it, the manual layer wins", async () => {
    await run("position.preset.save", { name: "Pupitre", id: "pupitre", point: { x: 0, y: 3, z: 1.5 } });
    await follow("vise", "pupitre");
    await run("look.go", { id: "vise" });
    during(100);
    near(sent("spot"), plugin.runtime.aimNow("spot", { x: 0, y: 3, z: 1.5 }) as { pan: number; tilt: number });
    near(sent("spot2"), plugin.runtime.aimNow("spot2", { x: 0, y: 3, z: 1.5 }) as { pan: number; tilt: number });
    await run("position.preset.put", { position: { id: "q", name: "Q", values: { spot: { pan: 0.1, tilt: 0.1 } } } });
    await run("position.preset.go", { id: "q" });
    during(1300);
    expect(layer("spot").layer).to.equal("manual");
    near(sent("spot"), { pan: 0.1, tilt: 0.1 });
    // « Rendre la main » gives it back to the look, gliding
    await run("position.releaseTop", { fixtures: ["spot"] });
    during(1300);
    expect(layer("spot").owner).to.equal("look:vise");
  });

  it("look.put refuses an unknown position and a target with a position; a position deleted with force holds the heads and is said", async () => {
    expect((await failure(follow("x", "ghost"))).message).to.match(/position nommée inconnue : ghost|unknown named position: ghost/);
    await run("target.put", { target: { id: "t", name: "T", group: "lyres" } });
    await run("position.preset.put", { position: { id: "p", name: "P", values: { spot: { pan: 0.2, tilt: 0.7 }, spot2: { pan: 0.2, tilt: 0.7 } } } });
    expect((await failure(run("look.put", { look: { id: "x", name: "x", canvas: "lyres", technique: { kind: "aucune" }, move: { shape: "fixe", at: { target: "t", position: "p" } } } }))).message).to.match(/pas les deux|not both/);
    await follow("suit", "p");
    await run("look.go", { id: "suit" });
    during(100);
    const at = sent("spot");
    await run("position.preset.delete", { id: "p", force: true });
    during(200);
    near(sent("spot"), at);
    expect(plugin.runtime.lastErrors.some((e) => /position nommée inconnue : p|unknown named position: p/.test(e))).to.equal(true);
    expect((await lint()).filter((i) => i.where === "look suit").map((i) => i.level)).to.deep.equal(["erreur"]);
    // a look already following it stays editable (renamed), as for a target
    await run("look.put", { look: { id: "suit", name: "Suit 2", canvas: "lyres", technique: { kind: "aucune" }, move: { shape: "fixe", at: { position: "p" } } } });
  });

  it("« Vérifier le show » says the stale positions with their choices, uncovered heads of a look, a mapping and a fixture gone", async () => {
    await run("position.preset.save", { name: "Chœur", id: "choeur", point: { x: 0, y: 3, z: 1.5 }, pantilt: true });
    await run("position.preset.put", { position: { id: "solo", name: "Solo", values: { spot: { pan: 0.2, tilt: 0.7 } } } });
    await follow("suit", "solo");
    await run("midi.mapping.put", { mapping: { id: "m", label: "Pad", input: { type: "note", channel: 1, number: 36 }, on: { command: "position.preset.go", args: { id: "ghost" } } } });
    expect((await lint()).filter((i) => i.where.startsWith("position ") || i.where === "look suit" || i.where === "mapping m")).to.deep.equal([
      { level: "erreur", where: "mapping m", message: "position nommée inconnue ghost" },
      { level: "info", where: "look suit", message: "la position « Solo » ne couvre pas Spot 2 : ces lyres restent à la couche du dessous" },
    ]);
    plugin.venue.fixtures.put({ ...plugin.venue.fixtures.get("spot")!, position: { x: -2, y: 2, z: 5 } });
    const stale = (await lint()).filter((i) => i.where.startsWith("position "));
    expect(stale.map((i) => [i.where, i.level])).to.deep.equal([
      ["position choeur", "attention"],
      ["position solo", "attention"],
    ]);
    // with an aim point the three choices are said, without one the two others
    expect(stale[0]!.message).to.match(/recalculer.*how: recompute.*à la main.*position.preset.save.*telle quelle.*how: keep/);
    expect(stale[1]!.message).to.not.match(/recalculer/);
    expect(stale[1]!.message).to.match(/à la main.*telle quelle/);
    await run("position.preset.refresh", { id: "solo", how: "keep" });
    await run("position.preset.refresh", { id: "choeur", how: "recompute" });
    expect((await lint()).filter((i) => i.where.startsWith("position "))).to.deep.equal([]);
    // a covered fixture deleted with force: said, ignored by a recall
    await run("venue.fixture.delete", { id: "spot", force: true });
    expect((await lint()).filter((i) => i.where === "position solo").map((i) => i.message)).to.deep.equal(["« Solo » couvre des projecteurs qui ne sont plus dans le patch (spot) : ignorés au rappel", "« Solo » ne couvre aucune lyre installée"]);
    expect((await failure(run("position.preset.go", { id: "solo" }))).message).to.match(/rien à rappeler|nothing to recall/);
  });

  it("a show that names no position in use sends the same bytes with positions saved", async () => {
    await run("look.put", { look: { id: "c", name: "C", canvas: "lyres", technique: { kind: "aucune" }, move: { shape: "cercle", every: { seconds: 2 } } } });
    await run("look.go", { id: "c" });
    const bytes = () => {
      const buf = new Uint8Array(512);
      plugin.runtime.render([buf]);
      return [...buf.slice(0, 30)];
    };
    during(300);
    const before = [bytes(), bytes()];
    await run("position.preset.put", { position: { id: "p", name: "P", values: { spot: { pan: 0.2, tilt: 0.7 } } } });
    await run("position.preset.save", { name: "Point", point: { x: 0, y: 3, z: 1.5 } });
    expect([bytes(), bytes()]).to.deep.equal(before);
  });
});
