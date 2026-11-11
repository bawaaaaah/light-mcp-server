import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import {
  beyondMessage,
  gapsByUniverse,
  gapsMessage,
  missingPositions,
  overlapMessage,
  patchBeyondUniverse,
  patchGaps,
  patchOverlaps,
  sameModelNameMessage,
  sameModelSameName,
  type PatchedLook,
  type PatchedRange,
} from "../../../src/plugins/light/venue/patch-check.js";

const r = (id: string, address: number, channels: number, universe = 1, kind = "par|5ch"): PatchedRange => ({ id, name: id.toUpperCase(), universe, address, channels, kind });

describe("patch check: end of universe, gaps, names, positions", () => {
  const look = (id: string, over: Partial<PatchedLook> = {}): PatchedLook => ({ id, name: id, model: "Acme Par", moving: false, hasPosition: false, placed: false, ...over });

  it("warns of a fixture ending past channel 512, not of one ending on it", () => {
    const found = patchBeyondUniverse([r("a", 500, 13), r("b", 510, 5), r("d", 1, 600)]); // a ends on 512
    expect(found).to.deep.equal([
      { id: "b", universe: 1, address: 510, last: 514 },
      { id: "d", universe: 1, address: 1, last: 600 },
    ]);
    expect(beyondMessage(found[0]!, (id) => id.toUpperCase())).to.contain("« B »").and.to.contain("514").and.to.contain("2 dernier(s)");
  });

  it("finds the free channels between two fixtures, not before the first, after the last or inside a wider one", () => {
    const gaps = patchGaps([r("a", 1, 10), r("inside", 3, 2), r("b", 11, 5), r("c", 31, 5), r("d", 40, 1), r("e", 100, 5, 2)]);
    expect(gaps).to.deep.equal([
      { universe: 1, from: 16, to: 30, after: "b", before: "c" },
      { universe: 1, from: 36, to: 39, after: "c", before: "d" },
    ]);
    // one line per universe
    const lines = gapsByUniverse([...gaps, { universe: 2, from: 3, to: 3, after: "x", before: "y" }]);
    expect(lines.map((l) => l.length)).to.deep.equal([2, 1]);
    const line = gapsMessage(lines[0]!, (id) => id.toUpperCase());
    expect(line).to.match(/^U1 : 16–30 libre\(s\) entre « B » et « C », 36–39 libre\(s\) entre « C » et « D » \(19 canal\(aux\)\)/);
    expect(gapsMessage(lines[1]!, (id) => id)).to.contain("U2 : 3 libre(s)");
  });

  it("says no gap after a fixture whose channel count is unknown (no definition)", () => {
    const unknown = { ...r("nodef", 11, 1), unknown: true as const };
    expect(patchGaps([r("a", 1, 10), unknown, r("b", 30, 5)])).to.deep.equal([]);
    // nor after a wider one holding it, its end being unknown too
    expect(patchGaps([r("a", 1, 10), { ...r("nodef", 3, 1), unknown: true as const }, r("b", 30, 5)])).to.deep.equal([]);
  });

  it("names fixtures of one model sharing a name, not two models with one name", () => {
    const same = sameModelSameName([look("a", { name: "Spot" }), look("b", { name: " spot " }), look("c", { name: "Spot", model: "Other Spot" }), look("d", { name: "Spot cour" })]);
    expect(same).to.deep.equal([{ model: "Acme Par", name: "Spot", ids: ["a", "b"] }]);
    expect(sameModelNameMessage(same[0]!)).to.contain("2 projecteurs « Acme Par » s'appellent « Spot »");
  });

  it("asks a position of a moving head or a fixture placed on the stage, never of a plain PAR", () => {
    const missing = missingPositions([look("par"), look("head", { moving: true }), look("placed-head", { moving: true, hasPosition: true }), look("floor", { placed: true })]);
    expect(missing).to.deep.equal([
      { id: "head", moving: true },
      { id: "floor", moving: false },
    ]);
  });
});

