/**
 * Fake Art-Net node for local tests: answers ArtPoll with an ArtPollReply and counts the ArtDmx it
 * receives per port-address.
 *
 * Usage: npm run proto:fake-node -- [--bind 127.0.0.2] [--name "Fake node"] [--universes 0,1]
 * Bind it to its own address (127.0.0.2 on Linux loopback) so it does not compete with the
 * controller for port 6454.
 */
import { createSocket } from "node:dgram";
import { parseArgs } from "node:util";
import { ARTNET_PORT, OpCode, decodeDmx, encodePollReply, readOpCode } from "../src/plugins/light/output/artnet.js";

const { values } = parseArgs({
  options: {
    bind: { type: "string", default: "127.0.0.2" },
    name: { type: "string", default: "Fake node" },
    universes: { type: "string", default: "0,1" },
  },
});
const swOut = values.universes!.split(",").map(Number);
const sock = createSocket({ type: "udp4", reuseAddr: true });
const counts = new Map<number, number>();

sock.on("message", (msg, rinfo) => {
  const op = readOpCode(msg);
  if (op === OpCode.Poll) {
    const reply = encodePollReply({ ip: values.bind!, shortName: values.name!, longName: `${values.name} (light-mcp-server prototype)`, swOut });
    sock.send(reply, ARTNET_PORT, rinfo.address);
    console.log(`ArtPoll de ${rinfo.address} → ArtPollReply envoyé`);
  } else if (op === OpCode.Dmx) {
    const dmx = decodeDmx(msg);
    if (dmx) counts.set(dmx.portAddress, (counts.get(dmx.portAddress) ?? 0) + 1);
  }
});

sock.bind(ARTNET_PORT, values.bind, () => {
  console.log(`Faux node « ${values.name} » sur ${values.bind}:${ARTNET_PORT}, univers ${swOut.join(",")}`);
});

setInterval(() => {
  if (counts.size === 0) return;
  console.log("ArtDmx reçus :", [...counts].map(([pa, n]) => `univers ${pa}: ${n}`).join(" · "));
  counts.clear();
}, 5000);
