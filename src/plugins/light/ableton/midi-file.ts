/**
 * Standard MIDI File writer (format 0, one track), for the song exports (docs/specs/midi.md): at
 * each section, the look's trigger note and the rule program's Program Change. 96 ticks per beat
 * like the user's reference click file. Pure.
 */

export interface MidiFileEvent {
  /** position in ticks */
  tick: number;
  /** raw MIDI bytes (note on/off, program change…) */
  bytes: number[];
}

export interface MidiFileSpec {
  name: string;
  bpm: number;
  beatsPerBar: number;
  ppq?: number;
  events: MidiFileEvent[];
  /** end of track, in ticks (default: last event) */
  endTick?: number;
}

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
  return out;
}

export function writeMidiFile(spec: MidiFileSpec): Uint8Array {
  const ppq = spec.ppq ?? 96;
  const name = Array.from(new TextEncoder().encode(spec.name));
  const tempo = Math.round(60_000_000 / spec.bpm);
  const denominatorPower = 2; // x/4
  const meta: MidiFileEvent[] = [
    { tick: 0, bytes: [0xff, 0x03, ...vlq(name.length), ...name] },
    { tick: 0, bytes: [0xff, 0x58, 0x04, spec.beatsPerBar, denominatorPower, 24, 8] },
    { tick: 0, bytes: [0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff] },
  ];
  // stable order: meta first, then by tick; at the same tick, program changes before notes
  const rank = (b: number[]) => (b[0] === 0xff ? 0 : (b[0]! & 0xf0) === 0xc0 ? 1 : (b[0]! & 0xf0) === 0x80 ? 2 : 3);
  const events = [...meta, ...spec.events].map((e, i) => ({ ...e, i })).sort((a, b) => a.tick - b.tick || rank(a.bytes) - rank(b.bytes) || a.i - b.i);
  const track: number[] = [];
  let last = 0;
  for (const e of events) {
    track.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  const end = Math.max(last, spec.endTick ?? last);
  track.push(...vlq(end - last), 0xff, 0x2f, 0x00);
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (ppq >> 8) & 0xff, ppq & 0xff];
  const len = track.length;
  return new Uint8Array([...header, 0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...track]);
}

/** Minimal reader (tests, verification): events with absolute ticks. */
export function readMidiFile(bytes: Uint8Array): { ppq: number; events: MidiFileEvent[] } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ppq = dv.getUint16(12);
  let i = 22;
  const end = 22 + dv.getUint32(18);
  const events: MidiFileEvent[] = [];
  let tick = 0;
  let status = 0;
  const readVlq = () => {
    let v = 0;
    for (;;) {
      const b = bytes[i++]!;
      v = (v << 7) | (b & 0x7f);
      if (b < 0x80) return v;
    }
  };
  while (i < end) {
    tick += readVlq();
    let b = bytes[i]!;
    if (b === 0xff) {
      const type = bytes[i + 1]!;
      i += 2;
      const l = readVlq();
      events.push({ tick, bytes: [0xff, type, ...bytes.slice(i, i + l)] });
      i += l;
      continue;
    }
    if (b & 0x80) {
      status = b;
      i++;
    }
    b = status;
    const n = (b & 0xf0) === 0xc0 || (b & 0xf0) === 0xd0 ? 1 : 2;
    events.push({ tick, bytes: [b, ...bytes.slice(i, i + n)] });
    i += n;
  }
  return { ppq, events };
}
