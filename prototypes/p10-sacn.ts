/**
 * P10 — sACN (E1.31) multicast output.
 *
 * Sends N universes by multicast at 44 Hz for a few seconds and receives them in-process (joined
 * multicast groups, loopback enabled): checks packet layout on the wire, rate and loss.
 *
 * Usage: npm run proto:sacn -- [--universes 16] [--seconds 5] [--interface 192.168.1.10]
 * To check against third-party software, run it with --seconds 60 and open a sACN viewer.
 */
import { createSocket } from "node:dgram";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { SACN_PORT, decodeSacnData, encodeSacnData, multicastGroup } from "../src/plugins/light/output/sacn.js";

const { values } = parseArgs({
  options: {
    universes: { type: "string", default: "16" },
    seconds: { type: "string", default: "5" },
    interface: { type: "string", default: "127.0.0.1" },
  },
});
const UNIVERSES = Number(values.universes);
const SECONDS = Number(values.seconds);
const IFACE = values.interface!;
const cid = randomBytes(16);

const receiver = createSocket({ type: "udp4", reuseAddr: true });
const received = new Map<number, { count: number; gaps: number; last: number }>();
receiver.on("message", (msg) => {
  const p = decodeSacnData(msg);
  if (!p || !p.cid.equals(cid)) return;
  const r = received.get(p.universe) ?? { count: 0, gaps: 0, last: p.sequence - 1 };
  if (r.count > 0 && p.sequence !== ((r.last + 1) & 0xff)) r.gaps += 1;
  r.count += 1;
  r.last = p.sequence;
  received.set(p.universe, r);
});
await new Promise<void>((res) => receiver.bind(SACN_PORT, res));
for (let u = 1; u <= UNIVERSES; u++) receiver.addMembership(multicastGroup(u), IFACE);

const sender = createSocket({ type: "udp4", reuseAddr: true });
await new Promise<void>((res) => sender.bind(0, IFACE, res));
sender.setMulticastInterface(IFACE);
sender.setMulticastLoopback(true);
sender.setMulticastTTL(1);

const sequences = new Array<number>(UNIVERSES + 1).fill(0);
const data = new Uint8Array(512);
let frames = 0;
const timer = setInterval(() => {
  data.fill(frames & 0xff);
  for (let u = 1; u <= UNIVERSES; u++) {
    sequences[u] = (sequences[u]! + 1) & 0xff;
    sender.send(encodeSacnData({ cid, sourceName: "light-mcp-server P10", priority: 100, syncAddress: 0, sequence: sequences[u]!, options: 0, universe: u, data }), SACN_PORT, multicastGroup(u));
  }
  frames += 1;
}, 1000 / 44);

await new Promise((res) => setTimeout(res, SECONDS * 1000));
clearInterval(timer);
await new Promise((res) => setTimeout(res, 100));
const counts = [...received.values()];
console.log(`${frames} trames × ${UNIVERSES} univers émises en multicast sur ${IFACE}`);
console.log(`reçu : ${received.size} univers · min ${Math.min(...counts.map((c) => c.count))} paquets/univers · trous de séquence ${counts.reduce((a, c) => a + c.gaps, 0)}`);
sender.close();
receiver.close();
