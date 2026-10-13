/**
 * P9 — Live DMX stream over WebSocket to many dashboards.
 *
 * A WebSocket server publishes `light:dmx` events (msgpack, the wing envelope) at ≤ 25 Hz with
 * 16 animated universes; N in-process clients receive them. One client can be made slow (paused
 * socket) to check that frames are dropped for it (newest frame supersedes) instead of piling up.
 *
 * Usage: npm run proto:ws -- [--clients 8] [--universes 16] [--seconds 10] [--slow 1]
 */
import { WebSocketServer, WebSocket } from "ws";
import { parseArgs } from "node:util";
import { msgpackCodec } from "../src/core/ws-codec.js";

const { values } = parseArgs({
  options: {
    clients: { type: "string", default: "8" },
    universes: { type: "string", default: "16" },
    seconds: { type: "string", default: "10" },
    slow: { type: "string", default: "1" },
    rate: { type: "string", default: "25" },
  },
});
const CLIENTS = Number(values.clients);
const UNIVERSES = Number(values.universes);
const SECONDS = Number(values.seconds);
const SLOW = Number(values.slow);
const RATE = Number(values.rate);
/** A client with more than this many bytes queued is skipped for the current frame. */
const MAX_BUFFERED = 256 * 1024;

const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((res) => wss.once("listening", res));
const port = (wss.address() as { port: number }).port;

let skipped = 0;
let bytesSent = 0;
const buffers = Array.from({ length: UNIVERSES }, () => new Uint8Array(512));

const cpuStart = process.cpuUsage();
const t0 = performance.now();
const timer = setInterval(() => {
  const phase = (performance.now() - t0) / 1000;
  for (let u = 0; u < UNIVERSES; u++) {
    const b = buffers[u]!;
    for (let c = 0; c < 512; c++) b[c] = (Math.sin(phase * 3 + c * 0.05 + u) * 127 + 128) | 0;
  }
  const frame = msgpackCodec.encode({
    t: "evt",
    topic: "light:dmx",
    ts: Date.now(),
    data: { sentAt: performance.now(), universes: buffers.map((b, u) => [u, b]) },
  }) as Uint8Array;
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      skipped += 1; // stream channel: the next frame supersedes this one
      continue;
    }
    ws.send(frame);
    bytesSent += frame.byteLength;
  }
}, 1000 / RATE);

interface ClientStats {
  frames: number;
  latencies: number[];
}
const stats: ClientStats[] = [];
const sockets: WebSocket[] = [];
for (let i = 0; i < CLIENTS; i++) {
  const s: ClientStats = { frames: 0, latencies: [] };
  stats.push(s);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.binaryType = "nodebuffer";
  ws.on("message", (data: Buffer) => {
    const msg = msgpackCodec.decode(data, true) as { data: { sentAt: number } };
    s.frames += 1;
    s.latencies.push(performance.now() - msg.data.sentAt);
  });
  sockets.push(ws);
  await new Promise((res) => ws.once("open", res));
}
// Slow clients: stop reading from the socket entirely after 1 s.
setTimeout(() => {
  for (let i = 0; i < SLOW; i++) {
    const raw = (sockets[i] as unknown as { _socket: { pause(): void } })._socket;
    raw.pause();
  }
}, 1000);

await new Promise((res) => setTimeout(res, SECONDS * 1000));
clearInterval(timer);
const cpu = process.cpuUsage(cpuStart);
const elapsed = (performance.now() - t0) / 1000;

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN;
};
console.log(`=== ${CLIENTS} clients (${SLOW} lent·s) · ${UNIVERSES} univers · ${RATE} Hz · ${SECONDS} s ===`);
console.log(`taille d'une trame : ${(16 + UNIVERSES * 515)} o env. · débit total émis ${(bytesSent / elapsed / 1024).toFixed(0)} Kio/s`);
console.log(`CPU du processus (serveur + clients) : ${(((cpu.user + cpu.system) / 1000 / (elapsed * 1000)) * 100).toFixed(1)} % d'un cœur`);
console.log(`trames sautées pour clients lents : ${skipped}`);
stats.forEach((s, i) => {
  const label = i < SLOW ? "lent  " : "normal";
  console.log(`client ${i} (${label}) : ${s.frames} trames (${(s.frames / elapsed).toFixed(1)}/s) · latence p50 ${pct(s.latencies, 50).toFixed(2)} · p99 ${pct(s.latencies, 99).toFixed(2)} ms`);
});
for (const ws of sockets) ws.terminate();
wss.close();
process.exit(0);