describe("patch check: overlapping DMX channels", () => {
  it("finds partial overlaps, not neighbours, other universes or twins", () => {
    const found = patchOverlaps([r("a", 1, 5), r("b", 6, 5), r("c", 9, 5), r("d", 9, 5, 2), r("e", 20, 5), r("f", 20, 5), r("g", 20, 7, 1, "bar|7ch")]);
    expect(found.map((o) => [o.a, o.b, o.from, o.to])).to.deep.equal([
      ["b", "c", 9, 10],
      ["e", "g", 20, 24],
      ["f", "g", 20, 24],
    ]);
    expect(overlapMessage(found[0]!, (id) => id.toUpperCase())).to.equal("« B » et « C » partagent U1.9–10");
    expect(overlapMessage({ a: "x", b: "y", universe: 2, from: 3, to: 3 }, (id) => id)).to.equal("« x » et « y » partagent U2.3");
  });

  it("warns when patching onto used channels, and the show check says so", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-patch-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    expect(await run("venue.patch.check")).to.deep.equal({
      overlaps: [],
      beyondUniverse: [],
      missingDefinitions: [],
      duplicateDefinitions: { sameName: [], sameSignature: [] },
      info: { gaps: [], sameNames: [], noPosition: [] },
    }); // bars at 1 and 16, 15 channels each
    const put = (await run("venue.fixture.put", { fixture: { id: "extra", name: "Extra", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 10 } })) as { warning?: string };
    expect(put.warning).to.contain("partagent U1.10–15").and.to.contain("« Extra »");
    const lint = (await run("show.lint")) as { issues: { where: string; message: string }[] };
    expect(lint.issues.filter((i) => i.message.includes("mêmes canaux"))).to.have.length(2); // with each bar
    // past the end of the universe: said when patching, a warning in the show check
    const late = (await run("venue.fixture.put", { fixture: { id: "late", name: "Late", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 505 } })) as { warning?: string };
    expect(late.warning).to.contain("finit au canal 519");
    const again = (await run("show.lint")) as { issues: { level: string; where: string; message: string }[] };
    expect(again.issues.find((i) => i.message.includes("519"))!.level).to.equal("attention");
    // the gap before it is information only
    expect(again.issues.find((i) => i.message.includes("libre(s)"))!.level).to.equal("info");
    const check = (await run("venue.patch.check")) as { beyondUniverse: { id: string }[]; info: { gaps: { universe: number; gaps: { from: number; to: number }[] }[] } };
    expect(check.beyondUniverse.map((b) => b.id)).to.deep.equal(["late"]);
    expect(check.info.gaps.map((l) => [l.universe, l.gaps.map((g) => [g.from, g.to])])).to.deep.equal([[1, [[31, 504]]]]);
    // an absent fixture keeps its place: no gap where it stands
    await run("venue.fixture.put", { fixture: { id: "away", name: "Away", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 31 } });
    await run("venue.fixture.presence", { fixtures: ["away"], present: false });
    const after = (await run("venue.patch.check")) as { info: { gaps: { gaps: { from: number; to: number }[] }[] } };
    expect(after.info.gaps.flatMap((l) => l.gaps.map((g) => [g.from, g.to]))).to.deep.equal([[46, 504]]);
  });

  it("names the fixtures without a definition, once per model in the show check", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-patch-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    for (const [id, address] of [["fog-a", 100], ["fog-b", 110]] as const) await run("venue.fixture.put", { fixture: { id, name: id, manufacturer: "Acme", model: "Fog", mode: "Full", universe: 1, address } });
    const check = (await run("venue.patch.check")) as { missingDefinitions: { id: string; model: string }[] };
    expect(check.missingDefinitions.map((m) => m.id)).to.deep.equal(["fog-a", "fog-b"]);
    const lint = (await run("show.lint")) as { issues: { where: string; message: string }[] };
    const missing = lint.issues.filter((i) => i.message.startsWith("définition manquante"));
    expect(missing).to.have.length(1);
    expect(missing[0]!.where).to.equal("projecteur fog-a, fog-b");
  });
});
