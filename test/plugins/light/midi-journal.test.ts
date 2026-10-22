import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

describe("MIDI journal: what each message did", () => {
  it("tells the mappings a note matched, each command and whether it worked", async function () {
    this.timeout(10_000);
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-journal-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, os2l: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const events: { type: string; payload: { monitor?: unknown } }[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => void events.push(e as never));
    const plugin = new LightPlugin({ eventBus: bus, config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    await run("midi.mapping.put", { mapping: { id: "hole-latch", label: "Hole", input: { type: "note", channel: 1, number: 50 }, mode: "latch", on: { command: "look.go", args: { id: "hole" } }, off: { command: "look.stop", args: { id: "hole" } } } });
    await run("midi.mapping.put", { mapping: { id: "nowhere", input: { type: "note", channel: 1, number: 51 }, mode: "trigger", on: { command: "look.go", args: { id: "no-such-look" } } } });
    for (const bytes of [[0x90, 50, 100], [0x80, 50, 0], [0x90, 51, 100], [0x90, 52, 100]]) await run("midi.in", { port: "Web MIDI · test", bytes });
    let journal: { msg: { type: string; note: number }; matched: { id: string; mode: string }[]; calls: { command: string; target: string; ok: boolean; error?: string }[]; ms: number }[] = [];
    for (let i = 0; i < 50 && journal.length < 4; i++) {
      await new Promise((r) => setTimeout(r, 10));
      journal = (await run("midi.journal")) as typeof journal;
    }
    const [unmapped, failed, ignored, started] = journal; // newest first
    expect(started).to.deep.include({ matched: [{ id: "hole-latch", label: "Hole", mode: "latch" }], calls: [{ command: "look.go", target: "hole", ok: true }] });
    expect(ignored).to.deep.include({ msg: { type: "noteoff", channel: 1, note: 50, velocity: 0 }, calls: [] }); // latch: the note off does nothing
    expect(ignored!.matched).to.have.length(1);
    expect(failed!.calls[0]).to.deep.include({ command: "look.go", target: "no-such-look", ok: false });
    expect(failed!.calls[0]!.error).to.match(/no-such-look/);
    expect(unmapped!.matched).to.deep.equal([]);
    expect(started!.ms).to.be.a("number");
    expect(((await run("midi.journal", { note: 50 })) as unknown[]).length).to.equal(2);
    expect(events.some((e) => e.type === "midi" && e.payload.monitor)).to.equal(true); // the MIDI page's monitor hears the same
  });
});
