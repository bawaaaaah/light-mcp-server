import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { build, newMapping, type MappingDraft } from "../../../web/src/mappingActions.js";

/**
 * « Figer les lyres » played from MIDI (T26; docs/specs/rules-limits.md, « Verrou des lyres »): the mappings the editor
 * builds for the action « Figer / défiger les lyres », pressed through the real path (midi.in → hub → mapper →
 * commands, origin midi), and their state kept in step with the lock whoever changed it.
 */
describe("motion lock from a MIDI mapping (T26)", () => {
  let plugin: LightPlugin;
  const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, os2l: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  const lock = () => plugin.runtime.motionLockState();
  const map = async (mode: MappingDraft["mode"], input: MappingDraft["input"] = { type: "note", channel: 1, number: 40 }, target = "") => {
    const mapping = { ...build({ ...newMapping(), mode, input }, "freeze", target), id: `freeze-${mode}` };
    await run("midi.mapping.put", { mapping });
    return mapping;
  };
  /** Sends the bytes and waits until the commands they started are done (the journal fills them in). */
  const send = async (...messages: number[][]) => {
    for (const bytes of messages) {
      const before = ((await run("midi.journal")) as unknown[]).length;
      await run("midi.in", { port: "Web MIDI · test", bytes });
      for (let i = 0; i < 50; i++) {
        const journal = (await run("midi.journal")) as { calls: unknown[]; ms: number }[];
        if (journal.length > before && journal[0]!.ms > 0) break;
        await new Promise((r) => setTimeout(r, 5));
      }
    }
  };
  const press = [0x90, 40, 100];
  const release = [0x80, 40, 0];

  beforeEach(() => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-lock-midi-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), join(dataRoot, "fixtures", "spot.qxf"));
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    plugin.venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: 0, y: 2, z: 5 }, mount: "hung" });
    plugin.venue.fixtures.put({ id: "spot2", name: "Spot 2", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 11, position: { x: 1, y: 2, z: 5 }, mount: "hung" });
    plugin.runtime.groups.put({ id: "left", name: "Left", members: { fixtures: ["spot"], looks: [], groups: [] } } as never);
  });
  afterEach(async () => {
    await plugin.stop();
  });

  it("builds freeze on and unfreeze off in toggle, latch and momentary; a toggle only for a note in trigger, never a CC", () => {
    const note = { type: "note" as const, channel: 1, number: 40 };
    const cc = { type: "cc" as const, channel: 1, number: 20 };
    for (const mode of ["toggle", "latch", "momentary"] as const) {
      const m = build({ ...newMapping(), mode, input: note }, "freeze", "left");
      expect(m.on, mode).to.deep.equal({ command: "motion.freeze", args: { group: "left" } });
      expect(m.off, mode).to.deep.equal({ command: "motion.unfreeze", args: { group: "left" } });
    }
    expect(build({ ...newMapping(), mode: "trigger", input: note }, "freeze", "")).to.deep.include({ on: { command: "motion.freeze", args: { toggle: true } }, off: undefined });
    expect(build({ ...newMapping(), mode: "trigger", input: cc }, "freeze", "")).to.deep.include({ on: { command: "motion.freeze", args: {} }, off: undefined });
    // a mapping written by hand keeps its fixtures and its level
    const hand = { ...newMapping(), mode: "latch" as const, on: { command: "motion.freeze", args: { fixtures: ["spot"], level: "hard" } } };
    expect(build(hand, "freeze", "")).to.deep.include({ on: { command: "motion.freeze", args: { fixtures: ["spot"], level: "hard" } }, off: { command: "motion.unfreeze", args: { fixtures: ["spot"] } } });
  });

  it("toggle: every press switches, from MIDI", async () => {
    await map("toggle");
    await send(press, release);
    expect(lock().level).to.equal("soft");
    await send(press, release);
    expect(lock().level).to.equal("off");
    await send(press, release);
    expect(lock().level).to.equal("soft");
  });

  it("momentary: frozen while held", async () => {
    await map("momentary");
    await send(press);
    expect(lock().level).to.equal("soft");
    await send(release);
    expect(lock().level).to.equal("off");
  });

  it("trigger on a note: each press switches (the server's toggle)", async () => {
    await map("trigger");
    await send(press, release, press);
    expect(lock().level).to.equal("off");
    await send(press);
    expect(lock().level).to.equal("soft");
  });

  it("follows the lock changed elsewhere: after the interface unfreezes, the next press freezes again", async () => {
    await map("latch");
    await send(press);
    expect(lock().level).to.equal("soft");
    await run("motion.unfreeze");
    await send(press);
    expect(lock().level).to.equal("soft");
    // frozen from the interface: the next press unfreezes
    await run("motion.unfreeze");
    await run("motion.freeze");
    await send(press);
    expect(lock().level).to.equal("off");
  });

  it("a hard lock stays hard from MIDI (decision V1), and the mapping keeps in step with it", async () => {
    await map("latch");
    await run("motion.freeze", { level: "hard" });
    await send(press); // refused: the lock is hard
    expect(lock().level).to.equal("hard");
    await send(press); // still in step: unfreeze asked again, refused again
    expect(lock().level).to.equal("hard");
    const journal = (await run("midi.journal")) as { calls: { command: string; ok: boolean; error?: string }[] }[];
    expect(journal[0]!.calls[0]).to.deep.include({ command: "motion.unfreeze", ok: false });
    expect(journal[0]!.calls[0]!.error).to.match(/interface/);
  });

  it("a mixed lock: one head hard alone, every press still does something (decision V1)", async () => {
    for (const mode of ["trigger", "latch", "toggle"] as const) {
      await run("motion.unfreeze");
      const mapping = await map(mode);
      await run("motion.freeze", { fixtures: ["spot"], level: "hard" }); // from the interface
      // not every head is frozen: the mapping is off, the press freezes the free heads (soft)
      await send(press, release);
      expect(lock(), `${mode} 1`).to.deep.equal({ level: "soft", heads: { spot: "hard" } });
      // every head frozen: the press loosens the soft part, the hard head stays
      await send(press, release);
      expect(lock(), `${mode} 2`).to.deep.equal({ level: "off", heads: { spot: "hard" } });
      // and the next press freezes the free heads again
      await send(press, release);
      expect(lock(), `${mode} 3`).to.deep.equal({ level: "soft", heads: { spot: "hard" } });
      const journal = (await run("midi.journal")) as { calls: { ok: boolean }[] }[];
      expect(journal.flatMap((j) => j.calls).every((c) => c.ok), mode).to.equal(true);
      await run("midi.mapping.delete", { id: mapping.id });
    }
  });

  it("a group's mapping: on when all its heads are frozen", async () => {
    await map("latch", { type: "note", channel: 1, number: 40 }, "left");
    await run("motion.freeze", { fixtures: ["spot"] });
    await send(press); // the group is frozen: this press unfreezes it
    expect(lock().heads).to.deep.equal({});
    await send(press);
    expect(lock().heads).to.deep.equal({ spot: "soft" });
  });
});
