import { expect } from "chai";
import { readFileSync } from "node:fs";
import { buildClip, listLocators, LiveSetError, setLocators, setTempoSteps, setTrackClips, summarize } from "../../../src/plugins/light/ableton/live-set.js";

const set = readFileSync(new URL("../../fixtures/live-set.xml", import.meta.url), "utf8");

describe("Live Set editor", () => {
  it("lists tracks by name", () => {
    expect(summarize(set).tracks.map((t) => t.name)).to.deep.equal(["Lights", "Other"]);
  });

  it("writes locators into an empty block and reads them back", () => {
    const xml = setLocators(set, [
      { time: 0, name: "Song A" },
      { time: 32, name: "STOP" },
    ]);
    expect(listLocators(xml)).to.deep.equal([
      { time: 0, name: "Song A" },
      { time: 32, name: "STOP" },
    ]);
  });

  it("lays autonomous clips with unique TakeIds and leaves other tracks untouched", () => {
    const xml = setTrackClips(set, "Lights", [
      { name: "A · intro", start: 0, end: 8, notes: [{ time: 0, note: 36, duration: 1 }] },
      { name: "A · refrain", start: 8, end: 24, notes: [{ time: 0, note: 37, duration: 1 }] },
    ]);
    const s = summarize(xml);
    expect(s.clipCount).to.deep.equal({ Lights: 2, Other: 0 });
    expect(xml.match(/<TakeId Value="(\d+)" \/>/g)).to.deep.equal(['<TakeId Value="1000" />', '<TakeId Value="1001" />']);
    expect(xml).to.contain('<LoopEnd Value="16" />'); // the 16-beat clip loops on itself only
    expect(xml).to.contain('<MidiKey Value="37" />');
    const other = (x: string) => x.slice(x.indexOf('<MidiTrack Id="11">'), x.indexOf("</Tracks>"));
    expect(other(xml)).to.equal(other(set));
  });

  it("refuses notes outside an autonomous clip", () => {
    const tpl = /<MidiClip Id="0"[\s\S]*?<\/MidiClip>/.exec(set)![0];
    expect(() => buildClip(tpl, 0, 1000, { name: "x", start: 0, end: 4, notes: [{ time: 3.5, note: 1, duration: 1 }] })).to.throw(RangeError);
  });

  it("refuses an unknown track and a track without template clip", () => {
    expect(() => setTrackClips(set, "Nope", [])).to.throw(LiveSetError);
    expect(() => setTrackClips(set, "Other", [{ name: "x", start: 0, end: 4, notes: [] }])).to.throw(LiveSetError, /template/);
  });

  it("replaces the tempo automation with flat steps", () => {
    const xml = setTempoSteps(set, [
      { start: 0, end: 32, bpm: 72 },
      { start: 40, end: 80, bpm: 128 },
    ]);
    expect(summarize(xml).tempo).to.deep.equal([
      { time: 0, bpm: 72 },
      { time: 32, bpm: 72 },
      { time: 40, bpm: 128 },
      { time: 80, bpm: 128 },
    ]);
  });
});
