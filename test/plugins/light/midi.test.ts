import { expect } from "chai";
import { parseMidi } from "../../../src/plugins/light/midi/parse.js";
import { MidiClockFollower, PPQN } from "../../../src/plugins/light/timing/midi-clock.js";

describe("MIDI parser", () => {
  it("normalises channels to 1..16", () => {
    expect(parseMidi([0x90, 60, 100])).to.deep.equal({ type: "noteon", channel: 1, note: 60, velocity: 100 });
    expect(parseMidi([0x9f, 60, 100])).to.include({ channel: 16 });
  });

  it("treats Note On velocity 0 as Note Off", () => {
    expect(parseMidi([0x90, 36, 0])).to.deep.equal({ type: "noteoff", channel: 1, note: 36, velocity: 0 });
  });

  it("parses CC, aftertouch, program change and pitch bend", () => {
    expect(parseMidi([0xb0, 7, 64])).to.deep.equal({ type: "cc", channel: 1, controller: 7, value: 64 });
    expect(parseMidi([0xa1, 36, 90])).to.deep.equal({ type: "polyaftertouch", channel: 2, note: 36, pressure: 90 });
    expect(parseMidi([0xd0, 50])).to.deep.equal({ type: "channelaftertouch", channel: 1, pressure: 50 });
    expect(parseMidi([0xc0, 3])).to.deep.equal({ type: "programchange", channel: 1, program: 3 });
    expect(parseMidi([0xe0, 0x00, 0x40])).to.deep.equal({ type: "pitchbend", channel: 1, value: 8192 });
  });

  it("parses realtime and Song Position Pointer", () => {
    expect(parseMidi([0xf8]).type).to.equal("clock");
    expect(parseMidi([0xfa]).type).to.equal("start");
    expect(parseMidi([0xfb]).type).to.equal("continue");
    expect(parseMidi([0xfc]).type).to.equal("stop");
    expect(parseMidi([0xf2, 0x10, 0x01])).to.deep.equal({ type: "songposition", sixteenths: 144 });
  });
});

/** Feeds `beats` beats of clock at `bpm`, optionally with ±jitterMs of deterministic jitter. */
function feed(f: MidiClockFollower, startMs: number, bpm: number, beats: number, jitterMs = 0): number {
  const interval = 60000 / (bpm * PPQN);
  let t = startMs;
  for (let i = 0; i < beats * PPQN; i++) {
    t += interval;
    const jitter = jitterMs ? ((i * 7919) % 100) / 100 * 2 * jitterMs - jitterMs : 0;
    f.handle({ type: "clock" }, t + jitter);
  }
  return t;
}

describe("MIDI clock follower", () => {
  it("estimates the tempo", () => {
    const f = new MidiClockFollower();
    const t = feed(f, 0, 120, 4);
    expect(f.state(t).bpm).to.be.closeTo(120, 0.01);
  });

  it("stays within ±0.5 BPM under ±1 ms delivery jitter", () => {
    const f = new MidiClockFollower();
    const t = feed(f, 0, 96, 8, 1);
    expect(f.state(t).bpm).to.be.closeTo(96, 0.5);
  });

  it("follows a tempo change within one beat", () => {
    const f = new MidiClockFollower();
    let t = feed(f, 0, 120, 4);
    t = feed(f, t, 140, 1);
    expect(f.state(t).bpm).to.be.closeTo(140, 0.01);
  });

  it("tracks the position from Start, ticks and SPP", () => {
    const f = new MidiClockFollower();
    f.handle({ type: "start" }, 0);
    let t = feed(f, 0, 120, 2);
    expect(f.state(t).beats).to.be.closeTo(2, 1e-9);
    f.handle({ type: "songposition", sixteenths: 64 }, t); // bar 5 in 4/4
    t = feed(f, t, 120, 1);
    expect(f.state(t).beats).to.be.closeTo(17, 1e-9);
  });

  it("reports the clock as absent after the timeout", () => {
    const f = new MidiClockFollower({ timeoutMs: 500 });
    const t = feed(f, 0, 120, 1);
    expect(f.state(t).receiving).to.equal(true);
    expect(f.state(t + 600)).to.include({ receiving: false, bpm: null });
  });

  it("does not let a gap pollute the tempo", () => {
    const f = new MidiClockFollower();
    let t = feed(f, 0, 120, 2);
    t += 300; // dropout shorter than the timeout but far beyond one tick
    f.handle({ type: "clock" }, t);
    t = feed(f, t, 120, 1);
    expect(f.state(t).bpm).to.be.closeTo(120, 0.01);
  });
});
