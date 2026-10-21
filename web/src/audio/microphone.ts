/**
 * The microphone of this browser (docs/specs/engine-effects-timing.md, « Tempo au micro »), shared
 * by every Tap widget: the room as it is, brought down to about 22 kHz and read every 2 seconds by a
 * TempoListener. Only the BPM to follow and how long ago its beat fell leave the browser; nothing is
 * recorded.
 */
import { TempoListener, type Reading } from "./listen";

const EVERY_MS = 2000;
const RATE = 22050;

/** Every `factor` samples averaged into one: a lighter analysis, the beats stay where they are. */
function decimate(input: Float32Array, factor: number, carry: { sum: number; n: number }): Float32Array {
  if (factor <= 1) return input.slice();
  const out = new Float32Array(Math.ceil((input.length + carry.n) / factor));
  let k = 0;
  for (const v of input) {
    carry.sum += v;
    if (++carry.n === factor) {
      out[k++] = carry.sum / factor;
      carry.sum = 0;
      carry.n = 0;
    }
  }
  return out.subarray(0, k);
}

export type MicState = { on: false; error?: "insecure" | "denied" | "failed" } | { on: true; reading: Reading | null; following: boolean };

/** Listening or not, and the last reading; `onFollow` gets each reading to follow, the page sends it on. */
class Microphone {
  state: MicState = { on: false };
  private readonly listeners = new Set<() => void>();
  private stopNow: (() => void) | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  private set(state: MicState) {
    this.state = state;
    for (const fn of this.listeners) fn();
  }

  async start(onFollow: (r: Reading) => void): Promise<void> {
    if (this.stopNow) return;
    if (!navigator.mediaDevices?.getUserMedia) return this.set({ on: false, error: "insecure" }); // https or localhost only
    let stream: MediaStream;
    try {
      // the room as it is: no echo cancelling, noise gate or levelling to flatten the attacks
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (err) {
      return this.set({ on: false, error: (err as Error).name === "NotAllowedError" ? "denied" : "failed" });
    }
    const ctx = new AudioContext();
    void ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const factor = Math.max(1, Math.floor(ctx.sampleRate / RATE));
    const listener = new TempoListener(ctx.sampleRate / factor);
    const carry = { sum: 0, n: 0 };
    let lastChunkAt = performance.now();
    // a script processor is old but runs everywhere without a separate module; its output stays silent
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      listener.push(decimate(e.inputBuffer.getChannelData(0), factor, carry));
      lastChunkAt = performance.now();
    };
    source.connect(node);
    node.connect(ctx.destination);
    const timer = setInterval(() => {
      const { reading, follow } = listener.read();
      if (follow && reading) onFollow({ ...reading, ...(reading.beatAgoMs !== undefined ? { beatAgoMs: reading.beatAgoMs + Math.round(performance.now() - lastChunkAt) } : {}) });
      this.set({ on: true, reading, following: follow });
    }, EVERY_MS);
    this.stopNow = () => {
      clearInterval(timer);
      node.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    };
    this.set({ on: true, reading: null, following: false });
  }

  stop(): void {
    this.stopNow?.();
    this.stopNow = null;
    this.set({ on: false });
  }
}

export const microphone = new Microphone();
