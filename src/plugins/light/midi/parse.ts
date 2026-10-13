/**
 * Normalises raw MIDI bytes (one complete message, as delivered by @julusian/midi, RTP-MIDI or
 * Web MIDI) into a typed message. Pure: no I/O, no clock.
 *
 * Rule shared by every mapping mode (docs/specs/midi.md): a Note On with velocity 0 is a Note Off.
 */

export type MidiMessage =
  | { type: "noteon"; channel: number; note: number; velocity: number }
  | { type: "noteoff"; channel: number; note: number; velocity: number }
  | { type: "polyaftertouch"; channel: number; note: number; pressure: number }
  | { type: "cc"; channel: number; controller: number; value: number }
  | { type: "programchange"; channel: number; program: number }
  | { type: "channelaftertouch"; channel: number; pressure: number }
  | { type: "pitchbend"; channel: number; value: number } // 0..16383, centre 8192
  | { type: "clock" }
  | { type: "start" }
  | { type: "continue" }
  | { type: "stop" }
  | { type: "songposition"; sixteenths: number } // MIDI beats = 16th notes
  | { type: "sysex"; data: number[] }
  | { type: "other"; data: number[] };

/** Channels are 1..16 in the normalised form, as users see them. */
export function parseMidi(bytes: readonly number[]): MidiMessage {
  const status = bytes[0] ?? 0;
  const d1 = (bytes[1] ?? 0) & 0x7f;
  const d2 = (bytes[2] ?? 0) & 0x7f;
  if (status < 0xf0) {
    const channel = (status & 0x0f) + 1;
    switch (status & 0xf0) {
      case 0x80:
        return { type: "noteoff", channel, note: d1, velocity: d2 };
      case 0x90:
        return d2 === 0
          ? { type: "noteoff", channel, note: d1, velocity: 0 }
          : { type: "noteon", channel, note: d1, velocity: d2 };
      case 0xa0:
        return { type: "polyaftertouch", channel, note: d1, pressure: d2 };
      case 0xb0:
        return { type: "cc", channel, controller: d1, value: d2 };
      case 0xc0:
        return { type: "programchange", channel, program: d1 };
      case 0xd0:
        return { type: "channelaftertouch", channel, pressure: d1 };
      case 0xe0:
        return { type: "pitchbend", channel, value: (d2 << 7) | d1 };
    }
  }
  switch (status) {
    case 0xf8:
      return { type: "clock" };
    case 0xfa:
      return { type: "start" };
    case 0xfb:
      return { type: "continue" };
    case 0xfc:
      return { type: "stop" };
    case 0xf2:
      return { type: "songposition", sixteenths: (d2 << 7) | d1 };
    case 0xf0:
      return { type: "sysex", data: [...bytes] };
  }
  return { type: "other", data: [...bytes] };
}

export function formatMidi(msg: MidiMessage): string {
  switch (msg.type) {
    case "noteon":
    case "noteoff":
      return `${msg.type} ch${msg.channel} n${msg.note} v${msg.velocity}`;
    case "polyaftertouch":
      return `polyAT ch${msg.channel} n${msg.note} p${msg.pressure}`;
    case "cc":
      return `cc ch${msg.channel} #${msg.controller}=${msg.value}`;
    case "programchange":
      return `pc ch${msg.channel} ${msg.program}`;
    case "channelaftertouch":
      return `chanAT ch${msg.channel} p${msg.pressure}`;
    case "pitchbend":
      return `pitchbend ch${msg.channel} ${msg.value}`;
    case "songposition":
      return `SPP ${msg.sixteenths} (beat ${msg.sixteenths / 4})`;
    case "sysex":
    case "other":
      return `${msg.type} ${msg.data.map((b) => b.toString(16).padStart(2, "0")).join(" ")}`;
    default:
      return msg.type;
  }
}
