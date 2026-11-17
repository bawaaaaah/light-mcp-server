import { expect } from "chai";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

describe("midi.learn: the next message as a mapping input", () => {
  const plugin = (): LightPlugin => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-learn-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, os2l: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    return new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
  };
  /** Starts learning, plays the bytes, and gives what was learnt. */
  const learn = async (bytes: number[]): Promise<unknown> => {
    const p = plugin();
    const run = (name: string, args: unknown = {}) => p.commands.invoke(name, args, systemContext());
    const learnt = run("midi.learn", { timeoutMs: 2000 });
    await run("midi.in", { port: "Web MIDI · test", bytes });
    return learnt;
  };

  it("learns a pitch bend as the channel's wheel: number 0, whatever its value", async () => {
    expect(await learn([0xe2, 0x00, 0x7f])).to.deep.equal({ input: { type: "pitchbend", channel: 3, number: 0, port: "Web MIDI · test" } });
  });

  it("still learns a note, a CC and a program change with their number", async () => {
    expect(await learn([0x90, 50, 100])).to.deep.equal({ input: { type: "note", channel: 1, number: 50, port: "Web MIDI · test" } });
    expect(await learn([0xb1, 7, 64])).to.deep.equal({ input: { type: "cc", channel: 2, number: 7, port: "Web MIDI · test" } });
    expect(await learn([0xc0, 5])).to.deep.equal({ input: { type: "programchange", channel: 1, number: 5, port: "Web MIDI · test" } });
  });
});
