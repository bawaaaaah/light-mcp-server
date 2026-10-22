import { expect } from "chai";
import { TempoClock } from "../../../src/plugins/light/timing/tempo.js";

/** A tempo clock on a fake time, fed with MIDI clock like Ableton (24 ticks per beat). */
function setup() {
  let now = 0;
  const tempo = new TempoClock(() => now);
  const ticks = (beats: number, bpm = 120) => {
    const interval = 60000 / (bpm * 24);
    for (let i = 0; i < Math.round(beats * 24); i++) {
      now += interval;
      tempo.handleMidi({ type: "clock" });
    }
  };
  const wait = (ms: number) => void (now += ms);
  return { tempo, ticks, wait };
}

describe("tempo clock", () => {
  it("free-runs in manual and tap modes", () => {
    const { tempo, wait } = setup();
    wait(1000);
    expect(tempo.state()).to.deep.include({ beats: 2, position: null, clockMissing: false });
  });

  it("follows the MIDI clock while the DAW plays, with the song position", () => {
    const { tempo, ticks } = setup();
    tempo.setSource("midi");
    tempo.handleMidi({ type: "start" });
    ticks(8);
    const s = tempo.state();
    expect(s.bpm).to.be.closeTo(120, 0.5);
    expect(s.position).to.be.closeTo(8, 1e-6);
    expect(s.beats).to.be.closeTo(8, 0.05);
  });

  it("keeps the looks going when the clock is missing (never frozen), and says so", () => {
    const { tempo, wait } = setup();
    tempo.setSource("midi");
    const before = tempo.state().beats;
    wait(2000);
    const s = tempo.state();
    expect(s.clockMissing).to.equal(true);
    expect(s.beats - before).to.be.closeTo(4, 1e-6); // free-runs at the manual tempo (120)
    expect(s.position).to.equal(null);
  });

  it("free-runs at the last received tempo when the DAW stops, then follows again without jumping", () => {
    const { tempo, ticks, wait } = setup();
    tempo.setSource("midi");
    tempo.handleMidi({ type: "start" });
    ticks(8, 100);
    const atStop = tempo.state().beats;
    tempo.handleMidi({ type: "stop" });
    wait(3000); // between two songs: no clock at all
    const between = tempo.state();
    expect(between.beats - atStop).to.be.closeTo(5, 0.1); // 3 s at the last tempo (100 BPM)
    expect(between.position).to.equal(null);
    tempo.handleMidi({ type: "songposition", sixteenths: 0 }); // next song from the start of the arrangement
    tempo.handleMidi({ type: "start" });
    ticks(1, 100);
    const after = tempo.state();
    expect(after.position).to.be.closeTo(1, 1e-6);
    expect(after.beats).to.be.at.least(between.beats); // the engine never goes back
    expect(after.beats - between.beats).to.be.closeTo(1, 0.1);
  });

  it("ignores a scrub backwards for the looks, not for the song position", () => {
    const { tempo, ticks } = setup();
    tempo.setSource("midi");
    tempo.handleMidi({ type: "start" });
    ticks(64);
    const before = tempo.state().beats;
    tempo.handleMidi({ type: "songposition", sixteenths: 16 }); // jump back to beat 4 while playing
    ticks(1);
    const s = tempo.state();
    expect(s.position).to.be.closeTo(5, 1e-6);
    expect(s.beats - before).to.be.closeTo(1, 0.05); // looks keep their pace
  });

  it("follows the tempo heard by a microphone, and catches its beats up without a jump", () => {
    const { tempo, wait } = setup();
    wait(1100); // 2.2 beats at 120
    // the music plays 100 BPM; one of its beats fell 150 ms ago (a quarter of a beat at 100)
    tempo.follow(100, 150);
    const start = tempo.state();
    expect(start).to.deep.include({ bpm: 100, source: "audio" });
    // never backward, never a jump: sampled every 10 ms through the catch-up
    let last = start.beats;
    for (let i = 0; i < 200; i++) {
      wait(10);
      const b = tempo.state().beats;
      expect(b).to.be.greaterThan(last);
      expect(b - last).to.be.lessThan(0.03); // 10 ms at 100 BPM is 0.017 beat, a little faster at most
      last = b;
    }
    // two beats later the count is whole on the music's beats: 150 ms + 2 s after a beat is 3.58 beats
    wait(400); // 2.55 s after the heard beat: 4.25 beats
    expect(tempo.state().beats % 1).to.be.closeTo(0.25, 0.01);
  });

  it("leaves the audio tempo for a manual one", () => {
    const { tempo } = setup();
    tempo.follow(90);
    tempo.setSource("manual");
    expect(tempo.state()).to.deep.include({ bpm: 90, source: "manual" });
  });

  it("says when a MIDI clock arrives even while it is not followed (Ableton plays, a tempo was set by hand)", () => {
    const { tempo, ticks } = setup();
    tempo.setBpm(90);
    expect(tempo.state()).to.deep.include({ source: "manual", clock: false });
    ticks(2);
    expect(tempo.state()).to.deep.include({ source: "manual", clock: true, bpm: 90 }); // seen, not followed
  });
});
