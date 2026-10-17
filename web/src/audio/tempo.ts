/**
 * Tempo of a song from its audio (docs/specs/presets-songs-notes.md, « Tempo depuis l'audio »):
 * an onset envelope from the rises of the signal's energy (10 ms frames), its autocorrelation over
 * 60–200 BPM weighted toward 120 (a beat heard twice as fast or slow is the usual mistake), then a
 * refinement to a tenth of a BPM across several periods. Pure: samples in, BPM out; the page decodes
 * the file (Web Audio) and a test feeds it click tracks.
 */

export interface TempoEstimate {
  bpm: number;
  /** 0..1: how clearly one period stands out of the others. */
  confidence: number;
}

const HOP_SECONDS = 0.01;
/** The frame step in samples, and its exact length: 221 samples at 22 050 Hz are 10.02 ms, not 10. */
const hopOf = (sampleRate: number) => Math.max(1, Math.round(sampleRate * HOP_SECONDS));

/** Onset strength per 10 ms frame: how much the log energy rises, minus its local average. */
export function onsetEnvelope(samples: Float32Array, sampleRate: number): Float32Array {
  const hop = hopOf(sampleRate);
  const frames = Math.floor(samples.length / hop) - 1;
  if (frames < 2) return new Float32Array(0);
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop, end = i + 2 * hop; i < end && i < samples.length; i++) e += samples[i]! * samples[i]!;
    energy[f] = Math.log(1e-9 + e);
  }
  const rise = new Float32Array(frames);
  for (let f = 1; f < frames; f++) rise[f] = Math.max(0, energy[f]! - energy[f - 1]!);
  // minus a half-second moving average: drifts and swells are not beats
  const span = Math.round(0.25 / HOP_SECONDS);
  const out = new Float32Array(frames);
  let sum = 0;
  for (let f = 0; f < frames; f++) {
    sum += rise[f]!;
    if (f > 2 * span) sum -= rise[f - 2 * span - 1]!;
    const mean = sum / Math.min(f + 1, 2 * span + 1);
    out[Math.max(0, f - span)] = Math.max(0, rise[Math.max(0, f - span)]! - mean);
  }
  // slightly smoothed: an attack falls between two frames, and the period is read between frames too
  const kernel = [0.1, 0.25, 0.3, 0.25, 0.1];
  const smooth = new Float32Array(frames);
  for (let f = 0; f < frames; f++) for (let k = -2; k <= 2; k++) smooth[f]! += kernel[k + 2]! * (out[Math.min(frames - 1, Math.max(0, f + k))] ?? 0);
  return smooth;
}

/**
 * The period to a fraction of a frame: the attacks (peaks of the envelope, placed between frames by a
 * parabola) that fall on the beats of the coarse period, and a straight line through their times —
 * its slope is the period, averaged over the whole song. Undefined when too few attacks line up.
 */
function alignBeats(o: Float32Array, period: number): number | undefined {
  const top = o.reduce((m, v) => Math.max(m, v), 0);
  const peaks: number[] = [];
  for (let i = 1; i < o.length - 1; i++) {
    const [a, b, c] = [o[i - 1]!, o[i]!, o[i + 1]!];
    if (b < 0.3 * top || b < a || b <= c) continue;
    const denom = a - 2 * b + c;
    peaks.push(i + (denom !== 0 ? (0.5 * (a - c)) / denom : 0));
  }
  if (peaks.length < 8) return undefined;
  let p = period;
  for (let round = 0; round < 3; round++) {
    const t0 = peaks[0]!;
    const fit: [number, number][] = [];
    for (const t of peaks) {
      const k = Math.round((t - t0) / p);
      if (Math.abs(t - (t0 + k * p)) < 0.2 * p) fit.push([k, t]);
    }
    if (fit.length < 8) return undefined;
    const n = fit.length;
    const [sk, st] = [fit.reduce((a, [k]) => a + k, 0), fit.reduce((a, [, t]) => a + t, 0)];
    const [skk, skt] = [fit.reduce((a, [k]) => a + k * k, 0), fit.reduce((a, [k, t]) => a + k * t, 0)];
    const slope = (n * skt - sk * st) / (n * skk - sk * sk);
    if (!(slope > 0) || Math.abs(slope - period) > 0.1 * period) return undefined;
    p = slope;
  }
  return p;
}

/** Autocorrelation at a fractional lag (linear interpolation). */
function correlation(o: Float32Array, lag: number): number {
  const whole = Math.floor(lag);
  const frac = lag - whole;
  let s = 0;
  const n = o.length - whole - 1;
  for (let i = 0; i < n; i++) s += o[i]! * (o[i + whole]! * (1 - frac) + o[i + whole + 1]! * frac);
  return n > 0 ? s / n : 0;
}

export function detectTempo(samples: Float32Array, sampleRate: number, range: { min?: number; max?: number } = {}): TempoEstimate | null {
  const [min, max] = [range.min ?? 60, range.max ?? 200];
  const o = onsetEnvelope(samples, sampleRate);
  const frame = hopOf(sampleRate) / sampleRate;
  if (o.length < 4 * Math.round(60 / min / frame)) return null; // too short to hear a beat
  const lagOf = (bpm: number) => 60 / bpm / frame;
  // a beat repeats: sum the first periods, so a click every other beat does not win alone
  const score = (bpm: number) => {
    const lag = lagOf(bpm);
    return correlation(o, lag) + 0.5 * correlation(o, 2 * lag) + 0.33 * correlation(o, 3 * lag) + 0.25 * correlation(o, 4 * lag);
  };
  const prior = (bpm: number) => Math.exp(-(Math.log2(bpm / 120) ** 2) / 2);
  let best = { bpm: 0, value: -Infinity };
  const values: number[] = [];
  for (let bpm = min; bpm <= max; bpm += 0.5) {
    const v = score(bpm) * prior(bpm);
    values.push(v);
    if (v > best.value) best = { bpm, value: v };
  }
  if (!(best.value > 0)) return null;
  // to a tenth of a BPM around the coarse peak
  for (let bpm = best.bpm - 0.6; bpm <= best.bpm + 0.6; bpm += 0.05) {
    const v = score(bpm) * prior(bpm);
    if (v > best.value) best = { bpm, value: v };
  }
  const precise = alignBeats(o, lagOf(best.bpm));
  if (precise) best = { ...best, bpm: 60 / (precise * frame) };
  const mean = values.reduce((a, v) => a + v, 0) / values.length;
  const confidence = Math.max(0, Math.min(1, 1 - mean / best.value));
  return { bpm: Math.round(best.bpm * 10) / 10, confidence: Math.round(confidence * 100) / 100 };
}
