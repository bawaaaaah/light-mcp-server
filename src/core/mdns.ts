/**
 * A service announced on the local network by multicast DNS (DNS-SD, RFC 6762 and 6763) : enough for
 * DJ software to find the OS2L server by itself (`_os2l._tcp`). It answers the questions about its
 * service, its instance and its host, announces itself at start and says goodbye at stop. The DNS
 * encoding is pure and tested; the socket shares UDP 5353 with the system's own responder.
 */
import { createSocket, type Socket } from "node:dgram";
import { hostname, networkInterfaces } from "node:os";

const GROUP = "224.0.0.251";
const PORT = 5353;
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 } as const;
const IN = 1;
const CACHE_FLUSH = 0x8000;

export interface ServiceInfo {
  /** Instance name shown to the user (« Lumière »). */
  instance: string;
  /** Service type, « _os2l._tcp ». */
  type: string;
  port: number;
  /** Host label, without « .local ». */
  host: string;
  addresses: string[];
}

interface Record {
  name: string;
  type: number;
  unique: boolean;
  ttl: number;
  data: Buffer;
}

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, "").split(".");
  return Buffer.concat([...parts.map((p) => {
    const label = Buffer.from(p, "utf8");
    return Buffer.concat([Buffer.from([label.length]), label]);
  }), Buffer.from([0])]);
}

/** A name read at `offset`, following compression pointers; and where the next field starts. */
export function decodeName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let next = -1;
  let at = offset;
  for (let hops = 0; hops < 32; hops++) {
    const len = buf[at];
    if (len === undefined) break;
    if (len === 0) {
      at++;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (next < 0) next = at + 2;
      at = ((len & 0x3f) << 8) | buf[at + 1]!;
      continue;
    }
    labels.push(buf.subarray(at + 1, at + 1 + len).toString("utf8"));
    at += 1 + len;
  }
  return { name: labels.join("."), next: next < 0 ? at : next };
}

/** The questions of a query: names (lower case) and types. */
export function questionsOf(buf: Buffer): { name: string; type: number }[] {
  if (buf.length < 12 || buf.readUInt16BE(2) & 0x8000) return []; // a response, not a query
  const count = buf.readUInt16BE(4);
  const out: { name: string; type: number }[] = [];
  let at = 12;
  for (let i = 0; i < count && at < buf.length; i++) {
    const { name, next } = decodeName(buf, at);
    if (next + 4 > buf.length) break;
    out.push({ name: name.toLowerCase(), type: buf.readUInt16BE(next) });
    at = next + 4;
  }
  return out;
}

function recordsOf(s: ServiceInfo, ttl = { shared: 4500, unique: 120 }): Record[] {
  const service = `${s.type}.local`;
  const instance = `${s.instance}.${service}`;
  const host = `${s.host}.local`;
  const srv = Buffer.alloc(6);
  srv.writeUInt16BE(0, 0); // priority
  srv.writeUInt16BE(0, 2); // weight
  srv.writeUInt16BE(s.port, 4);
  return [
    { name: "_services._dns-sd._udp.local", type: TYPE.PTR, unique: false, ttl: ttl.shared, data: encodeName(service) },
    { name: service, type: TYPE.PTR, unique: false, ttl: ttl.shared, data: encodeName(instance) },
    { name: instance, type: TYPE.SRV, unique: true, ttl: ttl.unique, data: Buffer.concat([srv, encodeName(host)]) },
    { name: instance, type: TYPE.TXT, unique: true, ttl: ttl.shared, data: Buffer.from([0]) },
    ...s.addresses.map((a) => ({ name: host, type: TYPE.A, unique: true, ttl: ttl.unique, data: Buffer.from(a.split(".").map(Number)) })),
  ];
}

function encodeResponse(records: Record[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2); // response, authoritative
  header.writeUInt16BE(records.length, 6);
  return Buffer.concat([
    header,
    ...records.map((r) => {
      const fixed = Buffer.alloc(10);
      fixed.writeUInt16BE(r.type, 0);
      fixed.writeUInt16BE(IN | (r.unique ? CACHE_FLUSH : 0), 2);
      fixed.writeUInt32BE(r.ttl, 4);
      fixed.writeUInt16BE(r.data.length, 8);
      return Buffer.concat([encodeName(r.name), fixed, r.data]);
    }),
  ]);
}

/** The answer to a query, or nothing when it does not ask about this service. */
export function answer(query: Buffer, s: ServiceInfo): Buffer | undefined {
  const all = recordsOf(s);
  const wanted = questionsOf(query).flatMap((q) => all.filter((r) => r.name.toLowerCase() === q.name && (q.type === TYPE.ANY || q.type === r.type)));
  if (!wanted.length) return undefined;
  // a PTR answer brings its SRV, TXT and A along, so one round trip is enough
  const extra = wanted.some((r) => r.type === TYPE.PTR && r.name !== "_services._dns-sd._udp.local") ? all.filter((r) => r.type !== TYPE.PTR) : [];
  return encodeResponse([...new Set([...wanted, ...extra])]);
}

/** The whole service at once (announcement), or with TTL 0 (goodbye). */
export const announcement = (s: ServiceInfo, goodbye = false): Buffer => encodeResponse(recordsOf(s, goodbye ? { shared: 0, unique: 0 } : undefined).filter((r) => !goodbye || r.type === TYPE.PTR));

/** This machine's mDNS host label and IPv4 addresses. */
export function localHost(): { host: string; addresses: string[] } {
  const host = hostname().replace(/\.local\.?$/i, "").replace(/[^A-Za-z0-9-]/g, "-") || "lumiere";
  const addresses = Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((a) => a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
  return { host, addresses };
}

/** Announces a service until stopped; never throws (a network without multicast only loses the discovery). */
export async function advertise(service: ServiceInfo): Promise<{ stop: () => Promise<void> }> {
  let socket: Socket | undefined;
  const timers: NodeJS.Timeout[] = [];
  try {
    socket = createSocket({ type: "udp4", reuseAddr: true });
    socket.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      socket!.once("error", reject);
      socket!.bind(PORT, () => resolve());
    });
    for (const a of service.addresses) {
      try {
        socket.addMembership(GROUP, a);
      } catch {
        /* an interface without multicast */
      }
    }
    socket.setMulticastTTL(255);
    socket.on("message", (msg) => {
      const reply = answer(msg, service);
      if (reply) socket?.send(reply, PORT, GROUP);
    });
    const announce = () => socket?.send(announcement(service), PORT, GROUP);
    announce();
    timers.push(setTimeout(announce, 1000), setTimeout(announce, 3000));
  } catch {
    socket?.close();
    socket = undefined;
  }
  return {
    async stop() {
      timers.forEach(clearTimeout);
      if (!socket) return;
      const s = socket;
      socket = undefined;
      await new Promise<void>((resolve) => s.send(announcement(service, true), PORT, GROUP, () => resolve()));
      s.close();
    },
  };
}
