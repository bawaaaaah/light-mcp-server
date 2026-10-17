import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

describe("live touch-ups by AI", () => {
  it("only while the desk allows it, by small steps, never a look kept for a human hand", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-live-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    const ai = (args: unknown) => plugin.commands.invoke("live.adjust", args, { origin: "mcp", who: "Claude", can: () => true }) as Promise<{ done: string[]; playing: string[] }>;
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    await run("group.put", { group: { id: "face", name: "Face", members: { fixtures: ["bar-0"], looks: [], groups: [] }, master: { level: 0.5, mute: false } } });
    let refused = "";
    await ai({ dca: { id: "face", delta: 0.1 } }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("IA en live désactivée");
    await run("show.settings.set", { liveAi: true });
    const up = await ai({ dca: { id: "face", delta: 0.2 } });
    expect(up.done).to.deep.equal(["Face 50 → 70 %"]);
    await ai({ dca: { id: "face", level: 0.1 } }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("pas plus de 25 %"); // a jump, not a touch-up
    expect(plugin.runtime.groups.get("face")!.master!.level).to.be.closeTo(0.7, 1e-9);
    const look = plugin.runtime.looks.get("hole")!;
    await run("look.put", { look: { ...look, id: "eclairs", name: "Éclairs", danger: true } });
    await ai({ go: "eclairs" }).catch((e: Error) => (refused = e.message));
    expect(refused).to.contain("réservé à la main");
    const started = await ai({ go: "hole" });
    expect(started.playing).to.include("hole");
    expect(((await run("activity.list")) as { name: string; who?: string }[]).some((l) => l.name === "live.adjust" && l.who === "Claude")).to.equal(true);
  });
});
