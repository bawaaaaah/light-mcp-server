/**
 * AppleMIDI / RTP-MIDI codec (RFC 6295 payload + Apple session protocol). Pure functions only.
 *
 * Session protocol (control and data ports, data = control + 1), big-endian:
 *   0xFFFF, command (2 ASCII chars), then
 *   IN/OK/NO/BY: protocol version (2), initiator token, sender SSRC, [name\0]
 *   CK: sender SSRC, count (0..2), 3 padding bytes, three 64-bit timestamps (100 µs units)
 * Data packets are RTP (payload type 97) carrying an RTP-MIDI command list.
 */

export const APPLEMIDI_SIGNATURE = 0xffff;
export const PROTOCOL_VERSION = 2;
export const RTP_PAYLOAD_TYPE = 0x61;

export type SessionCommand = "IN" | "OK" | "NO" | "BY";

export type ControlPacket =
  | { command: SessionCommand; version: number; token: number; ssrc: number; name: string }
  | { command: "CK"; ssrc: number; count: number; timestamps: [bigint, bigint, bigint] }
  | { command: "RS"; ssrc: number; sequence: number };

export function isControlPacket(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt16BE(0) === APPLEMIDI_SIGNATURE;
}

export function encodeControl(p: ControlPacket): Buffer {
  if (p.command === "CK") {
    const buf = Buffer.alloc(36);
    buf.writeUInt16BE(APPLEMIDI_SIGNATURE, 0);
    buf.write("CK", 2, "ascii");
    buf.writeUInt32BE(p.ssrc >>> 0, 4);
    buf.writeUInt8(p.count, 8);
    p.timestamps.forEach((t, i) => buf.writeBigUInt64BE(BigInt.asUintN(64, t), 12 + i * 8));
    return buf;
  }
  if (p.command === "RS") {
    const buf = Buffer.alloc(12);
    buf.writeUInt16BE(APPLEMIDI_SIGNATURE, 0);
    buf.write("RS", 2, "ascii");
    buf.writeUInt32BE(p.ssrc >>> 0, 4);
    buf.writeUInt16BE(p.sequence & 0xffff, 8);
    return buf;
  }
  const name = Buffer.from(p.command === "BY" ? "" : `${p.name}\0`, "utf8");
  const buf = Buffer.alloc(16 + name.length);
  buf.writeUInt16BE(APPLEMIDI_SIGNATURE, 0);
  buf.write(p.command, 2, "ascii");
  buf.writeUInt32BE(p.version, 4);
  buf.writeUInt32BE(p.token >>> 0, 8);
  buf.writeUInt32BE(p.ssrc >>> 0, 12);
  name.copy(buf, 16);
  return buf;
}

export function decodeControl(buf: Buffer): ControlPacket | null {
  if (!isControlPacket(buf)) return null;
  const command = buf.toString("ascii", 2, 4);
  if (command === "CK") {
    if (buf.length < 36) return null;
    return {
      command,
      ssrc: buf.readUInt32BE(4),
      count: buf.readUInt8(8),
      timestamps: [buf.readBigUInt64BE(12), buf.readBigUInt64BE(20), buf.readBigUInt64BE(28)],
    };
  }
  if (command === "RS") {
    if (buf.length < 10) return null;
    return { command, ssrc: buf.readUInt32BE(4), sequence: buf.readUInt16BE(8) };
  }
  if (command === "IN" || command === "OK" || command === "NO" || command === "BY") {
    if (buf.length < 16) return null;
    const rest = buf.subarray(16);
    const end = rest.indexOf(0);
    return {
      command,
      version: buf.readUInt32BE(4),
      token: buf.readUInt32BE(8),
      ssrc: buf.readUInt32BE(12),
      name: rest.subarray(0, end === -1 ? rest.length : end).toString("utf8"),
    };
  }
  return null;
}

/** Length in bytes of a channel/system message given its status byte (0 = variable/sysex). */
function messageLength(status: number): number {
  if (status < 0xf0) {
    const hi = status & 0xf0;
    return hi === 0xc0 || hi === 0xd0 ? 2 : 3;
  }
  switch (status) {
    case 0xf1:
    case 0xf3:
      return 2;
    case 0xf2:
      return 3;
    case 0xf0:
      return 0;
    default:
      return 1;
  }
}

function writeDelta(out: number[], delta: number): void {
  const bytes = [delta & 0x7f];
  for (let v = delta >>> 7; v > 0; v >>>= 7) bytes.unshift((v & 0x7f) | 0x80);
  out.push(...bytes.slice(-4));
}

export interface RtpMidiPacket {
  sequence: number;
  timestamp: number;
  ssrc: number;
  /** Complete MIDI messages, in order. */
  messages: number[][];
}

/** Encodes an RTP packet with a command list (no journal, delta time 0 between messages). */
export function encodeRtpMidi(p: RtpMidiPacket): Buffer {
  const list: number[] = [];
  p.messages.forEach((msg, i) => {
    if (i > 0) writeDelta(list, 0);
    list.push(...msg);
  });
  const longHeader = list.length > 15;
  const header = longHeader ? [0x80 | ((list.length >> 8) & 0x0f), list.length & 0xff] : [list.length & 0x0f];
  const buf = Buffer.alloc(12 + header.length + list.length);
  buf.writeUInt8(0x80, 0); // V=2
  buf.writeUInt8(RTP_PAYLOAD_TYPE, 1);
  buf.writeUInt16BE(p.sequence & 0xffff, 2);
  buf.writeUInt32BE(p.timestamp >>> 0, 4);
  buf.writeUInt32BE(p.ssrc >>> 0, 8);
  Buffer.from([...header, ...list]).copy(buf, 12);
  return buf;
}

/** Decodes an RTP-MIDI packet's command list (journal, if any, is skipped). */
export function decodeRtpMidi(buf: Buffer): RtpMidiPacket | null {
  if (buf.length < 13 || (buf[0]! & 0xc0) !== 0x80 || (buf[1]! & 0x7f) !== RTP_PAYLOAD_TYPE) return null;
  let i = 12;
  const flags = buf[i]!;
  const longHeader = (flags & 0x80) !== 0;
  const hasFirstDelta = (flags & 0x20) !== 0;
  let length = flags & 0x0f;
  i += 1;
  if (longHeader) {
    length = (length << 8) | buf[i]!;
    i += 1;
  }
  const end = Math.min(buf.length, i + length);
  const messages: number[][] = [];
  let runningStatus = 0;
  let first = true;
  while (i < end) {
    if (!first || hasFirstDelta) {
      // Variable-length delta time, up to 4 bytes.
      for (let n = 0; n < 4 && i < end; n++) if ((buf[i++]! & 0x80) === 0) break;
    }
    first = false;
    if (i >= end) break;
    let status = buf[i]!;
    if (status & 0x80) {
      i += 1;
      if (status < 0xf0) runningStatus = status;
    } else {
      status = runningStatus; // running status: data byte follows directly
    }
    if (status === 0xf0) {
      const stop = buf.indexOf(0xf7, i);
      const last = stop === -1 || stop >= end ? end : stop + 1;
      messages.push([0xf0, ...buf.subarray(i, last)]);
      i = last;
      continue;
    }
    const len = messageLength(status);
    if (len === 0 || status === 0) break;
    messages.push([status, ...buf.subarray(i, i + len - 1)]);
    i += len - 1;
  }
  return { sequence: buf.readUInt16BE(2), timestamp: buf.readUInt32BE(4), ssrc: buf.readUInt32BE(8), messages };
}
