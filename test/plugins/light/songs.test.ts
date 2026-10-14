import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { followPosition } from "../../../src/plugins/light/commands/song-commands.js";
import { cuesBetween, placeSections, sectionAt, SongSchema } from "../../../src/plugins/light/songs/songs.js";
import { XMLValidator } from "fast-xml-parser";
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

  it("finds the timeline actions passed between two positions", () => {
    const sg = SongSchema.parse({ ...song, cues: [
      { id: "flash", atBar: 4, command: "group.flash", args: { id: "g", on: true } },
      { id: "late", atBar: 4, beat: 2, command: "blackout", args: { on: true } },
    ] });
    expect(cuesBetween(sg, 15, 16).map((c) => c.id)).to.deep.equal(["flash"]); // bar 4 = beat 16
    expect(cuesBetween(sg, 16, 17)).to.deep.equal([]); // already passed
    expect(cuesBetween(sg, 15, 19).map((c) => c.id)).to.deep.equal(["flash", "late"]);
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

    it("refuses timeline actions with an unknown command, bad arguments or a song command", async () => {
      const put = (cue: unknown) => run("song.put", { song: { ...song, id: "x", cues: [cue] } }).then(() => "ok", (e: Error) => e.message);
      expect(await put({ id: "c", atBar: 1, command: "nope" })).to.match(/commande inconnue nope/);
      expect(await put({ id: "c", atBar: 1, command: "group.level", args: { id: "sections" } })).to.match(/group.level.*level/);
      expect(await put({ id: "c", atBar: 1, command: "song.next" })).to.match(/ne peut pas piloter les chants/);
      expect(await put({ id: "c", atBar: 1, command: "group.level", args: { id: "sections", level: 0.5 } })).to.equal("ok");
      await run("song.delete", { id: "x" });
    });

    it("plays a song on its own clock: sections follow, actions fire in playback, never on a jump", async () => {
      const songs = (plugin as unknown as { songs: Parameters<typeof followPosition>[0] }).songs;
      await run("group.put", { group: { id: "public", name: "Public", master: { level: 1 } } });
      await run("song.put", { song: { ...song, cues: [
        { id: "baisse", atBar: 5, command: "group.level", args: { id: "public", level: 0.5 }, label: "public à 50 %" },
        { id: "noir", atBar: 10, command: "group.level", args: { id: "public", level: 0 } },
      ] } });
      const r = (await run("song.play", { song: "chant", bar: 4 })) as { section: string };
      expect(r.section).to.equal("refrain"); // bar 4 = beat 16: start of the refrain
      expect(plugin.runtime.activeLooks()).to.deep.equal(["b"]);
      const move = async (beats: number) => {
        songs.state.transport!.startBeats -= beats; // as if the engine had played `beats` more
        followPosition(songs);
        await new Promise((r) => setImmediate(r));
      };
      for (let i = 0; i < 17; i++) await move(0.25); // playback through bar 5 (0-based: beat 20)
      expect(plugin.runtime.groups.get("public")!.master!.level).to.equal(0.5);
      await move(30); // a jump past bar 10: nothing fires
      expect(plugin.runtime.groups.get("public")!.master!.level).to.equal(0.5);
      await move(30); // past the end of the song
      expect(songs.state.transport).to.equal(undefined);
      await run("song.stop");
    });

    it("fires the actions under the MIDI clock, not on a scrub", async () => {
      const songs = (plugin as unknown as { songs: Parameters<typeof followPosition>[0] }).songs;
      await run("group.level", { id: "public", level: 1 });
      await run("tempo.set", { source: "midi" });
      plugin.tempo.handleMidi({ type: "stop" });
      plugin.tempo.handleMidi({ type: "songposition", sixteenths: 19 * 4 + 3 }); // beat 19.75, just before the action at beat 20
      plugin.tempo.handleMidi({ type: "continue" });
      followPosition(songs); // first position: nothing fired
      for (let i = 0; i < 12; i++) plugin.tempo.handleMidi({ type: "clock" }); // half a beat of playback
      followPosition(songs);
      await new Promise((r) => setImmediate(r));
      expect(plugin.runtime.groups.get("public")!.master!.level).to.equal(0.5); // the action at beat 20 fired
      plugin.tempo.handleMidi({ type: "songposition", sixteenths: 41 * 4 }); // scrub past bar 10 (beat 40)
      for (let i = 0; i < 3; i++) plugin.tempo.handleMidi({ type: "clock" });
      followPosition(songs);
      await new Promise((r) => setImmediate(r));
      expect(plugin.runtime.groups.get("public")!.master!.level).to.equal(0.5);
      plugin.tempo.handleMidi({ type: "stop" });
      await run("tempo.set", { source: "manual" });
    });

    it("writes the cue sheet with trigger notes", async () => {
      const sheet = (await run("export.cuesheet", { setlist: "dimanche" })) as string;
      expect(sheet).to.contain("## Chant · 96 BPM");
      expect(sheet).to.contain("| 5 | Refrain | premier refrain | Look B | 40 (ch 1) |");
      expect(sheet).to.contain("- mesure 6.1 : public à 50 %");
      expect(sheet).to.contain("- mesure 11.1 : group.level id=public level=0");
    });

    it("draws the storyboard of a song in SVG", async () => {
      const svg = (await run("export.board", { song: "chant" })) as string;
      expect(XMLValidator.validate(svg)).to.equal(true);
      expect(svg.match(/class="section"/g)).to.have.length(3);
      expect(svg).to.contain("Look B");
      expect(svg).to.contain('fill="#ff0000"'); // look A painted red on the canvas
      expect(svg).to.contain("« premier refrain »");
      expect(svg).to.contain("◆ mesure 6.1 : public à 50 %");
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
