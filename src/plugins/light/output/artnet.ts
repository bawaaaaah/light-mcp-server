/**
 * Art-Net 4 codec: pure encode/decode of the packets light-mcp-server needs (ArtPoll,
 * ArtPollReply, ArtDmx, ArtSync). No sockets here — see artnet-socket for I/O.
 *
 * Layout reference: Art-Net 4 specification (Artistic Licence). All OpCodes are little-endian,
 * ProtVer and lengths are big-endian.
 */

export const ARTNET_PORT = 6454;
export const ARTNET_ID = Buffer.from("Art-Net\0", "ascii");
export const PROTOCOL_VERSION = 14;

export const OpCode = {
  Poll: 0x2000,
  PollReply: 0x2100,
  Dmx: 0x5000,
  Sync: 0x5200,
} as const;

/** ArtPoll Flags bit 1: send ArtPollReply whenever node conditions change. */
export const POLL_FLAG_REPLY_ON_CHANGE = 0x02;

const DMX_HEADER_LENGTH = 18;
const POLL_REPLY_MIN_LENGTH = 207; // up to BindIp; older nodes stop around here

/** 15-bit Port-Address: Net (7 bits) : Sub-Net (4 bits) : Universe (4 bits). */
export function portAddress(net: number, subNet: number, universe: number): number {
  return ((net & 0x7f) << 8) | ((subNet & 0x0f) << 4) | (universe & 0x0f);
}

export function splitPortAddress(address: number): { net: number; subNet: number; universe: number } {
  return { net: (address >> 8) & 0x7f, subNet: (address >> 4) & 0x0f, universe: address & 0x0f };
}

function header(opCode: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  ARTNET_ID.copy(buf, 0);
  buf.writeUInt16LE(opCode, 8);
  return buf;
}

/** Returns the OpCode of an Art-Net packet, or null when the buffer is not Art-Net. */
export function readOpCode(buf: Buffer): number | null {
  if (buf.length < 10 || !buf.subarray(0, 8).equals(ARTNET_ID)) return null;
  return buf.readUInt16LE(8);
}

export function encodePoll(flags = POLL_FLAG_REPLY_ON_CHANGE, diagPriority = 0): Buffer {
  const buf = header(OpCode.Poll, 14);
  buf.writeUInt16BE(PROTOCOL_VERSION, 10);
  buf.writeUInt8(flags, 12);
  buf.writeUInt8(diagPriority, 13);
  return buf;
}

export interface DmxPacket {
  sequence: number; // 1..255, 0 disables sequencing
  physical: number;
  portAddress: number;
  data: Uint8Array; // 2..512 channels
}

export function encodeDmx(packet: DmxPacket): Buffer {
  let length = Math.min(512, Math.max(2, packet.data.length));
  if (length % 2 === 1) length += 1; // the spec requires an even length
  const buf = header(OpCode.Dmx, DMX_HEADER_LENGTH + length);
  buf.writeUInt16BE(PROTOCOL_VERSION, 10);
  buf.writeUInt8(packet.sequence & 0xff, 12);
  buf.writeUInt8(packet.physical & 0xff, 13);
  buf.writeUInt8(packet.portAddress & 0xff, 14); // SubUni
  buf.writeUInt8((packet.portAddress >> 8) & 0x7f, 15); // Net
  buf.writeUInt16BE(length, 16);
  buf.set(packet.data.subarray(0, Math.min(length, packet.data.length)), DMX_HEADER_LENGTH);
  return buf;
}

export function decodeDmx(buf: Buffer): DmxPacket | null {
  if (readOpCode(buf) !== OpCode.Dmx || buf.length < DMX_HEADER_LENGTH) return null;
  const length = buf.readUInt16BE(16);
  return {
    sequence: buf.readUInt8(12),
    physical: buf.readUInt8(13),
    portAddress: (buf.readUInt8(15) << 8) | buf.readUInt8(14),
    data: new Uint8Array(buf.subarray(DMX_HEADER_LENGTH, DMX_HEADER_LENGTH + length)),
  };
}

export function encodeSync(): Buffer {
  const buf = header(OpCode.Sync, 14);
  buf.writeUInt16BE(PROTOCOL_VERSION, 10);
  return buf;
}

