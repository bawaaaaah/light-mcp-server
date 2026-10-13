/**
 * P7 — RTP-MIDI (AppleMIDI) in pure Node, without a system daemon.
 *
 *   npm run proto:rtp -- --bench [--count 1000]
 *       Two sessions on loopback: round-trip latency of notes.
 *   npm run proto:rtp -- --listen [--port 5004] [--name light-mcp-server]
 *       Waits for invitations and prints received MIDI + followed clock. On the Mac:
 *       Audio MIDI Setup → Window → Show MIDI Network Setup → "Directory" + → enter this
 *       machine's IP and port 5004 → select it → Connect. Then route Live's MIDI to that session.
 *   npm run proto:rtp -- --invite <ip>[:port] [--port 5004]
 *       Invites a remote session (e.g. the Mac's "Session 1", port 5004 by default).
 */
import { parseArgs } from "node:util";
import { formatMidi, parseMidi } from "../src/plugins/light/midi/parse.js";
import { RtpMidiSession } from "../src/plugins/light/midi/rtp/session.js";
import { MidiClockFollower } from "../src/plugins/light/timing/midi-clock.js";

const { values } = parseArgs({
  options: {
    bench: { type: "boolean", default: false },
    listen: { type: "boolean", default: false },
    invite: { type: "string", default: "" },
    port: { type: "string", default: "5004" },
    name: { type: "string", default: "light-mcp-server" },
    count: { type: "string", default: "1000" },
    "show-clock": { type: "boolean", default: false },
  },
});

if (values.bench) {
  const a = new RtpMidiSession({ name: "bench-A", port: 15104, host: "127.0.0.1" });
  const b = new RtpMidiSession({ name: "bench-B", port: 15106, host: "127.0.0.1" });
  await a.start();
  await b.start();
  await a.invite("127.0.0.1", 15106);
  b.on("midi", (m: number[]) => b.send([m])); // echo
  const total = Number(values.count);
  const rtts: number[] = [];
  for (let i = 0; i < total; i++) {
    const note = i % 128;
    const t0 = performance.now();
    const back = new Promise<void>((res) => {
      const h = (m: number[]) => {
        if (m[1] === note) {
          a.off("midi", h);
          res();
        }
      };
      a.on("midi", h);
    });
    a.send([[0x90, note, 100]]);
    await back;
    rtts.push(performance.now() - t0);
  }
  rtts.sort((x, y) => x - y);
  const pct = (p: number) => rtts[Math.min(rtts.length - 1, Math.floor((p / 100) * rtts.length))]!;
  console.log(`${total} notes aller-retour en boucle locale : p50 ${pct(50).toFixed(3)} · p95 ${pct(95).toFixed(3)} · p99 ${pct(99).toFixed(3)} · max ${rtts.at(-1)!.toFixed(3)} ms`);
  a.stop();
  b.stop();
} else if (values.listen || values.invite) {
  const session = new RtpMidiSession({ name: values.name!, port: Number(values.port) });
  await session.start();
  const clock = new MidiClockFollower();
  session.on("peer", (p) => console.log(`+ session connectée : « ${p.name} » ${p.address}:${p.controlPort}`));
  session.on("peerLeft", (p) => console.log(`− session partie : « ${p.name} »`));
  session.on("clockSync", (s: { latencyMs: number }) => console.log(`  synchro d'horloge : latence estimée ${s.latencyMs.toFixed(2)} ms`));
  session.on("midi", (bytes: number[]) => {
    const now = performance.now();
    const m = parseMidi(bytes);
    clock.handle(m, now);
    if (m.type === "clock" && !values["show-clock"]) return;
    console.log(`${(now / 1000).toFixed(3)}s  ${formatMidi(m)}`);
  });
  console.log(`Session RTP-MIDI « ${values.name} » à l'écoute sur ${values.port}/${Number(values.port) + 1} (Ctrl+C pour arrêter)`);
  if (values.invite) {
    const [host, port] = values.invite.split(":");
    session.invite(host!, Number(port ?? 5004)).catch((e: Error) => console.error(e.message));
  }
  setInterval(() => {
    const s = clock.state(performance.now());
    if (s.receiving) console.log(`— horloge : ${s.bpm?.toFixed(2)} BPM · ${s.running ? "lecture" : "arrêt"} · ${s.beats.toFixed(2)} temps`);
  }, 1000);
  process.on("SIGINT", () => {
    session.stop();
    process.exit(0);
  });
} else {
  console.log("Voir --bench, --listen, --invite (en-tête du fichier).");
}
