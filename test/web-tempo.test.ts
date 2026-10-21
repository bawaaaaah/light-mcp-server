import { expect } from "chai";
import { detectTempo } from "../web/src/audio/tempo.js";
import { detectSections } from "../web/src/audio/sections.js";
import { TempoListener } from "../web/src/audio/listen.js";

/** A click track: a short decaying burst on every beat, accents on the bar, over soft noise. */
function clicks(bpm: number, seconds: number, jitter = 0, sampleRate = 22050, seed = 1): Float32Array {
  let s = seed;
  const noise = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = 0.02 * noise();
  const period = (60 / bpm) * sampleRate;
  for (let k = 0; k * period < out.length; k++) {
    const start = Math.max(0, Math.round(k * period + noise() * jitter * sampleRate));
    const gain = k % 4 === 0 ? 1 : 0.6;
    for (let i = 0; i < 0.03 * sampleRate && start + i < out.length; i++) out[start + i]! += gain * noise() * Math.exp(-i / (0.006 * sampleRate));
  }
  return out;
}

describe("tempo from audio", () => {
  for (const bpm of [64, 72, 90, 120, 128.5, 140, 156]) {
    it(`hears ${bpm} BPM in a click track, played tight or by a human (±10 ms)`, () => {
      for (const jitter of [0, 0.01]) {
        const t = detectTempo(clicks(bpm, 30, jitter), 22050)!;
        expect(t.bpm).to.be.closeTo(bpm, 0.15);
        expect(t.confidence).to.be.above(0.5);
      }
    });
  }

  it("reads the same tempo at another sample rate", () => {
    expect(detectTempo(clicks(97, 30, 0, 44100), 44100)!.bpm).to.be.closeTo(97, 0.15);
  });

  it("says nothing of silence or of a sound too short", () => {
    expect(detectTempo(new Float32Array(22050 * 10), 22050)).to.equal(null);
    expect(detectTempo(clicks(120, 1), 22050)).to.equal(null);
  });

  it("finds the first beat, and where the song's character changes, in bars", () => {
    const rate = 22050;
    const bpm = 100;
    const bar = (60 / bpm) * 4;
    const lead = 0.37; // the recording starts before the first beat
    const plan = [8, 16, 8]; // verse, chorus, verse
    const total = plan.reduce((a, b) => a + b, 0);
    let s = 3;
    const noise = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const out = new Float32Array(Math.round((lead + total * bar + 0.5) * rate));
    let low = 0;
    for (let i = 0; i < out.length; i++) {
      const barIndex = Math.floor((i / rate - lead) / bar);
      const chorus = barIndex >= plan[0]! && barIndex < plan[0]! + plan[1]!;
      // the verse: soft and dark (low-passed noise); the chorus: loud and bright (white noise)
      low = 0.97 * low + 0.03 * noise();
      out[i] = chorus ? 0.25 * noise() : 0.6 * low;
    }
    for (let k = 0; lead + (k * 60) / bpm < total * bar + lead; k++) {
      const start = Math.round((lead + (k * 60) / bpm) * rate);
      for (let i = 0; i < 0.03 * rate && start + i < out.length; i++) out[start + i]! += 0.8 * noise() * Math.exp(-i / (0.006 * rate));
    }
    const tempo = detectTempo(out, rate)!;
    expect(tempo.bpm).to.be.closeTo(bpm, 0.2);
    expect(tempo.firstBeat).to.be.closeTo(lead, 0.03);
    expect(detectSections(out, rate, tempo.bpm, tempo.firstBeat)).to.deep.equal(plan);
  });

  it("proposes no sections for less than eight bars", () => {
    expect(detectSections(new Float32Array(22050 * 5), 22050, 120)).to.equal(null);
  });
});

describe("tempo heard by a microphone", () => {
  /** The room for `seconds`, heard 2 s at a time by the listener, as the page reads it. */
  function hear(listener: TempoListener, track: Float32Array, from: number, seconds: number) {
    const rate = listener.sampleRate;
    const readings: ReturnType<TempoListener["read"]>[] = [];
    for (let t = from; t < from + seconds; t += 2) {
      listener.push(track.subarray(Math.round(t * rate), Math.round((t + 2) * rate)));
      readings.push(listener.read());
    }
    return readings;
  }

  it("follows once two readings agree, with how long ago the last beat fell", () => {
    const rate = 22050;
    // the band starts 0.21 s into the listening, at 126 BPM
    const track = new Float32Array(rate * 20);
    track.set(clicks(126, 20).subarray(0, rate * 20 - Math.round(0.21 * rate)), Math.round(0.21 * rate));
    const listener = new TempoListener(rate);
    const readings = hear(listener, track, 0, 20);
    expect(readings[0]!.reading).to.equal(null); // 2 s: too little heard
    expect(readings[1]!.reading).to.equal(null);
    const followed = readings.filter((r) => r.follow);
    expect(followed.length).to.be.at.least(4);
    expect(readings.findIndex((r) => r.follow)).to.be.at.most(4); // by 10 s
    for (const [i, r] of readings.entries()) {
      if (!r.follow) continue;
      expect(r.reading!.bpm).to.be.closeTo(126, 0.5);
      const heard = 2 * (i + 1);
      const period = 60 / 126;
      const last = 0.21 + Math.floor((heard - 0.21) / period) * period;
      const ago = (heard - last) * 1000;
      // the same beat, or the next one seen a hair early
      const off = Math.min(Math.abs(r.reading!.beatAgoMs! - ago), Math.abs(r.reading!.beatAgoMs! - ago - period * 1000));
      expect(off).to.be.below(10);
    }
  });

  it("waits for a new tempo to be heard twice before following it", () => {
    const rate = 22050;
    const track = new Float32Array(rate * 36);
    track.set(clicks(124, 18));
    track.set(clicks(92, 18, 0, rate, 7), rate * 18);
    const listener = new TempoListener(rate);
    const readings = hear(listener, track, 0, 36).map((r) => (r.follow ? Math.round(r.reading!.bpm) : null));
    expect(readings.slice(3, 9).filter((b) => b !== null).every((b) => Math.abs(b! - 124) <= 1)).to.equal(true);
    expect(readings.at(-1)).to.be.closeTo(92, 1); // 12 s of the new song: followed
    // nothing in between is followed but one of the two tempos
    expect(readings.filter((b) => b !== null).every((b) => Math.abs(b! - 124) <= 1 || Math.abs(b! - 92) <= 1)).to.equal(true);
  });
});
