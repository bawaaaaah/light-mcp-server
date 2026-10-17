/**
 * Where a song's sections change, from its recording (docs/specs/presets-songs-notes.md, « Sections
 * depuis l'audio »): bars counted from the first beat at the tempo found, each described by its
 * loudness and its brightness (zero crossings), and a boundary where the four bars after differ most
 * from the four before — a quiet verse into a full chorus. A draft in bars, to check by ear. Pure.
 */

/** Section lengths in bars, from the first beat; the last one runs to the end. */
export function detectSections(samples: Float32Array, sampleRate: number, bpm: number, firstBeat = 0, beatsPerBar = 4): number[] | null {
  const barSamples = Math.round(((60 / bpm) * beatsPerBar) * sampleRate);
  const start = Math.round(firstBeat * sampleRate);
  const bars = Math.floor((samples.length - start) / barSamples);
  if (bars < 8 || barSamples < 1) return null;
  // per bar: loudness (log RMS) and brightness (zero-crossing rate)
  const features: [number, number][] = [];
  for (let b = 0; b < bars; b++) {
    let energy = 0;
    let crossings = 0;
    const from = start + b * barSamples;
    for (let i = from; i < from + barSamples; i++) {
      energy += samples[i]! * samples[i]!;
      if (i > from && samples[i]! >= 0 !== samples[i - 1]! >= 0) crossings++;
    }
    features.push([Math.log10(1e-9 + Math.sqrt(energy / barSamples)), crossings / barSamples]);
  }
  // each feature on the same scale (z-scores), so neither drowns the other
  const norm = [0, 1].map((k) => {
    const v = features.map((f) => f[k]!);
    const mean = v.reduce((a, x) => a + x, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, x) => a + (x - mean) ** 2, 0) / v.length) || 1;
    return v.map((x) => (x - mean) / sd);
  });
  const window = 4;
  const novelty = new Array<number>(bars).fill(0);
  for (let b = 2; b <= bars - 2; b++) {
    const w = Math.min(window, b, bars - b);
    let d = 0;
    for (const v of norm) {
      const before = v.slice(b - w, b).reduce((a, x) => a + x, 0) / w;
      const after = v.slice(b, b + w).reduce((a, x) => a + x, 0) / w;
      d += (after - before) ** 2;
    }
    novelty[b] = Math.sqrt(d);
  }
  const values = novelty.slice(2, bars - 1);
  const mean = values.reduce((a, x) => a + x, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, x) => a + (x - mean) ** 2, 0) / values.length);
  // the clearest changes first, at least four bars apart
  const candidates = novelty.map((v, b) => [b, v] as const).filter(([b, v]) => b >= 2 && b <= bars - 2 && v > mean + sd && v >= (novelty[b - 1] ?? 0) && v >= (novelty[b + 1] ?? 0));
  const cuts: number[] = [];
  for (const [b] of [...candidates].sort((x, y) => y[1] - x[1])) if (cuts.every((c) => Math.abs(c - b) >= 4)) cuts.push(b);
  const edges = [0, ...cuts.sort((x, y) => x - y), bars];
  return edges.slice(1).map((e, i) => e - edges[i]!).filter((n) => n > 0);
}
