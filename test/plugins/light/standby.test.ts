import { expect } from "chai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

describe("starting on standby (switchover with QLC+)", () => {
  const make = (stored: Record<string, unknown>, standby?: boolean) => {
    let saved: Record<string, unknown> | undefined;
    const cfg = { discovery: false, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } }, ...stored };
    const plugin = new LightPlugin({
      eventBus: new EventBus(),
      config: { get: () => cfg, set: async (c: unknown) => void (saved = c as Record<string, unknown>) },
      dataRoot: join(mkdtempSync(join(tmpdir(), "light-standby-")), "data"),
      midiNative: null,
      standby,
    });
    return { plugin, saved: () => saved as { output: { standby: boolean } } | undefined };
  };

  it("keeps the standby saved in the config across restarts", () => {
    const { plugin } = make({ output: { routes: [{ universe: 1, artnet: { portAddress: 0 } }], standby: true } });
    expect(plugin.router.isStandby()).to.equal(true);
    expect(plugin.state().standby).to.equal(true);
  });

  it("lets the command line force standby or live, and saves it", async () => {
    const { plugin, saved } = make({}, true);
    expect(plugin.router.isStandby()).to.equal(true);
    await plugin.start();
    await plugin.stop();
    expect(saved()!.output.standby).to.equal(true);
    const live = make({ output: { routes: [], standby: true } }, false);
    expect(live.plugin.router.isStandby()).to.equal(false);
  });

  it("leaves the controllers' LEDs to QLC+ on standby, and takes them all back with the output", async () => {
    const { plugin } = make({ output: { routes: [], standby: false } });
    const sent: number[][][] = [];
    (plugin as unknown as { hub: { sendFeedback: (m: number[][]) => void } }).hub.sendFeedback = (m) => void sent.push(m);
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("group.put", { group: { id: "g", name: "G", master: { level: 1 } } });
    await run("midi.mapping.put", { mapping: { id: "fader", input: { type: "cc", channel: 1, number: 7 }, on: { command: "group.level", args: { id: "g" } }, levelArg: "level", feedback: "cc" } });
    await run("midi.mapping.put", { mapping: { id: "mute", input: { type: "note", channel: 1, number: 40 }, on: { command: "group.mute", args: { id: "g", mute: true } }, feedback: "note" } });
    await run("output.standby", { on: true });
    sent.length = 0;
    await run("group.level", { id: "g", level: 0.5 });
    expect(sent).to.deep.equal([]); // silent on standby
    await run("output.standby", { on: false });
    const resync = sent.filter((m) => m.length > 0);
    expect(resync).to.have.length(1);
    expect(resync[0]).to.deep.include.members([[0xb0, 7, 64]]); // current level included
    expect(resync[0]!.length).to.equal(2); // every mapping, not just the changes
  });
});
