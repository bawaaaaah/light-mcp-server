import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { followPosition } from "../../../src/plugins/light/commands/song-commands.js";
import { placeSections, sectionAt, SongSchema } from "../../../src/plugins/light/songs/songs.js";
import { readAls, summarize } from "../../../src/plugins/light/ableton/live-set.js";

const song = SongSchema.parse({
  id: "chant",
  title: "Chant",
  bpm: 96,
  sections: [
    { id: "intro", name: "Intro", look: "a", bars: 4 },
    { id: "refrain", name: "Refrain", look: "b", bars: 8, cue: "premier refrain" },
    { id: "pont", name: "Pont", look: "a", atBar: 16, bars: 4 },
  ],
});

describe("songs", () => {
  it("places sections in beats (sequential or at a bar)", () => {
    expect(placeSections(song).map((p) => [p.section.id, p.startBeat, p.endBeat])).to.deep.equal([
      ["intro", 0, 16],
      ["refrain", 16, 48],
      ["pont", 64, 80],
    ]);
    expect(sectionAt(song, -1)).to.equal(undefined);
    expect(sectionAt(song, 20)!.id).to.equal("refrain");
    expect(sectionAt(song, 50)!.id).to.equal("refrain"); // gap keeps the last section
    expect(sectionAt(song, 64)!.id).to.equal("pont");
  });

  describe("in the plugin", () => {
    let plugin: LightPlugin;
    let dataRoot: string;
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());

    before(async () => {
      dataRoot = join(mkdtempSync(join(tmpdir(), "light-songs-")), "data");
      mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
      copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
      mkdirSync(join(dataRoot, "private"), { recursive: true });
      writeFileSync(join(dataRoot, "private", "set.als"), gzipSync(readFileSync(new URL("../../fixtures/live-set.xml", import.meta.url))));
      const config = { light: { discovery: false, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } } };
      plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => config.light, set: async () => undefined }, dataRoot, midiNative: null });
      await run("venue.fixture.put", { fixture: { id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1 } });
      await run("venue.canvas.put", { canvas: { id: "mur", name: "Mur", cells: 4, render: [{ from: 0, to: 3, targets: [{ fixture: "bar", head: -1 }] }] } });
      await run("look.put", { look: { id: "a", name: "Look A", canvas: "mur", technique: { kind: "plat", color: "#ff0000" } } });
      await run("look.put", { look: { id: "b", name: "Look B", canvas: "mur", technique: { kind: "plat", color: "#0000ff" } } });
      await run("group.put", { group: { id: "sections", name: "Sections", exclusive: true, members: { looks: ["a", "b"] } } });
      await run("song.put", { song });
      await run("midi.mapping.put", { mapping: { id: "n-b", input: { type: "note", channel: 1, number: 40 }, on: { command: "look.go", args: { id: "b" } } } });
      await run("setlist.put", { setlist: { id: "dimanche", name: "Dimanche", songs: ["chant"] } });
    });

    it("selects a song, starts its first section, steps through sections", async () => {
      await run("setlist.select", { id: "dimanche" });
      expect(plugin.runtime.activeLooks()).to.deep.equal(["a"]);
      expect(plugin.tempo.state().bpm).to.equal(96);
      await run("song.next");
      expect(plugin.runtime.activeLooks()).to.deep.equal(["b"]); // exclusive group released "a"
      expect(((await run("song.state")) as { section: string }).section).to.equal("refrain");
    });

    it("follows the MIDI clock position after a jump (SPP)", async () => {
      await run("tempo.set", { source: "midi" });
      const songs = (plugin as unknown as { songs: Parameters<typeof followPosition>[0] }).songs;
      plugin.tempo.handleMidi({ type: "start" });
      plugin.tempo.handleMidi({ type: "songposition", sixteenths: 64 * 4 }); // bar 17 = beat 64: « Pont »
      for (let i = 0; i < 3; i++) plugin.tempo.handleMidi({ type: "clock" });
      followPosition(songs);
      expect(songs.state.section).to.equal("pont");
      expect(plugin.runtime.activeLooks()).to.deep.equal(["a"]);
      await run("tempo.set", { source: "manual" });
    });

    it("writes the cue sheet with trigger notes", async () => {
      const sheet = (await run("export.cuesheet", { setlist: "dimanche" })) as string;
      expect(sheet).to.contain("## Chant · 96 BPM");
      expect(sheet).to.contain("| 5 | Refrain | premier refrain | Look B | 40 (ch 1) |");
    });

    it("lays the setlist into a Live Set", async () => {
      const r = (await run("export.liveset", { setlist: "dimanche", als: "set.als", track: "Lights" })) as { file: string; clips: number; sectionsWithoutNote: string[] };
      expect(r.clips).to.equal(3);
      expect(r.sectionsWithoutNote).to.deep.equal(["Chant · Intro", "Chant · Pont"]);
      const out = summarize(readAls(readFileSync(join(dataRoot, r.file))));
      expect(out.locators.map((l) => l.name)).to.deep.equal(["Chant", "STOP"]);
      expect(out.clipCount.Lights).to.equal(3);
      expect(out.tempo[0]).to.deep.equal({ time: 0, bpm: 96 });
    });

    it("sends MIDI feedback when a look changes from any origin", async () => {
      await run("midi.mapping.put", { mapping: { id: "fb", input: { type: "note", channel: 1, number: 41 }, on: { command: "look.go", args: { id: "a" } }, feedback: "note" } });
      const sent: number[][] = [];
      plugin.hub.sendFeedback = (msgs: number[][]) => void sent.push(...msgs);
      await run("look.stopall");
      sent.length = 0;
      await run("look.go", { id: "a" }); // from the UI, not from MIDI
      expect(sent).to.deep.include([0x90, 41, 127]);
      sent.length = 0;
      await run("look.go", { id: "b" }); // exclusive group releases "a"
      expect(sent).to.deep.include([0x80, 41, 0]);
    });

    after(async () => plugin.stop());
  });
});
