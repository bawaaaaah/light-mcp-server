/**
 * P1 / P4 / P5 — MIDI inputs: auto-detection, monitoring, clock + SPP following, aftertouch, and
 * round-trip latency.
 *
 *   npm run proto:midi -- --list
 *       Lists input and output ports (IAC buses, USB devices, RTP-MIDI sessions on macOS).
 *   npm run proto:midi -- --watch
 *       Prints ports appearing/disappearing (hot-plug), once per second.
 *   npm run proto:midi -- --in "IAC" [--in "Network"] [--show-clock]
 *       Monitors the inputs whose name contains the text. Prints notes/CC/aftertouch with
 *       timestamps, and every second the followed tempo, transport and position (P4).
 *       Play a clip with aftertouch in Live to check P5.
 *   npm run proto:midi -- --latency --out "IAC" --in "IAC" [--count 200]
 *       Sends notes to an output and times their arrival on an input (an IAC bus loops back to
 *       itself). Measures the MIDI part of the MIDI → DMX budget (P1).
 *
 * On macOS, RTP-MIDI sessions (Audio MIDI Setup → Network) appear as ordinary ports.
 * On Linux, RTP-MIDI goes through the rtpmidid daemon, which exposes sessions as ALSA ports;
 * the ALSA sequencer must be loaded (`sudo modprobe snd-seq`).
 */
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { formatMidi, parseMidi } from "../src/plugins/light/midi/parse.js";
import { MidiClockFollower } from "../src/plugins/light/timing/midi-clock.js";

type MidiInput = {
  getPortCount(): number;
  getPortName(i: number): string;
  openPort(i: number): void;
  closePort(): void;
  ignoreTypes(sysex: boolean, timing: boolean, activeSensing: boolean): void;
  on(event: "message", fn: (delta: number, message: number[]) => void): void;
};
type MidiOutput = {
  getPortCount(): number;
  getPortName(i: number): string;
  openPort(i: number): void;
  closePort(): void;
  sendMessage(bytes: number[]): void;
};

const require = createRequire(import.meta.url);
let midi: { Input: new () => MidiInput; Output: new () => MidiOutput };
try {
  midi = require("@julusian/midi");
  new midi.Input().getPortCount();
} catch (err) {
  console.error("MIDI local indisponible :", (err as Error).message);
  console.error("Sous Linux : charger le séquenceur ALSA (sudo modprobe snd-seq). Le serveur devra continuer sans MIDI local.");
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    list: { type: "boolean", default: false },
    watch: { type: "boolean", default: false },
    in: { type: "string", multiple: true, default: [] },
    out: { type: "string", default: "" },
    latency: { type: "boolean", default: false },
    count: { type: "string", default: "200" },
    "show-clock": { type: "boolean", default: false },
  },
});

function ports(kind: "in" | "out"): string[] {
  const p = kind === "in" ? new midi.Input() : new midi.Output();
  const names = Array.from({ length: p.getPortCount() }, (_, i) => p.getPortName(i));
  return names;
}

function findPort(kind: "in" | "out", needle: string): number {
  const idx = ports(kind).findIndex((n) => n.toLowerCase().includes(needle.toLowerCase()));
  if (idx === -1) {
    console.error(`Aucun port ${kind === "in" ? "d'entrée" : "de sortie"} ne contient « ${needle} ». Ports : ${ports(kind).join(" | ") || "aucun"}`);
    process.exit(1);
  }
  return idx;
}

if (values.list) {
  console.log("Entrées :", ports("in").map((n, i) => `\n  [${i}] ${n}`).join("") || " aucune");
  console.log("Sorties :", ports("out").map((n, i) => `\n  [${i}] ${n}`).join("") || " aucune");
  process.exit(0);
}

if (values.watch) {
  let known = new Set(ports("in"));
  console.log("Entrées actuelles :", [...known].join(" | ") || "aucune", "\n(Ctrl+C pour arrêter)");
  setInterval(() => {
    const now = new Set(ports("in"));
    for (const n of now) if (!known.has(n)) console.log(`${new Date().toLocaleTimeString()} + nouvelle entrée : ${n}`);
    for (const n of known) if (!now.has(n)) console.log(`${new Date().toLocaleTimeString()} − entrée disparue : ${n}`);
    known = now;
  }, 1000);
} else if (values.latency) {
  if (!values.out || values.in!.length !== 1) {
    console.error("--latency demande --out <port> et un seul --in <port>.");
    process.exit(1);
  }
  const input = new midi.Input();
  const output = new midi.Output();
  input.ignoreTypes(true, true, true);
  const sentAt = new Map<number, number>();
  const rtts: number[] = [];
  input.on("message", (_d, msg) => {
    const m = parseMidi(msg);
    if (m.type === "noteon" && sentAt.has(m.note)) {
      rtts.push(performance.now() - sentAt.get(m.note)!);
      sentAt.delete(m.note);
    }
  });
  input.openPort(findPort("in", values.in![0]!));
  output.openPort(findPort("out", values.out));
  const total = Number(values.count);
  let i = 0;
  const timer = setInterval(() => {
    if (i >= total) {
      clearInterval(timer);
      setTimeout(() => {
        const s = rtts.sort((a, b) => a - b);
        const pct = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
        console.log(`${s.length}/${total} notes revenues · aller-retour : p50 ${pct(50).toFixed(2)} · p95 ${pct(95).toFixed(2)} · max ${s.at(-1)?.toFixed(2)} ms`);
        input.closePort();
        output.closePort();
        process.exit(0);
      }, 500);
      return;
    }
    const note = 20 + (i % 80);
    sentAt.set(note, performance.now());
    output.sendMessage([0x90, note, 100]);
    output.sendMessage([0x80, note, 0]);
    i += 1;
  }, 20);
} else if (values.in!.length > 0) {
  const clock = new MidiClockFollower();
  for (const needle of values.in!) {
    const input = new midi.Input();
    input.ignoreTypes(false, false, true);
    const idx = findPort("in", needle);
    const name = input.getPortName(idx);
    input.on("message", (_d, msg) => {
      const now = performance.now();
      const m = parseMidi(msg);
      clock.handle(m, now);
      if (m.type === "clock" && !values["show-clock"]) return;
      console.log(`${(now / 1000).toFixed(3)}s  [${name}]  ${formatMidi(m)}`);
    });
    input.openPort(idx);
    console.log(`Écoute : ${name}`);
  }
  setInterval(() => {
    const s = clock.state(performance.now());
    if (!s.receiving) {
      console.log("— horloge : absente (activer Sync sur ce port dans Live → Préférences → Link/Tempo/MIDI)");
      return;
    }
    const bar = Math.floor(s.beats / 4) + 1;
    const beat = Math.floor(s.beats % 4) + 1;
    console.log(`— horloge : ${s.bpm?.toFixed(2)} BPM · ${s.running ? "lecture" : "arrêt"} · position ${s.beats.toFixed(2)} temps (mesure ${bar}.${beat})`);
  }, 1000);
} else {
  console.log("Rien à faire : voir --list, --watch, --in, --latency (en-tête du fichier).");
}
