/**
 * P11 — OSC control: a UDP server with a route table, a /light/help reply listing the addresses,
 * and a latency bench (client → server → reply).
 *
 *   npm run proto:osc -- --bench [--count 2000]
 *   npm run proto:osc -- --listen [--port 9000]
 *       Prints matched routes; send e.g. from TouchOSC/Companion, or:
 *       /light/help (replies to the sender with one message per address).
 */
import { createSocket } from "node:dgram";
import { parseArgs } from "node:util";
import { decodeOsc, encodeOsc, matchRoute, type OscArg } from "../src/plugins/light/osc/codec.js";

const { values } = parseArgs({
  options: {
    bench: { type: "boolean", default: false },
    listen: { type: "boolean", default: false },
    port: { type: "string", default: "9000" },
    count: { type: "string", default: "2000" },
  },
});

/** Prototype route table: the real one is generated from the command layer. */
const ROUTES: { pattern: string; args: string; description: string }[] = [
  { pattern: "/light/panic", args: "", description: "Panic neutre (look de secours, sinon Blackout)" },
  { pattern: "/light/blackout", args: "", description: "Blackout" },
  { pattern: "/light/tempo/tap", args: "", description: "Tap tempo" },
  { pattern: "/light/song/{id}/select", args: "", description: "Sélectionner un chant" },
  { pattern: "/light/section/{id}/go", args: "", description: "Lancer une section" },
  { pattern: "/light/group/{id}/level", args: "f 0..1", description: "Niveau du master d'un groupe" },
  { pattern: "/light/group/{id}/mute", args: "T|F", description: "Mute d'un groupe" },
  { pattern: "/light/button/{id}/press", args: "[f vélocité]", description: "Appui sur un bouton" },
];

function route(address: string): { pattern: string; params: Record<string, string> } | null {
  for (const r of ROUTES) {
    const params = matchRoute(r.pattern, address);
    if (params) return { pattern: r.pattern, params };
  }
  return null;
}

const server = createSocket("udp4");
server.on("message", (buf, rinfo) => {
  for (const msg of decodeOsc(buf)) {
    if (msg.address === "/light/help") {
      for (const r of ROUTES) server.send(encodeOsc({ address: "/light/help/route", args: [r.pattern, r.args, r.description] }), rinfo.port, rinfo.address);
      continue;
    }
    if (msg.address === "/bench/ping") {
      server.send(encodeOsc({ address: "/bench/pong", args: msg.args }), rinfo.port, rinfo.address);
      continue;
    }
    const r = route(msg.address);
    if (values.listen) console.log(r ? `${msg.address} → ${r.pattern} ${JSON.stringify(r.params)} args=${JSON.stringify(msg.args)}` : `${msg.address} : adresse inconnue`);
  }
});

if (values.bench) {
  await new Promise<void>((res) => server.bind(0, "127.0.0.1", res));
  const port = server.address().port;
  const client = createSocket("udp4");
  await new Promise<void>((res) => client.bind(0, "127.0.0.1", res));
  const total = Number(values.count);
  const rtts: number[] = [];
  let pending: { id: number; t0: number; done: () => void } | null = null;
  client.on("message", (buf) => {
    const [m] = decodeOsc(buf);
    if (m?.address === "/bench/pong" && pending && m.args[0] === pending.id) {
      rtts.push(performance.now() - pending.t0);
      pending.done();
    }
  });
  for (let i = 0; i < total; i++) {
    await new Promise<void>((done) => {
      pending = { id: i, t0: performance.now(), done };
      client.send(encodeOsc({ address: "/bench/ping", args: [i] as OscArg[] }), port, "127.0.0.1");
    });
  }
  // /light/help round trip
  const help: string[] = [];
  client.removeAllListeners("message");
  client.on("message", (buf) => help.push(String(decodeOsc(buf)[0]!.args[0])));
  client.send(encodeOsc({ address: "/light/help", args: [] }), port, "127.0.0.1");
  await new Promise((res) => setTimeout(res, 100));
  rtts.sort((a, b) => a - b);
  const pct = (p: number) => rtts[Math.min(rtts.length - 1, Math.floor((p / 100) * rtts.length))]!;
  console.log(`${total} messages OSC aller-retour : p50 ${pct(50).toFixed(3)} · p99 ${pct(99).toFixed(3)} · max ${rtts.at(-1)!.toFixed(3)} ms`);
  console.log(`/light/help : ${help.length} adresses renvoyées (${help.join(", ")})`);
  client.close();
  server.close();
} else if (values.listen) {
  server.bind(Number(values.port), () => console.log(`Serveur OSC sur le port ${values.port} — envoyer /light/help pour la liste des adresses`));
} else {
  console.log("Voir --bench ou --listen (en-tête du fichier).");
}
