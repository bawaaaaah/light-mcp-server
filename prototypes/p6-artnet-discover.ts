/**
 * P6 — Art-Net discovery on the real network.
 *
 * Sends ArtPoll to the broadcast address of each IPv4 interface (or to --target addresses), listens
 * for ArtPollReply for a few seconds and prints the nodes found, with their output universes.
 *
 * Usage: npm run proto:artnet -- [--seconds 5] [--interface en0] [--target 127.0.0.2,10.0.0.40]
 *        [--bind 0.0.0.0]
 * Needs UDP port 6454: stop QLC+ (or any Art-Net software) on this machine first.
 */
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { parseArgs } from "node:util";
import { ARTNET_PORT, decodePollReply, encodePoll, splitPortAddress } from "../src/plugins/light/output/artnet.js";
import { NodeRegistry } from "../src/plugins/light/output/artnet-discovery.js";

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "5" },
    interface: { type: "string", default: "" },
    target: { type: "string", default: "" },
    bind: { type: "string", default: "0.0.0.0" },
  },
});

function broadcastAddresses(only: string): { name: string; address: string; broadcast: string }[] {
  const out: { name: string; address: string; broadcast: string }[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (only && name !== only) continue;
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const ip = a.address.split(".").map(Number);
      const mask = a.netmask.split(".").map(Number);
      out.push({ name, address: a.address, broadcast: ip.map((b, i) => (b & mask[i]!) | (~mask[i]! & 255)).join(".") });
    }
  }
  return out;
}

const targets = values.target
  ? values.target.split(",").map((address) => ({ name: "cible", address, broadcast: address }))
  : broadcastAddresses(values.interface!);
if (targets.length === 0) {
  console.error("Aucune interface IPv4 trouvée (voir --interface ou --target).");
  process.exit(1);
}

const registry = new NodeRegistry();
const sock = createSocket({ type: "udp4", reuseAddr: true });
sock.on("message", (msg) => {
  const reply = decodePollReply(msg);
  if (!reply) return;
  if (registry.seen(reply, Date.now()) === "added") {
    const unis = reply.outputAddresses
      .map((pa) => {
        const s = splitPortAddress(pa);
        return `${pa} (net ${s.net}, sub ${s.subNet}, uni ${s.universe})`;
      })
      .join(", ");
    console.log(`+ ${reply.ip}#${reply.bindIndex}  « ${reply.shortName} » — ${reply.longName}`);
    console.log(`    sorties : ${unis || "aucune"} · MAC ${reply.mac} · rapport : ${reply.nodeReport || "—"}`);
  }
});

sock.bind(ARTNET_PORT, values.bind, () => {
  sock.setBroadcast(true);
  const poll = encodePoll();
  for (const t of targets) {
    console.log(`ArtPoll → ${t.broadcast} (${t.name} ${t.address})`);
    sock.send(poll, ARTNET_PORT, t.broadcast);
  }
});

setTimeout(() => {
  console.log(`\n${registry.list().length} node(s) trouvé(s) en ${values.seconds} s.`);
  sock.close();
}, Number(values.seconds) * 1000);
