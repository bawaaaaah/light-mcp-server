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
    expect(e.message).to.contain("partagé avec d'autres shows").and.contain("force: true");
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "set", name: "Partagé" }] }); // nothing moves: no question
    await run("venue.canvas.edit", { id: "qlc", ops: [{ op: "remove", cells: [0] }], force: true });
    expect(canvas().cells).to.equal(7);
  });
});
