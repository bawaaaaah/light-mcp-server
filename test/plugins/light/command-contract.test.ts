import { expect } from "chai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZodObject, ZodRawShape } from "zod";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";

/**
 * « Read-only » is a promise to AI clients (MCP readOnlyHint: some run such tools without asking)
 * and it silences the change events the pages refresh on. A command that can write must not make it.
 */
describe("command contract", () => {
  const plugin = new LightPlugin({ eventBus: new EventBus(), dataRoot: join(mkdtempSync(join(tmpdir(), "light-contract-")), "data"), midiNative: null });
  const commands = plugin.commands.list();

  it("never flags as read-only a command that can write (apply / save)", () => {
    const writers = commands.filter((c) => {
      const shape = (c.schema as unknown as ZodObject<ZodRawShape>).shape ?? {};
      return "apply" in shape || "save" in shape;
    });
    expect(writers.length).to.be.above(4);
    expect(writers.filter((c) => c.readOnly).map((c) => c.name)).to.deep.equal([]);
  });

  it("never flags as read-only what plays the show or injects MIDI", () => {
    for (const name of ["selftest.run", "midi.in", "look.go", "panic", "output.standby"]) expect(plugin.commands.get(name)?.readOnly, name).to.not.equal(true);
  });
});
