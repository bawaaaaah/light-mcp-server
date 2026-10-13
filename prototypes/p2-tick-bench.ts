/**
 * P2 — DMX tick benchmark.
 *
 * Renders N universes at 44 Hz through the real Ticker + Art-Net encoder, sends them over UDP to an
 * in-process receiver, and measures:
 *  - tick interval jitter, render+encode+send time per frame;
 *  - frames received per universe, sequence gaps (lost frames);
 *  - "trigger → packet" latency for simulated commands, with and without requestFrame().
 *
 * Usage: npm run proto:tick -- [--universes 16] [--seconds 10] [--rate 44] [--triggers 200]
 *        [--target 127.0.0.1:6455]   (default: in-process receiver on 127.0.0.1:6455)
 */
import { createSocket } from "node:dgram";
import { parseArgs } from "node:util";
import { decodeDmx, encodeDmx } from "../src/plugins/light/output/artnet.js";
import { Ticker } from "../src/plugins/light/engine/ticker.js";

const { values } = parseArgs({
  options: {
    universes: { type: "string", default: "16" },
    seconds: { type: "string", default: "10" },
    rate: { type: "string", default: "44" },
    triggers: { type: "string", default: "200" },
    target: { type: "string", default: "" },
  },
});
const UNIVERSES = Number(values.universes);
const SECONDS = Number(values.seconds);
const RATE = Number(values.rate);
const TRIGGERS = Number(values.triggers);
const [targetHost, targetPortStr] = (values.target || "127.0.0.1:6455").split(":");
const targetPort = Number(targetPortStr);
const internalReceiver = !values.target;

function stats(xs: number[]): string {
  if (xs.length === 0) return "n/a";
  const s = [...xs].sort((a, b) => a - b);
  const pct = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return `mean ${mean.toFixed(2)} · p50 ${pct(50).toFixed(2)} · p95 ${pct(95).toFixed(2)} · p99 ${pct(99).toFixed(2)} · max ${s.at(-1)!.toFixed(2)} ms`;
}

async function run(useRequestFrame: boolean): Promise<void> {
  const sender = createSocket("udp4");
  const receiver = internalReceiver ? createSocket("udp4") : null;
  const received = new Map<number, { count: number; lastSeq: number; gaps: number }>();
  // Trigger latency: a trigger flips universe 0 channel 1 to a new value; we time until a packet
  // carrying that value is *received*.
  let pendingTrigger: { value: number; at: number } | null = null;
  const latencies: number[] = [];

  if (receiver) {
    receiver.on("message", (msg) => {
      const dmx = decodeDmx(msg);
      if (!dmx) return;
      const r = received.get(dmx.portAddress) ?? { count: 0, lastSeq: dmx.sequence - 1, gaps: 0 };
      const expected = r.lastSeq === 255 ? 1 : r.lastSeq + 1;
      if (r.count > 0 && dmx.sequence !== expected) r.gaps += 1;
      r.count += 1;
      r.lastSeq = dmx.sequence;
      received.set(dmx.portAddress, r);
      if (pendingTrigger && dmx.portAddress === 0 && dmx.data[0] === pendingTrigger.value) {
        latencies.push(performance.now() - pendingTrigger.at);
        pendingTrigger = null;
      }
    });
    await new Promise<void>((res) => receiver.bind(targetPort, targetHost, res));
  }

  const buffers = Array.from({ length: UNIVERSES }, () => new Uint8Array(512));
  const sequences = new Array<number>(UNIVERSES).fill(0);
  let triggerValue = 0;
  const intervals: number[] = [];
  const frameCosts: number[] = [];
  let lastTick: number | null = null;
  let frames = 0;

  const ticker = new Ticker(
    (now, reason) => {
      const t0 = performance.now();
      if (reason === "tick") {
        if (lastTick !== null) intervals.push(now - lastTick);
        lastTick = now;
      }
      // Simulated render: a moving sine on every channel (stands in for effects).
      const phase = now / 1000;
      for (let u = 0; u < UNIVERSES; u++) {
        const buf = buffers[u]!;
        for (let c = 1; c < 512; c++) buf[c] = (Math.sin(phase * 2 + c * 0.05 + u) * 127 + 128) | 0;
        if (u === 0) buf[0] = triggerValue;
        sequences[u] = sequences[u]! >= 255 ? 1 : sequences[u]! + 1;
        sender.send(encodeDmx({ sequence: sequences[u]!, physical: 0, portAddress: u, data: buf }), targetPort, targetHost);
      }
      frames += 1;
      frameCosts.push(performance.now() - t0);
    },
    { rateHz: RATE },
  );

  ticker.start();
  const triggerEvery = (SECONDS * 1000) / (TRIGGERS + 1);
  const triggerTimer = setInterval(() => {
    triggerValue = triggerValue >= 250 ? 1 : triggerValue + 1;
    pendingTrigger = { value: triggerValue, at: performance.now() };
    if (useRequestFrame) ticker.requestFrame();
  }, triggerEvery * (0.9 + Math.random() * 0.2));

  await new Promise((res) => setTimeout(res, SECONDS * 1000));
  clearInterval(triggerTimer);
  ticker.stop();
  await new Promise((res) => setTimeout(res, 100));

  console.log(`\n=== ${UNIVERSES} univers · ${RATE} Hz · ${SECONDS} s · requestFrame ${useRequestFrame ? "ON" : "OFF"} ===`);
  console.log(`frames émises     : ${frames} (${(frames / SECONDS).toFixed(1)}/s)`);
  console.log(`intervalle tick   : ${stats(intervals)}  (cible ${(1000 / RATE).toFixed(2)} ms)`);
  console.log(`coût d'une frame  : ${stats(frameCosts)}  (rendu + encodage + envoi de ${UNIVERSES} univers)`);
  if (receiver) {
    const counts = [...received.values()];
    const totalGaps = counts.reduce((a, r) => a + r.gaps, 0);
    const minCount = Math.min(...counts.map((r) => r.count));
    console.log(`reçu              : ${counts.length} univers, min ${minCount} trames/univers, trous de séquence ${totalGaps}`);
    console.log(`déclenchement→paquet reçu (${latencies.length} mesures) : ${stats(latencies)}`);
    receiver.close();
  }
  sender.close();
}

await run(false);
await run(true);
