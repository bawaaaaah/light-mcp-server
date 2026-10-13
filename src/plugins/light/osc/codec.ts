/**
 * Minimal OSC 1.0 codec: messages (and bundles on decode) with the argument types control
 * surfaces use — i (int32), f (float32), s (string), T/F (booleans), N (nil). Pure functions.
 */

export type OscArg = number | string | boolean | null | { type: "i" | "f"; value: number };
export interface OscMessage {
  address: string;
  args: OscArg[];
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

function encodeString(s: string): Buffer {
  const raw = Buffer.from(s, "utf8");
  const buf = Buffer.alloc(pad4(raw.length + 1));
  raw.copy(buf);
  return buf;
}

export function encodeOsc(msg: OscMessage): Buffer {
  let tags = ",";
  const parts: Buffer[] = [];
  for (const a of msg.args) {
    if (a === null) tags += "N";
    else if (a === true) tags += "T";
    else if (a === false) tags += "F";
    else if (typeof a === "string") {
      tags += "s";
      parts.push(encodeString(a));
    } else {
      const type = typeof a === "number" ? (Number.isInteger(a) ? "i" : "f") : a.type;
      const value = typeof a === "number" ? a : a.value;
      const b = Buffer.alloc(4);
      if (type === "i") b.writeInt32BE(value | 0);
      else b.writeFloatBE(value);
      tags += type;
      parts.push(b);
    }
  }
  return Buffer.concat([encodeString(msg.address), encodeString(tags), ...parts]);
}

function readString(buf: Buffer, offset: number): [string, number] {
  const end = buf.indexOf(0, offset);
  if (end === -1) throw new Error("OSC: unterminated string");
  return [buf.toString("utf8", offset, end), pad4(end + 1)];
}

/** Decodes a packet into its messages (bundles are flattened, time tags ignored). */
export function decodeOsc(buf: Buffer): OscMessage[] {
  if (buf.length >= 8 && buf.toString("ascii", 0, 8) === "#bundle\0") {
    const out: OscMessage[] = [];
    let i = 16; // "#bundle\0" + 8-byte time tag
    while (i + 4 <= buf.length) {
      const size = buf.readInt32BE(i);
      out.push(...decodeOsc(buf.subarray(i + 4, i + 4 + size)));
      i += 4 + size;
    }
    return out;
  }
  let [address, i] = readString(buf, 0);
  if (!address.startsWith("/")) throw new Error("OSC: address must start with /");
  let tags = ",";
  if (i < buf.length) [tags, i] = readString(buf, i);
  const args: OscArg[] = [];
  for (const t of tags.slice(1)) {
    switch (t) {
      case "i":
        args.push(buf.readInt32BE(i));
        i += 4;
        break;
      case "f":
        args.push(buf.readFloatBE(i));
        i += 4;
        break;
      case "s": {
        const [s, next] = readString(buf, i);
        args.push(s);
        i = next;
        break;
      }
      case "T":
        args.push(true);
        break;
      case "F":
        args.push(false);
        break;
      case "N":
        args.push(null);
        break;
      default:
        throw new Error(`OSC: unsupported type tag '${t}'`);
    }
  }
  return [{ address, args }];
}

/** Matches an address against a route pattern with {param} segments, e.g. /light/group/{id}/level. */
export function matchRoute(pattern: string, address: string): Record<string, string> | null {
  const p = pattern.split("/");
  const a = address.split("/");
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let k = 0; k < p.length; k++) {
    const seg = p[k]!;
    if (seg.startsWith("{") && seg.endsWith("}")) params[seg.slice(1, -1)] = decodeURIComponent(a[k]!);
    else if (seg !== a[k]) return null;
  }
  return params;
}
