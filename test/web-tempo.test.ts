import { expect } from "chai";
import { detectTempo } from "../web/src/audio/tempo.js";

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
});
