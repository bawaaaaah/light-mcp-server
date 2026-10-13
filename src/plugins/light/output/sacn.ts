/**
 * sACN (ANSI E1.31) codec: data and synchronization packets. Pure functions; sockets live with the
 * output router. Universes are 1..63999; multicast group 239.255.<hi>.<lo>, UDP port 5568.
 */

export const SACN_PORT = 5568;
const ACN_PID = Buffer.from([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00]);
const VECTOR_ROOT_DATA = 0x00000004;
const VECTOR_ROOT_EXTENDED = 0x00000008;
const VECTOR_FRAMING_DATA = 0x00000002;
const VECTOR_FRAMING_SYNC = 0x00000001;
const DATA_HEADER = 126;

export const SacnOption = { preview: 0x80, streamTerminated: 0x40, forceSync: 0x20 } as const;

export function multicastGroup(universe: number): string {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

export interface SacnDataPacket {
  cid: Buffer; // 16 bytes, stable per source
  sourceName: string;
  priority: number; // 0..200, default 100
  syncAddress: number; // 0 = no synchronization
  sequence: number;
  options: number;
  universe: number;
  data: Uint8Array; // up to 512 slots, start code 0 is added
}

const flagsLength = (length: number): number => 0x7000 | (length & 0x0fff);

function rootLayer(buf: Buffer, vector: number, cid: Buffer): void {
  if (cid.length !== 16) throw new RangeError("sACN CID must be 16 bytes");
  buf.writeUInt16BE(0x0010, 0);
  buf.writeUInt16BE(0x0000, 2);
  ACN_PID.copy(buf, 4);
  buf.writeUInt16BE(flagsLength(buf.length - 16), 16);
  buf.writeUInt32BE(vector, 18);
  cid.copy(buf, 22);
}

export function encodeSacnData(p: SacnDataPacket): Buffer {
  const slots = Math.min(512, p.data.length);
  const buf = Buffer.alloc(DATA_HEADER + slots);
  rootLayer(buf, VECTOR_ROOT_DATA, p.cid);
  buf.writeUInt16BE(flagsLength(buf.length - 38), 38);
  buf.writeUInt32BE(VECTOR_FRAMING_DATA, 40);
  buf.write(p.sourceName.slice(0, 63), 44, "utf8");
  buf.writeUInt8(Math.max(0, Math.min(200, p.priority)), 108);
  buf.writeUInt16BE(p.syncAddress & 0xffff, 109);
  buf.writeUInt8(p.sequence & 0xff, 111);
  buf.writeUInt8(p.options & 0xff, 112);
  buf.writeUInt16BE(p.universe & 0xffff, 113);
  buf.writeUInt16BE(flagsLength(buf.length - 115), 115);
  buf.writeUInt8(0x02, 117);
  buf.writeUInt8(0xa1, 118);
  buf.writeUInt16BE(0x0000, 119);
  buf.writeUInt16BE(0x0001, 121);
  buf.writeUInt16BE(slots + 1, 123);
  buf.writeUInt8(0x00, 125); // DMX start code
  buf.set(p.data.subarray(0, slots), DATA_HEADER);
  return buf;
}

export function decodeSacnData(buf: Buffer): Omit<SacnDataPacket, "cid"> & { cid: Buffer } | null {
  if (buf.length < DATA_HEADER || !buf.subarray(4, 16).equals(ACN_PID)) return null;
  if (buf.readUInt32BE(18) !== VECTOR_ROOT_DATA || buf.readUInt32BE(40) !== VECTOR_FRAMING_DATA) return null;
  const count = buf.readUInt16BE(123) - 1;
  const nameRaw = buf.subarray(44, 108);
  const nameEnd = nameRaw.indexOf(0);
  return {
    cid: Buffer.from(buf.subarray(22, 38)),
    sourceName: nameRaw.subarray(0, nameEnd === -1 ? 64 : nameEnd).toString("utf8"),
    priority: buf.readUInt8(108),
    syncAddress: buf.readUInt16BE(109),
    sequence: buf.readUInt8(111),
    options: buf.readUInt8(112),
    universe: buf.readUInt16BE(113),
    data: new Uint8Array(buf.subarray(DATA_HEADER, DATA_HEADER + count)),
  };
}

export function encodeSacnSync(cid: Buffer, sequence: number, syncAddress: number): Buffer {
  const buf = Buffer.alloc(49);
  rootLayer(buf, VECTOR_ROOT_EXTENDED, cid);
  buf.writeUInt16BE(flagsLength(buf.length - 38), 38);
  buf.writeUInt32BE(VECTOR_FRAMING_SYNC, 40);
  buf.writeUInt8(sequence & 0xff, 44);
  buf.writeUInt16BE(syncAddress & 0xffff, 45);
  return buf;
}
