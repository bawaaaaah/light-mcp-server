import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { overlapMessage, patchOverlaps, type PatchedRange } from "../../../src/plugins/light/venue/patch-check.js";

const r = (id: string, address: number, channels: number, universe = 1, kind = "par|5ch"): PatchedRange => ({ id, name: id.toUpperCase(), universe, address, channels, kind });

describe("patch check: overlapping DMX channels", () => {
  it("finds partial overlaps, not neighbours, other universes or twins", () => {
    const found = patchOverlaps([r("a", 1, 5), r("b", 6, 5), r("c", 9, 5), r("d", 9, 5, 2), r("e", 20, 5), r("f", 20, 5), r("g", 20, 7, 1, "bar|7ch")]);
    expect(found.map((o) => [o.a, o.b, o.from, o.to])).to.deep.equal([
      ["b", "c", 9, 10],
      ["e", "g", 20, 24],
      ["f", "g", 20, 24],
    ]);
    expect(overlapMessage(found[0]!, (id) => id.toUpperCase())).to.equal("« B » et « C » partagent U1.9–1.10");
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
    expect(await run("venue.patch.check")).to.deep.equal({ overlaps: [] }); // bars at 1 and 16, 15 channels each
    const put = (await run("venue.fixture.put", { fixture: { id: "extra", name: "Extra", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 10 } })) as { warning?: string };
    expect(put.warning).to.contain("partagent U1.10–1.15").and.to.contain("« Extra »");
    const lint = (await run("show.lint")) as { issues: { where: string; message: string }[] };
    expect(lint.issues.filter((i) => i.message.includes("mêmes canaux"))).to.have.length(2); // with each bar
  });
});
