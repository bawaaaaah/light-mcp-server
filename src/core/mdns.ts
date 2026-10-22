/**
 * Services on the local network by multicast DNS (DNS-SD, RFC 6762 and 6763). Announced: enough for
 * DJ software to find the OS2L server by itself (`_os2l._tcp`), and for a Mac to list the light's
 * RTP-MIDI session (`_apple-midi._udp`); it answers the questions about its service, its instance and
 * its host, announces itself at start and says goodbye at stop. Browsed: the RTP-MIDI sessions of
 * the network (another Mac, an iPad, a console), from the answers to a question for their type. The
 * DNS encoding is pure and tested; the sockets share UDP 5353 with the system's own responder.
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

/** A name read at `offset`, following compression pointers, and its labels; and where the next field starts. */
export function decodeName(buf: Buffer, offset: number): { name: string; labels: string[]; next: number } {
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
  return { name: labels.join("."), labels, next: next < 0 ? at : next };
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

/** A question for the instances of a service type (« _apple-midi._udp »), as a browser asks it. */
export function encodeQuery(questions: { name: string; type: keyof typeof TYPE }[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(questions.length, 4);
  return Buffer.concat([
    header,
    ...questions.map((q) => {
      const tail = Buffer.alloc(4);
      tail.writeUInt16BE(TYPE[q.type], 0);
      tail.writeUInt16BE(IN, 2);
      return Buffer.concat([encodeName(q.name), tail]);
    }),
  ]);
}

export type SeenRecord =
  | { kind: "ptr"; name: string; instance: string; label: string; ttl: number }
  | { kind: "srv"; name: string; host: string; port: number; ttl: number }
  | { kind: "a"; name: string; address: string; ttl: number };

/** The PTR, SRV and A records of a response (answers and additional records alike); names in lower case, the instance label as written. */
export function recordsIn(buf: Buffer): SeenRecord[] {
  if (buf.length < 12 || !(buf.readUInt16BE(2) & 0x8000)) return []; // a query, not a response
  let at = 12;
  for (let i = buf.readUInt16BE(4); i > 0 && at < buf.length; i--) at = decodeName(buf, at).next + 4; // questions, if any
  const count = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  const out: SeenRecord[] = [];
  for (let i = 0; i < count && at + 10 <= buf.length; i++) {
    const { name, next } = decodeName(buf, at);
    if (next + 10 > buf.length) break;
    const type = buf.readUInt16BE(next);
    const ttl = buf.readUInt32BE(next + 4);
    const len = buf.readUInt16BE(next + 8);
    const data = next + 10;
    if (data + len > buf.length) break;
    const lower = name.toLowerCase();
    if (type === TYPE.PTR) {
      const target = decodeName(buf, data);
      out.push({ kind: "ptr", name: lower, instance: target.name.toLowerCase(), label: target.labels[0] ?? "", ttl });
    } else if (type === TYPE.SRV && len >= 7) out.push({ kind: "srv", name: lower, port: buf.readUInt16BE(data + 4), host: decodeName(buf, data + 6).name.toLowerCase(), ttl });
    else if (type === TYPE.A && len === 4) out.push({ kind: "a", name: lower, address: [...buf.subarray(data, data + 4)].join("."), ttl });
    at = data + len;
  }
  return out;
}

export interface FoundService {
  /** The instance's name as its owner wrote it (« Réseau de la régie »). */
  name: string;
  host: string;
  port: number;
  addresses: string[];
}

/** The instances of a service type heard on the network, from the records as they come (a TTL of 0 is a goodbye). Pure, the time given. */
export class ServiceTable {
  private readonly ptr = new Map<string, { label: string; until: number }>();
  private readonly srv = new Map<string, { host: string; port: number; until: number }>();
  private readonly a = new Map<string, Map<string, number>>();

  constructor(readonly type: string) {}

  receive(records: SeenRecord[], nowMs: number): void {
    const service = `${this.type}.local`.toLowerCase();
    for (const r of records) {
      const until = nowMs + r.ttl * 1000;
      if (r.kind === "ptr" && r.name === service) this.ptr.set(r.instance, { label: r.label, until });
      else if (r.kind === "srv") this.srv.set(r.name, { host: r.host, port: r.port, until });
      else if (r.kind === "a") this.a.set(r.name, (this.a.get(r.name) ?? new Map()).set(r.address, until));
    }
  }

  /** The instances still alive, and what is missing to reach the others (their SRV, their host's address). */
  list(nowMs: number): { found: FoundService[]; missing: { name: string; type: "SRV" | "A" }[] } {
    const found: FoundService[] = [];
    const missing: { name: string; type: "SRV" | "A" }[] = [];
    for (const [instance, p] of this.ptr) {
      if (p.until <= nowMs) {
        this.ptr.delete(instance);
        continue;
      }
      const s = this.srv.get(instance);
      if (!s || s.until <= nowMs) {
        missing.push({ name: instance, type: "SRV" });
        continue;
      }
      const addresses = [...(this.a.get(s.host) ?? new Map<string, number>())].filter(([, until]) => until > nowMs).map(([address]) => address);
      if (!addresses.length) missing.push({ name: s.host, type: "A" });
      else found.push({ name: p.label, host: s.host.replace(/\.local$/, ""), port: s.port, addresses });
    }
    return { found: found.sort((x, y) => x.name.localeCompare(y.name)), missing };
  }
}

/** Looks for the instances of a service type until stopped: asks now, every `everyMs`, and on `ask()`; never throws. */
export async function browse(type: string, everyMs = 15_000, now: () => number = Date.now): Promise<{ ask: () => void; list: () => FoundService[]; stop: () => Promise<void> }> {
  const table = new ServiceTable(type);
  let socket: Socket | undefined;
  let timer: NodeJS.Timeout | undefined;
  const send = (q: Buffer) => socket?.send(q, PORT, GROUP, () => undefined);
  const ask = () => send(encodeQuery([{ name: `${type}.local`, type: "PTR" }]));
  try {
    socket = createSocket({ type: "udp4", reuseAddr: true });
    socket.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      socket!.once("error", reject);
      socket!.bind(PORT, () => resolve());
    });
    for (const a of localHost().addresses) {
      try {
        socket.addMembership(GROUP, a);
      } catch {
        /* an interface without multicast */
      }
    }
    socket.setMulticastTTL(255);
    socket.on("message", (msg) => {
      table.receive(recordsIn(msg), now());
      // a responder that left the SRV or the address out is asked for it
      const { missing } = table.list(now());
      if (missing.length) send(encodeQuery(missing.slice(0, 8)));
    });
    ask();
    timer = setInterval(ask, everyMs);
    timer.unref();
  } catch {
    socket?.close();
    socket = undefined;
  }
  return {
    ask,
    list: () => table.list(now()).found,
    async stop() {
      if (timer) clearInterval(timer);
      const s = socket;
      socket = undefined;
      if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
    },
  };
}

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
