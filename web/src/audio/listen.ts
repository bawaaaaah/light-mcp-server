/**
 * Tempo heard by a microphone (docs/specs/presets-songs-notes.md, « Tempo au micro »): the last 12
 * seconds the room heard, read every 2 seconds (audio/tempo.ts). A reading is followed once the one
 * before agrees with it (within 1 BPM, both clear enough), with how long ago its last beat fell: the
 * looks then keep the band's tempo and land on its beats. Pure: the page's microphone
 * (audio/microphone.ts) feeds it, a test feeds it click tracks.
 */
import { detectTempo } from "./tempo.js";

export interface Reading {
  bpm: number;
  confidence: number;
  /** How long ago the last beat of the window fell, when the attacks line up well enough to say. */
  beatAgoMs?: number;
}

const WINDOW_SECONDS = 12;
const MIN_CONFIDENCE = 0.5;
const AGREE_BPM = 1;

/** The pure part: samples in, readings out, and the tempo to follow once two of them agree. */
export class TempoListener {
  private readonly ring: Float32Array;
  private written = 0;
  private previous: Reading | null = null;

  constructor(
    readonly sampleRate: number,
    seconds = WINDOW_SECONDS,
  ) {
    this.ring = new Float32Array(Math.round(sampleRate * seconds));
  }

  push(chunk: Float32Array): void {
    for (const v of chunk) this.ring[this.written++ % this.ring.length] = v;
  }

  /** The window, oldest sample first. */
  private window(): Float32Array {
    const n = Math.min(this.written, this.ring.length);
    const start = this.written - n;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.ring[(start + i) % this.ring.length]!;
    return out;
  }

  /** What the window says now (null while under half of it is heard, or nothing beats), and whether to follow it. */
  read(): { reading: Reading | null; follow: boolean } {
    if (this.written < this.ring.length / 2) return { reading: null, follow: false };
    const samples = this.window();
    const found = detectTempo(samples, this.sampleRate);
    let reading: Reading | null = null;
    if (found) {
      reading = { bpm: found.bpm, confidence: found.confidence };
      if (found.firstBeat !== undefined) {
        const duration = samples.length / this.sampleRate;
        const period = 60 / found.bpm;
        const last = found.firstBeat + Math.floor((duration - found.firstBeat) / period) * period;
        reading.beatAgoMs = Math.round((duration - last) * 1000);
      }
    }
    const before = this.previous;
    this.previous = reading;
    const clear = (r: Reading | null) => !!r && r.confidence >= MIN_CONFIDENCE;
    return { reading, follow: clear(reading) && clear(before) && Math.abs(reading!.bpm - before!.bpm) <= AGREE_BPM };
  }
}
