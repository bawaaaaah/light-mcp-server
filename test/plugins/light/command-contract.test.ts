import { expect } from "chai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZodObject, ZodRawShape } from "zod";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { HINTS, toolHints } from "../../../src/plugins/light/commands/tool-hints.js";

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

  describe("MCP tool annotations", () => {
    it("declares all four hints, as booleans, on every tool", () => {
      for (const c of commands) {
        const h = toolHints(c);
        for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) expect(h[k], `${c.name} ${k}`).to.be.a("boolean");
      }
    });

    it("classifies every command that writes (a new one must be added to HINTS)", () => {
      expect(commands.filter((c) => !c.readOnly && !(c.name in HINTS)).map((c) => c.name)).to.deep.equal([]);
    });

    it("lists no command that does not exist (a renamed or removed one leaves a stale line)", () => {
      const names = new Set(commands.map((c) => c.name));
      expect(Object.keys(HINTS).filter((n) => !names.has(n))).to.deep.equal([]);
    });

    it("never calls a read-only command destructive, and always idempotent", () => {
      for (const c of commands.filter((x) => x.readOnly)) expect(toolHints(c), c.name).to.include({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    });

    it("keeps the claims consistent: a delete is destructive, a step or a counter is not idempotent", () => {
      for (const c of commands.filter((x) => /\.delete$/.test(x.name))) expect(toolHints(c).destructiveHint, c.name).to.equal(true);
      for (const name of ["look.go", "look.stop", "group.level", "tempo.set", "panic"]) expect(toolHints({ name }).idempotentHint, name).to.equal(true);
      for (const name of ["setlist.next", "song.prev", "tempo.tap", "backup.create"]) expect(toolHints({ name }).idempotentHint, name).to.equal(false);
    });

    it("says what the handlers really do: relative or restarting is not idempotent, an overwrite without versions is destructive", () => {
      // `turn` adds to the heading, `create` makes a new group each time, a play rewinds, notes are stamped
      for (const name of ["venue.fixture.orient", "look.exclusive", "song.play", "notes.set", "ableset.jump", "history.undo", "live.adjust"]) expect(toolHints({ name }).idempotentHint, name).to.equal(false);
      // looks, groups, faders and dashboards keep versions; the rest is replaced for good
      for (const name of ["look.put", "group.put", "fader.put", "dashboard.put"]) expect(toolHints({ name }).destructiveHint, name).to.equal(false);
      for (const name of ["venue.fixture.put", "venue.canvas.put", "stage.zone.put", "rule.put", "palette.put", "program.put", "midi.mapping.put", "song.put", "setlist.put", "notes.set", "calibration.solve", "midi.profile.save"])
        expect(toolHints({ name }).destructiveHint, name).to.equal(true);
    });

    it("marks open world what talks to the network, devices or another program", () => {
      for (const name of ["tempo.set", "midi.profile.save", "midi.profile.select", "midi.learn", "output.route", "ableset.jump", "nodes.discover", "selftest.run"]) expect(toolHints({ name }).openWorldHint, name).to.equal(true);
      for (const name of ["look.go", "dmx.set", "blackout", "panic", "group.level"]) expect(toolHints({ name }).openWorldHint, name).to.equal(false);
    });

    it("treats a writer nobody classified as destructive and not idempotent", () => {
      expect(toolHints({ name: "future.command" })).to.deep.equal({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
    });

    it("reaches the wire: the SDK sees the four hints on a registered tool", async () => {
      const tools: Record<string, { annotations?: Record<string, unknown> }> = {};
      const server = { registerResource: () => undefined, registerPrompt: () => undefined, registerTool: (name: string, def: { annotations?: Record<string, unknown> }) => void (tools[name] = def) };
      plugin.registerTools(server as never);
      expect(Object.keys(tools)).to.have.length(commands.length);
      for (const [name, def] of Object.entries(tools)) expect(Object.keys(def.annotations ?? {}).sort(), name).to.deep.equal(["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"]);
      expect(tools.light_look_delete!.annotations).to.deep.equal({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
      expect(tools.light_nodes_discover!.annotations).to.deep.equal({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    });
  });
});
