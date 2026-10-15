import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { cloneProgramClip, programClipName, readProgramClip } from "../../../src/plugins/light/ableton/live-clip.js";
import { readMidiFile, writeMidiFile } from "../../../src/plugins/light/ableton/midi-file.js";
import { readAls } from "../../../src/plugins/light/ableton/live-set.js";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

const shell = readFileSync(new URL("../../fixtures/clip-shell.xml", import.meta.url), "utf8");

describe("Ableton exports for rule programs", () => {
  it("clones a shell clip: only the first clip's name and Program Change change (the groove stays)", () => {
    const out = cloneProgramClip(shell, { name: programClipName("Prière", 99), programChange: 99 });
    expect(readProgramClip(out)).to.deep.equal({ name: "Prière #100", programChange: 99 });
    const changed = shell.split("\n").filter((l, i) => l !== out.split("\n")[i]);
    expect(changed.map((l) => l.trim())).to.deep.equal(['<Name Value="Coquille #1" />', '<ProgramChange Value="0" />']);
    expect(out).to.contain('<Name Value="Swing 16ths" />');
    expect(() => cloneProgramClip("<Ableton />", { name: "x", programChange: 1 })).to.throw(/aucun clip MIDI/);
  });

  it("writes a standard MIDI file that reads back (tempo, metre, program change before the note)", () => {
    const bytes = writeMidiFile({ name: "Chant", bpm: 120, beatsPerBar: 4, events: [{ tick: 96, bytes: [0x90, 36, 100] }, { tick: 96, bytes: [0xc0, 99] }, { tick: 120, bytes: [0x80, 36, 64] }], endTick: 384 });
    expect(Buffer.from(bytes.slice(0, 4)).toString()).to.equal("MThd");
    const { ppq, events } = readMidiFile(bytes);
    expect(ppq).to.equal(96);
    const channel = events.filter((e) => e.bytes[0] !== 0xff);
    expect(channel.map((e) => [e.tick, ...e.bytes])).to.deep.equal([
      [96, 0xc0, 99],
      [96, 0x90, 36, 100],
      [120, 0x80, 36, 64],
    ]);
    const tempo = events.find((e) => e.bytes[0] === 0xff && e.bytes[1] === 0x51)!;
    expect((tempo.bytes[2]! << 16) | (tempo.bytes[3]! << 8) | tempo.bytes[4]!).to.equal(500000); // 120 BPM
    expect(events.at(-1)).to.deep.equal({ tick: 384, bytes: [0xff, 0x2f] }); // end of track at the song end
  });

  it("exports a song's .mid and the program clips from the show", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-ableton-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    mkdirSync(join(dataRoot, "private"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    writeFileSync(join(dataRoot, "private", "shell.alc"), gzipSync(shell));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    await run("venue.fixture.put", { fixture: { id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1 } });
    await run("venue.canvas.put", { canvas: { id: "mur", name: "Mur", cells: 4, render: [{ from: 0, to: 3, targets: [{ fixture: "bar", head: -1 }] }] } });
    await run("look.put", { look: { id: "a", name: "A", canvas: "mur", technique: { kind: "plat", color: "#ff0000" } } });
    await run("midi.mapping.put", { mapping: { id: "n36", input: { type: "note", channel: 1, number: 36 }, on: { command: "look.go", args: { id: "a" } } } });
    await run("program.put", { program: { id: "priere", name: "Prière", programChange: 99, channel: 2 } });
    await run("program.put", { program: { id: "libre", name: "Libre" } });
    await run("song.put", { song: { id: "s", title: "Chant démo", bpm: 120, sections: [{ id: "i", name: "Intro", look: "a", bars: 2 }, { id: "p", name: "Prière", look: "a", bars: 2, program: "priere" }] } });

    const mid = (await run("export.mid", { song: "s" })) as { file: string; missing: string[] };
    const { events } = readMidiFile(readFileSync(join(dataRoot, mid.file)));
    expect(events.filter((e) => e.bytes[0] !== 0xff).map((e) => [e.tick, ...e.bytes])).to.deep.equal([
      [0, 0x90, 36, 100],
      [24, 0x80, 36, 64],
      [768, 0xc1, 99], // bar 3: program « prière » on channel 2
      [768, 0x90, 36, 100],
      [792, 0x80, 36, 64],
    ]);
    expect(mid.missing).to.deep.equal([]);

    const clips = (await run("export.ableton.programs")) as { written: { file: string; clip: string }[]; skipped: string[] };
    expect(clips.written.map((c) => c.clip)).to.deep.equal(["Prière #100"]);
    expect(clips.skipped).to.deep.equal(["« Libre » : pas de Program Change"]);
    expect(readProgramClip(readAls(readFileSync(join(dataRoot, clips.written[0]!.file))))).to.deep.equal({ name: "Prière #100", programChange: 99 });
  });
});
