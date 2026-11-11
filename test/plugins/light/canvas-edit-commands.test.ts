import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import type { CommandError} from "../../../src/plugins/light/commands/registry.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

/**
 * venue.canvas.edit, the checks of venue.canvas.put and the canvases' versions (T13). The synthetic
 * import gives a canvas « qlc » of 8 cells (two 4-head bars, bar-0 then bar-1) and five looks of exact
 * steps on it, one column per cell.
 */
describe("canvas commands: edit, checked put, versions", () => {
  let plugin: LightPlugin;
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  const tick = () => new Promise((r) => setTimeout(r, 5)); // one history entry per millisecond stamp
  const canvas = () => plugin.runtime.venue.canvases.get("qlc")!;
  const rowsOf = (id: string) => {
    const t = plugin.runtime.looks.get(id)!.technique;
    return t.kind === "pas" ? t.steps : [];
  };
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => expect.fail("refused expected"),
      (e: unknown) => e as CommandError,
    );
  type Edit = { canvas: { cells: number }; revision: string; impact: { shifted: boolean; looksAffected: { id: string; reason: string }[] }; adaptable: { id: string; rows: number; before: string[][]; after: string[][] }[]; adapted: string[]; warnings?: string[] };

  let cfg: Record<string, unknown>;
  beforeEach(async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-canvas-edit-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async (c) => void (cfg = c as Record<string, unknown>) }, dataRoot, midiNative: null });
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
  });

  it("previews an edit (dryRun) without writing it, and gives the canvas's revision with no operation", async () => {
    const before = JSON.stringify(canvas());
    const looks = JSON.stringify(plugin.runtime.looks.list());
    const preview = (await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "remove", cells: [0] }], dryRun: true })) as Edit & { dryRun: boolean };
    expect(preview.dryRun).to.equal(true);
    expect(preview.canvas.cells).to.equal(7);
    expect(preview.impact.looksAffected.map((l) => l.id).sort()).to.deep.equal(["breath", "checker", "hole", "masks", "palette"]);
    expect(preview.adaptable.find((a) => a.id === "checker")!.after[0]).to.deep.equal(rowsOf("checker")[0]!.slice(1));
    expect(JSON.stringify(canvas())).to.equal(before);
    expect(JSON.stringify(plugin.runtime.looks.list())).to.equal(looks);
    const same = (await run("venue.canvas.edit", { id: "qlc", ops: [], dryRun: true })) as Edit;
    expect(same.revision).to.match(/^[0-9a-f]{12}$/);
    expect(same.impact).to.deep.include({ shifted: false, looksAffected: [] });
  });

  it("refuses an edit that shifts looks of exact steps, naming them; force writes it and « Vérifier le show » says it", async () => {
    const e = await refusal(run("venue.canvas.edit", { id: "qlc", ops: [{ op: "move", cells: [7], to: 0 }] }));
    expect(e.message).to.contain("Canevas « Import QLC+ »").and.contain("force: true").and.contain("adapt: true");
    expect((e.detail as { broken: string[] }).broken.sort()).to.deep.equal(["breath", "checker", "hole", "masks", "palette"]);
    expect(canvas().render[0]!.targets[0]).to.deep.equal({ fixture: "bar-0", head: 0 }); // nothing written
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "remove", cells: [7] }], force: true });
    expect(canvas().cells).to.equal(7);
    expect(rowsOf("checker")[0]).to.have.length(8); // left as it was
    const lint = (await run("show.lint")) as { issues: { level: string; where: string; message: string }[] };
    expect(lint.issues).to.deep.include({ level: "attention", where: "look checker", message: "pas de longueur 8 sur un canevas de 7 cellules (« Import QLC+ ») : les colonnes en trop sont ignorées, les cellules sans colonne restent non touchées" });
    // and the looks still play
    for (const l of plugin.runtime.looks.list()) expect(plugin.runtime.stepsOf(l).every((s) => s.length === 7)).to.equal(true);
  });

  it("adapts the steps of the looks it breaks (all, or those named), each column following its cell", async () => {
    const before = rowsOf("checker");
    const done = (await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "remove", cells: [1] }, { op: "move", cells: [6], to: 0 }], adapt: true })) as Edit;
    expect(done.adapted.sort()).to.deep.equal(["breath", "checker", "hole", "masks", "palette"]);
    // cells now: old 7, 0, 2, 3, 4, 5, 6
    expect(rowsOf("checker")[0]).to.deep.equal([7, 0, 2, 3, 4, 5, 6].map((i) => before[0]![i]!));
    for (const l of plugin.runtime.looks.list()) for (const row of rowsOf(l.id)) expect(row).to.have.length(canvas().cells);
    // only some named: the others still refuse
    const e = await refusal(run("venue.canvas.edit", { id: "qlc", ops: [{ op: "reverse" }], adapt: ["checker"] }));
    expect((e.detail as { broken: string[] }).broken).to.include("hole");
    expect((e.detail as { broken: string[] }).broken).to.not.include("checker");
    // a look of exact steps can be taken back by its versions: adapting kept one
    expect(((await run("history.list", { collection: "looks", id: "checker" })) as unknown[]).length).to.be.greaterThan(0);
  });

  it("property: an edit without force never leaves a look of exact steps out of line", async () => {
    const tries: unknown[][] = [[{ op: "remove", cells: [3] }], [{ op: "add", fixtures: ["bar-0"], heads: [1] }], [{ op: "move", cells: [0, 4], to: 8 }], [{ op: "duplicate", cells: [2] }], [{ op: "reverse", from: 2, to: 5 }], [{ op: "retarget", cells: [0], targets: [{ fixture: "bar-1", head: 0 }] }], [{ op: "set", name: "Mur" }]];
    for (const ops of tries) {
      await run("venue.canvas.edit", { id: "qlc", ops }).catch(() => undefined);
      await run("venue.canvas.edit", { id: "qlc", ops, adapt: ["hole"] }).catch(() => undefined);
      for (const l of plugin.runtime.looks.list()) for (const row of rowsOf(l.id)) expect(row, JSON.stringify(ops)).to.have.length(canvas().cells);
    }
    // the retarget and the rename went through without asking
    expect(canvas().name).to.equal("Mur");
    expect(canvas().render[0]!.targets[0]).to.deep.equal({ fixture: "bar-1", head: 0 });
  });

  it("checks fixtures and heads, and refuses a canvas changed since its revision", async () => {
    expect((await refusal(run("venue.canvas.edit", { id: "qlc", ops: [{ op: "add", fixtures: ["ghost"] }] }))).message).to.contain("projecteur inconnu : ghost");
    expect((await refusal(run("venue.canvas.edit", { id: "qlc", ops: [{ op: "retarget", cells: [0], targets: [{ fixture: "bar-0", head: 9 }] }] }))).message).to.contain("pas de tête 9");
    expect((await refusal(run("venue.canvas.edit", { id: "nope", ops: [] }))).message).to.contain("canevas inconnu");
    const { revision } = (await run("venue.canvas.edit", { id: "qlc", ops: [], dryRun: true })) as Edit;
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "set", notes: "ailleurs" }] });
    const stale = await refusal(run("venue.canvas.edit", { id: "qlc", ops: [{ op: "set", name: "X" }], revision }));
    expect(stale.message).to.contain("a changé ailleurs");
    expect((stale.detail as { stale: boolean }).stale).to.equal(true);
  });

  it("lets a generated look play on a canvas whose cell count changed, and says it changes proportion", async () => {
    await run("look.put", { look: { id: "wave", name: "Vague", canvas: "qlc", technique: { kind: "onde", colors: ["#ff0000"] } } });
    await run("look.put", { look: { id: "flat", name: "Plat", canvas: "qlc", technique: { kind: "plat", color: "#ff0000" } } });
    const done = (await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "add", fixtures: ["bar-1"] }], adapt: true })) as Edit;
    expect(done.impact.looksAffected.filter((l) => l.reason === "cells").map((l) => l.id)).to.deep.equal(["wave"]);
    expect(canvas().cells).to.equal(12);
    expect(plugin.runtime.stepsOf(plugin.runtime.looks.get("wave")!)[0]).to.have.length(12);
    await run("look.go", { id: "wave" });
  });

  it("checks a put over an existing canvas by its cell count (force), warns of what it names wrong, never checks a new one", async () => {
    const c = canvas();
    const e = await refusal(run("venue.canvas.put", { canvas: { ...c, cells: 6, render: c.render.slice(0, 6) } }));
    expect(e.message).to.contain("ne seraient plus en face");
    await run("venue.canvas.put", { canvas: { ...c, name: "Renommé" } }); // same count: no question
    // auto over an existing canvas is a put too
    expect((await refusal(run("venue.canvas.auto", { id: "qlc", name: "Q", fixtures: ["bar-0"] }))).message).to.contain("force: true");
    const forced = (await run("venue.canvas.put", { canvas: { ...c, cells: 6, render: c.render.slice(0, 6) }, force: true })) as { cells: number };
    expect(forced.cells).to.equal(6);
    const fresh = (await run("venue.canvas.put", { canvas: { id: "neuf", name: "Neuf", cells: 2, render: [{ from: 0, to: 2, targets: [{ fixture: "ghost", head: -1 }] }] } })) as { warnings: string[] };
    expect(fresh.warnings).to.deep.equal(["plage 0–2 au-delà des 2 cellules", "projecteur absent du patch : ghost"]);
  });

  it("keeps the canvases' versions: list, restore (checked, force), undo from the activity, a deleted canvas comes back", async () => {
    await tick();
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "set", name: "Mur" }] });
    expect(((await run("history.list", { collection: "canvases", id: "qlc" })) as unknown[]).length).to.equal(1);
    // undo from the activity line of the rename
    type Line = { name: string; target?: string; at: number; until: number; undo?: { collection: string; id: string } };
    const line = ((await run("activity.list")) as Line[]).find((l) => l.name === "venue.canvas.edit" && l.undo)!;
    expect(line.undo).to.deep.equal({ collection: "canvases", id: "qlc" });
    await run("history.undo", { ...line.undo, at: line.at, until: line.until });
    expect(canvas().name).to.equal("Import QLC+");
    await tick();
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "remove", cells: [0] }], adapt: true });
    expect(canvas().cells).to.equal(7);
    // back to 8 cells: the looks were adapted to 7, a restore is refused without force
    const [before] = (await run("history.list", { collection: "canvases", id: "qlc" })) as { stamp: string }[];
    const e = await refusal(run("history.restore", { collection: "canvases", id: "qlc", stamp: before!.stamp }));
    expect(e.message).to.contain("ne seraient plus en face");
    await run("history.restore", { collection: "canvases", id: "qlc", stamp: before!.stamp, force: true });
    expect(canvas().cells).to.equal(8);
    // deleted (T37), then back
    await run("venue.canvas.delete", { id: "qlc", force: true });
    const gone = (await run("history.deleted", { collection: "canvases" })) as { id: string; stamp: string }[];
    expect(gone.map((g) => g.id)).to.deep.equal(["qlc"]);
    await run("history.restore", { collection: "canvases", id: "qlc", stamp: gone[0]!.stamp });
    expect(canvas()).to.not.equal(undefined);
  });

  it("holds an edit in a proposal: previewed field by field, applied all or nothing, taken back", async () => {
    await run("venue.canvas.put", { canvas: { id: "free", name: "Libre", cells: 2, render: [{ from: 0, to: 1, targets: [{ fixture: "bar-0", head: -1 }] }] } });
    const p = (await run("show.propose", { changes: [{ command: "venue.canvas.edit", args: { id: "free", ops: [{ op: "add", fixtures: ["bar-1"], heads: [0] }] } }] })) as { valid: boolean; id: string; preview: { changes: { path: string }[] }[] };
    expect(p.valid).to.equal(true);
    expect(p.preview[0]!.changes.map((c) => c.path)).to.include("cells");
    expect(plugin.runtime.venue.canvases.get("free")!.cells).to.equal(2);
    await run("show.apply", { id: p.id });
    expect(plugin.runtime.venue.canvases.get("free")!.cells).to.equal(3);
    await run("show.revert", { id: p.id });
    expect(plugin.runtime.venue.canvases.get("free")!.cells).to.equal(2);
    // invalid operations, or adapting steps: an invalid proposal
    const bad = (await run("show.propose", { changes: [{ command: "venue.canvas.edit", args: { id: "free", ops: [{ op: "remove", cells: [9] }] } }] })) as { valid: boolean };
    expect(bad.valid).to.equal(false);
    const adapt = (await run("show.propose", { changes: [{ command: "venue.canvas.edit", args: { id: "free", ops: [], adapt: true } }] })) as { valid: boolean; preview: { issues: string[] }[] };
    expect(adapt.valid).to.equal(false);
    expect(adapt.preview[0]!.issues[0]).to.contain("n'adapte pas les pas");
  });

  it("refuses to move cells of a venue shared with other shows unless forced, naming them", async () => {
    await run("show.create", { name: "Concert" }); // shares the venue, and is open: it has no look on the canvas
    const e = await refusal(run("venue.canvas.edit", { id: "qlc", ops: [{ op: "remove", cells: [0] }] }));
    expect(e.message).to.contain("partagé avec d'autres shows").and.contain("shared: true");
    // knowing it is shared lets it through, without forcing anything else
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "duplicate", cells: [0] }], shared: true });
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "remove", cells: [1] }], shared: true });
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "set", name: "Partagé" }] }); // nothing moves: no question
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "remove", cells: [0] }], force: true });
    expect(canvas().cells).to.equal(7);
  });

  it("reads a canvas and its revision without a trace, and a dry run publishes nothing either", async () => {
    const heard: string[] = [];
    const off = plugin.commands.onCommand((e) => heard.push(e.name));
    const got = (await run("venue.canvas.get", { id: "qlc" })) as { canvas: { cells: number }; revision: string };
    const dry = (await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "remove", cells: [0] }], dryRun: true })) as Edit;
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "remove", cells: [99] }], dryRun: true }).catch(() => undefined);
    expect(heard).to.deep.equal([]);
    expect(got.canvas.cells).to.equal(8);
    expect(dry.revision).to.not.equal(got.revision);
    expect(((await refusal(run("venue.canvas.get", { id: "nope" }))).detail as { unknown: string }).unknown).to.equal("canvas");
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "set", notes: "x" }] });
    expect(heard).to.deep.equal(["venue.canvas.edit"]);
    off();
  });

  it("adapts all the looks or none: one that no longer passes its checks refuses the edit before the first write", async () => {
    // a mask read cell by cell, never cut: a cell added would be off in it
    await run("look.put", { look: { id: "zz-mask", name: "Masque", canvas: "qlc", noCut: true, technique: { kind: "masques", colors: ["#ff0000", "#0000ff"], block: 1, masks: ["########"], floor: 0 } } });
    const looks = JSON.stringify(plugin.runtime.looks.list());
    const before = JSON.stringify(canvas());
    const e = await refusal(run("venue.canvas.edit", { id: "qlc", ops: [{ op: "add", fixtures: ["bar-0"], heads: [0] }], adapt: true }));
    expect(e.message).to.contain("« Masque » (zz-mask)").and.contain("jamais coupé");
    expect(JSON.stringify(plugin.runtime.looks.list())).to.equal(looks);
    expect(JSON.stringify(canvas())).to.equal(before);
    // a removal keeps it lit: the mask follows its cells with the steps of the others
    const done = (await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "remove", cells: [0] }], adapt: true })) as Edit & { steps: Record<string, { before: unknown; after: unknown }> };
    expect(done.adapted).to.include("zz-mask");
    expect(done.steps["zz-mask"]).to.deep.equal({ before: ["########"], after: ["#######"] });
    const t = plugin.runtime.looks.get("zz-mask")!.technique;
    expect(t.kind === "masques" && t.masks).to.deep.equal(["#######"]);
  });

  it("refuses a put that reorders as many cells, naming the looks; their steps given with it are written together or not at all", async () => {
    const c = canvas();
    const swapped = { ...c, render: [c.render[1]!, c.render[0]!, ...c.render.slice(2)].map((r, i) => ({ ...r, from: i, to: i })) };
    const e = await refusal(run("venue.canvas.put", { canvas: swapped }));
    expect(e.message).to.contain("« ").and.contain("steps").and.not.contain("adapt: true)  ");
    expect((e.detail as { broken: string[] }).broken.sort()).to.deep.equal(["breath", "checker", "hole", "masks", "palette"]);
    // one cell aimed elsewhere moves nothing: no question
    await run("venue.canvas.put", { canvas: { ...c, render: [{ ...c.render[0]!, targets: [{ fixture: "bar-1", head: 3 }] }, ...c.render.slice(1)] } });
    await run("venue.canvas.put", { canvas: c });
    const swap = (rows: string[][]) => rows.map((r) => [r[1]!, r[0]!, ...r.slice(2)]);
    const ids = ["breath", "checker", "hole", "masks", "palette"];
    const steps = Object.fromEntries(ids.map((i) => [i, swap(rowsOf(i))]));
    const was = JSON.stringify(plugin.runtime.looks.list());
    // a row of the wrong width in the last look: nothing is written, not even the first looks
    const bad = await refusal(run("venue.canvas.put", { canvas: swapped, steps: { ...steps, palette: [["#ff0000"]] } }));
    expect(bad.message).to.contain("8 colonne(s)");
    expect(JSON.stringify(plugin.runtime.looks.list())).to.equal(was);
    expect(canvas().render[0]!.targets[0]).to.deep.equal({ fixture: "bar-0", head: 0 });
    // some looks left out: still refused, naming those
    const some = await refusal(run("venue.canvas.put", { canvas: swapped, steps: { checker: steps.checker } }));
    expect((some.detail as { broken: string[] }).broken).to.not.include("checker");
    // a look renamed meanwhile keeps its name: only its steps are put
    await run("look.put", { look: { ...plugin.runtime.looks.get("checker")!, name: "Renommé" } });
    await run("venue.canvas.put", { canvas: swapped, steps });
    expect(plugin.runtime.looks.get("checker")!.name).to.equal("Renommé");
    expect(rowsOf("checker")).to.deep.equal(steps.checker);
    expect(canvas().render[0]!.targets[0]).to.deep.equal({ fixture: "bar-0", head: 1 });
  });

  it("refuses a put on a revision that is no longer the canvas's, and never brings a deleted canvas back", async () => {
    const { canvas: c, revision } = (await run("venue.canvas.get", { id: "qlc" })) as { canvas: Record<string, unknown>; revision: string };
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "set", notes: "ailleurs" }] });
    expect(((await refusal(run("venue.canvas.put", { canvas: c, revision }))).detail as { stale: boolean }).stale).to.equal(true);
    await run("venue.canvas.delete", { id: "qlc", force: true });
    expect(((await refusal(run("venue.canvas.put", { canvas: c, revision }))).detail as { unknown: string }).unknown).to.equal("canvas");
    expect(plugin.runtime.venue.canvases.get("qlc")).to.equal(undefined);
  });

  it("says at once what a proposed edit would break; a forced one carries its impact; a dry run is no proposal", async () => {
    const args = { id: "qlc", ops: [{ op: "move", cells: [7], to: 0 }] };
    type Proposal = { valid: boolean; id: string; preview: { issues?: string[]; impact?: { looksAffected: { id: string }[] } }[] };
    const plain = (await run("show.propose", { changes: [{ command: "venue.canvas.edit", args }] })) as Proposal;
    expect(plain.valid).to.equal(false);
    expect(plain.preview[0]!.issues![0]).to.contain("ne seraient plus en face");
    const dry = (await run("show.propose", { changes: [{ command: "venue.canvas.edit", args: { ...args, dryRun: true } }] })) as Proposal;
    expect(dry.preview[0]!.issues![0]).to.contain("dryRun");
    const forced = (await run("show.propose", { changes: [{ command: "venue.canvas.edit", args: { ...args, force: true } }] })) as Proposal;
    expect(forced.valid).to.equal(true);
    expect(forced.preview[0]!.impact!.looksAffected.map((l) => l.id).sort()).to.deep.equal(["breath", "checker", "hole", "masks", "palette"]);
  });

  it("takes a proposal back only if every canvas can go back: checked before the first object", async () => {
    await run("look.put", { look: { id: "zz-other", name: "Avant", canvas: "qlc", technique: { kind: "plat", color: "#ff0000" } } });
    const p = (await run("show.propose", {
      changes: [
        { command: "look.put", args: { look: { id: "zz-other", name: "Après", canvas: "qlc", technique: { kind: "plat", color: "#00ff00" } } } },
        { command: "venue.canvas.edit", args: { id: "qlc", ops: [{ op: "reverse" }], force: true } },
      ],
    })) as { id: string };
    await run("show.apply", { id: p.id });
    const e = await refusal(run("show.revert", { id: p.id }));
    expect(e.message).to.contain("ne seraient plus en face");
    expect(plugin.runtime.looks.get("zz-other")!.name).to.equal("Après"); // the canvas comes first in the take-back, yet nothing went back
    expect(canvas().render[0]!.targets[0]).to.deep.equal({ fixture: "bar-1", head: 3 });
    await run("show.revert", { id: p.id, force: true });
    expect(plugin.runtime.looks.get("zz-other")!.name).to.equal("Avant");
    expect(canvas().render[0]!.targets[0]).to.deep.equal({ fixture: "bar-0", head: 0 });
  });

  it("refuses a proposal that carries steps with a canvas: no preview would show them, no take-back would put them back", async () => {
    const c = canvas();
    const p = (await run("show.propose", { changes: [{ command: "venue.canvas.put", args: { canvas: { ...c, name: "Mur" }, steps: { checker: rowsOf("checker") } } }] })) as { valid: boolean; preview: { issues: string[] }[] };
    expect(p.valid).to.equal(false);
    expect(p.preview[0]!.issues[0]).to.contain("steps");
    // without steps it is a proposal like any other, and an edit is pinned to the canvas it was shown on
    const ok = (await run("show.propose", { changes: [{ command: "venue.canvas.edit", args: { id: "qlc", ops: [{ op: "set", name: "Mur" }] } }] })) as { valid: boolean; id: string };
    expect(ok.valid).to.equal(true);
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "set", notes: "entre-temps" }] });
    expect((await refusal(run("show.apply", { id: ok.id }))).message).to.contain("a changé ailleurs");
    expect(canvas().name).to.equal("Import QLC+");
  });

  it("undoes an adapted edit from its activity line: the canvas and the steps it adapted go back together, without forcing", async () => {
    const before = rowsOf("checker");
    await tick();
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "remove", cells: [0] }], adapt: true });
    expect(rowsOf("checker")[0]).to.have.length(7);
    type Line = { name: string; at: number; until: number; undo?: { collection: string; id: string } };
    const lines = (await run("activity.list")) as Line[];
    expect(lines.filter((l) => l.name === "look.put")).to.deep.equal([]); // one line for the gesture, none per look
    const line = lines.find((l) => l.name === "venue.canvas.edit" && l.undo)!;
    await run("history.undo", { ...line.undo, at: line.at, until: line.until });
    expect(canvas().cells).to.equal(8);
    expect(rowsOf("checker")).to.deep.equal(before);
    for (const l of plugin.runtime.looks.list()) for (const row of rowsOf(l.id)) expect(row).to.have.length(8);
  });

  it("says in each refusal only what its command takes, and what a mirrored mask needs", async () => {
    const c = canvas();
    await tick();
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "reverse" }], adapt: true });
    const [version] = (await run("history.list", { collection: "canvases", id: "qlc" })) as { stamp: string }[];
    const restore = await refusal(run("history.restore", { collection: "canvases", id: "qlc", stamp: version!.stamp }));
    expect(restore.message).to.contain("force: true").and.not.contain("steps").and.not.contain("adapt");
    await run("venue.canvas.put", { canvas: c, force: true });
    // a mask read over half the canvas cannot follow its cells: adapting the others still leaves it, and says so
    await run("look.put", { look: { id: "zz-mirror", name: "Miroir", canvas: "qlc", mirror: true, technique: { kind: "masques", colors: ["#ff0000", "#0000ff"], block: 1, masks: ["#-#-"] } } });
    const e = await refusal(run("venue.canvas.edit", { id: "qlc", ops: [{ op: "reverse" }], adapt: true }));
    expect(e.message).to.contain("« Miroir » ne peut pas suivre ses cases").and.not.contain("adapt: true");
    expect(e.detail as { broken: string[]; adaptable: unknown[] }).to.deep.include({ broken: ["zz-mirror"], adaptable: [] });
    // adapting the others and forcing that one, in one write
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "reverse" }], adapt: true, force: true });
    expect(rowsOf("checker")[0]).to.deep.equal([...rowsOf("checker")[0]!]);
    expect(canvas().render[0]!.targets[0]).to.deep.equal({ fixture: "bar-1", head: 3 });
    // on a shared venue, a restore and a take-back take `shared` as an edit does
    await run("show.create", { name: "Concert" });
    const shared = await refusal(run("history.restore", { collection: "canvases", id: "qlc", stamp: version!.stamp }));
    expect(shared.message).to.contain("shared: true");
    await run("history.restore", { collection: "canvases", id: "qlc", stamp: version!.stamp, shared: true });
    expect(canvas().render[0]!.targets[0]).to.deep.equal({ fixture: "bar-0", head: 0 });
  });

  it("puts the looks back when the canvas cannot be written, and gives a put's revision", async () => {
    const looks = JSON.stringify(plugin.runtime.looks.list());
    const store = plugin.runtime.venue.canvases;
    const put = store.put.bind(store);
    store.put = () => {
      throw new Error("disque plein");
    };
    try {
      expect((await refusal(run("venue.canvas.edit", { id: "qlc", ops: [{ op: "remove", cells: [0] }], adapt: true }))).message).to.contain("disque plein");
    } finally {
      store.put = put;
    }
    expect(JSON.stringify(plugin.runtime.looks.list())).to.equal(looks);
    expect(canvas().cells).to.equal(8);
    const done = (await run("venue.canvas.put", { canvas: { ...canvas(), name: "Mur" } })) as { revision: string };
    expect(done.revision).to.equal(((await run("venue.canvas.get", { id: "qlc" })) as { revision: string }).revision);
  });

  it("refuses a proposal that changes one canvas twice: the second would be read on a canvas the first has changed", async () => {
    const edit = (ops: unknown[]) => ({ command: "venue.canvas.edit", args: { id: "qlc", ops } });
    const p = (await run("show.propose", { changes: [edit([{ op: "set", name: "Mur" }]), edit([{ op: "set", notes: "n" }])] })) as { valid: boolean; preview: { valid: boolean; issues?: string[] }[] };
    expect(p.valid).to.equal(false);
    expect(p.preview.map((x) => x.valid)).to.deep.equal([true, false]);
    expect(p.preview[1]!.issues![0]).to.contain("un seul changement par canevas");
    const mixed = (await run("show.propose", { changes: [{ command: "venue.canvas.put", args: { canvas: { ...canvas(), name: "Mur" } } }, edit([{ op: "set", notes: "n" }])] })) as { valid: boolean };
    expect(mixed.valid).to.equal(false);
    // grouped in one edit, it applies
    const one = (await run("show.propose", { changes: [edit([{ op: "set", name: "Mur" }, { op: "set", notes: "n" }])] })) as { valid: boolean; id: string };
    await run("show.apply", { id: one.id });
    expect(canvas()).to.include({ name: "Mur", notes: "n" });
  });

  it("undoing a change that moved no cell leaves alone the steps a look got in the same seconds", async () => {
    await tick();
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "set", name: "Mur" }] });
    const typed = rowsOf("checker").map((r) => r.map(() => "#123456"));
    const look = plugin.runtime.looks.get("checker")!;
    await run("look.put", { look: { ...look, technique: { ...look.technique, steps: typed } } });
    type Line = { name: string; at: number; until: number; collection?: string; undo?: { collection: string; id: string } };
    const line = ((await run("activity.list")) as Line[]).find((l) => l.name === "venue.canvas.edit" && l.undo)!;
    await run("history.undo", { ...line.undo, at: line.at, until: line.until });
    expect(canvas().name).to.equal("Import QLC+");
    expect(rowsOf("checker")).to.deep.equal(typed);
    // the undo's own line can be undone in turn: the name comes back
    await tick();
    const undone = ((await run("activity.list")) as Line[]).find((l) => l.name === "history.undo")!;
    expect(undone.undo).to.deep.equal({ collection: "canvases", id: "qlc" });
    await run("history.undo", { ...undone.undo, at: undone.at, until: undone.until });
    expect(canvas().name).to.equal("Mur");
    // a look put back by its versions keeps the line of its put command: the restore's own line offers no second undo
    const [v] = (await run("history.list", { collection: "looks", id: "checker" })) as { stamp: string }[];
    await run("history.restore", { collection: "looks", id: "checker", stamp: v!.stamp });
    expect(((await run("activity.list")) as Line[]).find((l) => l.name === "history.restore")!.undo).to.equal(undefined);
  });
});