export interface PollReply {
  ip: string;
  port: number;
  firmware: number;
  netSwitch: number;
  subSwitch: number;
  oem: number;
  status1: number;
  estaManufacturer: number;
  shortName: string;
  longName: string;
  nodeReport: string;
  numPorts: number;
  portTypes: number[];
  swIn: number[];
  swOut: number[];
  mac: string;
  bindIp: string;
  bindIndex: number;
  status2: number;
  /** Port-Addresses this node outputs, derived from Net/Sub-Net/SwOut and the output port types. */
  outputAddresses: number[];
  /** Output port-addresses the node reports as merging two sources (GoodOutput bit 3). */
  merging: number[];
}

function cString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, Math.min(buf.length, start + length));
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("latin1").trim();
}

function ipAt(buf: Buffer, offset: number): string {
  return Array.from(buf.subarray(offset, offset + 4)).join(".");
}

const PORT_TYPE_OUTPUT = 0x80;
const GOOD_OUTPUT_MERGING = 0x08;

export function decodePollReply(buf: Buffer): PollReply | null {
  if (readOpCode(buf) !== OpCode.PollReply || buf.length < POLL_REPLY_MIN_LENGTH) return null;
  const byteAt = (offset: number): number => (offset < buf.length ? buf.readUInt8(offset) : 0);
  const numPorts = Math.min(4, buf.readUInt16BE(172));
  const portTypes = [174, 175, 176, 177].map(byteAt);
  const swIn = [186, 187, 188, 189].map(byteAt);
  const swOut = [190, 191, 192, 193].map(byteAt);
  const netSwitch = byteAt(18);
  const subSwitch = byteAt(19);
  const goodOutput = [182, 183, 184, 185].map(byteAt);
  const outputAddresses: number[] = [];
  const merging: number[] = [];
  for (let i = 0; i < numPorts; i++) {
    if (!(portTypes[i]! & PORT_TYPE_OUTPUT)) continue;
    const addr = portAddress(netSwitch, subSwitch, swOut[i]!);
    outputAddresses.push(addr);
    if (goodOutput[i]! & GOOD_OUTPUT_MERGING) merging.push(addr);
  }
  return {
    ip: ipAt(buf, 10),
    port: buf.readUInt16LE(14),
    firmware: buf.readUInt16BE(16),
    netSwitch,
    subSwitch,
    oem: buf.readUInt16BE(20),
    status1: byteAt(23),
    estaManufacturer: buf.readUInt16LE(24),
    shortName: cString(buf, 26, 18),
    longName: cString(buf, 44, 64),
    nodeReport: cString(buf, 108, 64),
    numPorts,
    portTypes,
    swIn,
    swOut,
    mac: Array.from(buf.subarray(201, 207)).map((b) => b.toString(16).padStart(2, "0")).join(":"),
    bindIp: buf.length >= 211 ? ipAt(buf, 207) : "0.0.0.0",
    bindIndex: byteAt(211),
    status2: byteAt(212),
    outputAddresses,
    merging,
  };
}

export interface PollReplyInit {
  ip: string;
  shortName: string;
  longName: string;
  netSwitch?: number;
  subSwitch?: number;
  /** Universe nibble of each output port (1 to 4 ports). */
  swOut: number[];
  mac?: string;
  bindIndex?: number;
  /** Ports reporting a merge of two sources. */
  merging?: boolean[];
}

/** Encodes an ArtPollReply. Used by tests and by the fake node; a controller never sends one. */
export function encodePollReply(init: PollReplyInit): Buffer {
  const buf = header(OpCode.PollReply, 239);
  init.ip.split(".").forEach((part, i) => buf.writeUInt8(Number(part) & 0xff, 10 + i));
  buf.writeUInt16LE(ARTNET_PORT, 14);
  buf.writeUInt8(init.netSwitch ?? 0, 18);
  buf.writeUInt8(init.subSwitch ?? 0, 19);
  buf.write(init.shortName.slice(0, 17), 26, "latin1");
  buf.write(init.longName.slice(0, 63), 44, "latin1");
  const ports = init.swOut.slice(0, 4);
  buf.writeUInt16BE(ports.length, 172);
  ports.forEach((uni, i) => {
    buf.writeUInt8(PORT_TYPE_OUTPUT, 174 + i);
    buf.writeUInt8(uni & 0x0f, 190 + i);
    if (init.merging?.[i]) buf.writeUInt8(GOOD_OUTPUT_MERGING, 182 + i);
  });
  (init.mac ?? "00:00:00:00:00:00").split(":").forEach((h, i) => buf.writeUInt8(parseInt(h, 16) & 0xff, 201 + i));
  init.ip.split(".").forEach((part, i) => buf.writeUInt8(Number(part) & 0xff, 207 + i));
  buf.writeUInt8(init.bindIndex ?? 1, 211);
  return buf;
}
