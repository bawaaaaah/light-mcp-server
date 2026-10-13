/**
 * P8 — Lays a setlist into a copy of an Ableton Live Set: locators (song + STOP), one autonomous
 * clip per section with its trigger note on a named MIDI track, flat tempo steps.
 *
 *   npm run proto:liveset -- --als <set.als> --track "<track name>" [--out prototypes/out/test-set.als]
 *
 * The track must already hold one clip drawn in Live (the template), and the master tempo must
 * have at least one automation point. Never writes the input file. Open the output in Live
 * (Live closed while generating) and check: locators, clips/names/notes, tempo, no crash.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { readAls, setLocators, setTempoSteps, setTrackClips, summarize, writeAls, type ClipSpec } from "../src/plugins/light/ableton/live-set.js";

const { values } = parseArgs({
  options: {
    als: { type: "string" },
    track: { type: "string" },
    out: { type: "string", default: "prototypes/out/test-set.als" },
  },
});
if (!values.als || !values.track) {
  console.error("--als <fichier> et --track <nom de piste> sont requis");
  process.exit(1);
}

/** Demo setlist: 3 songs; sections of 8 or 16 beats; one trigger note per section. */
const songs = [
  { name: "Chant A", bpm: 72, sections: [["intro", 8, 36], ["couplet", 16, 37], ["refrain", 16, 38]] },
  { name: "Chant B", bpm: 128, sections: [["intro", 8, 39], ["refrain", 16, 40], ["pont", 8, 41], ["final", 8, 42]] },
  { name: "Chant C", bpm: 96, sections: [["couplet", 16, 43], ["refrain", 16, 44]] },
] as const;

const BAR = 4;
const nextTen = (beats: number) => Math.ceil((beats / BAR + 10) / 10) * 10 * BAR; // ≥ 10 bars of gap, on a round bar
const locators: { time: number; name: string }[] = [];
const clips: ClipSpec[] = [];
const tempo: { start: number; end: number; bpm: number }[] = [];
let t = 0;
for (const song of songs) {
  const start = t;
  locators.push({ time: start, name: song.name });
  for (const [section, length, note] of song.sections) {
    clips.push({ name: `${song.name} · ${section}`, start: t, end: t + length, notes: [{ time: 0, note, duration: 1 }] });
    t += length;
  }
  locators.push({ time: t, name: "STOP" });
  tempo.push({ start, end: t, bpm: song.bpm });
  t = nextTen(t);
}

const original = readAls(readFileSync(values.als));
let xml = setLocators(original, locators);
xml = setTrackClips(xml, values.track, clips);
xml = setTempoSteps(xml, tempo);

const before = summarize(original);
const after = summarize(xml);
mkdirSync(dirname(values.out!), { recursive: true });
writeFileSync(values.out!, writeAls(xml));

console.log(`${values.out} écrit (${before.creator})`);
console.log(`repères : ${before.locators.length} → ${after.locators.length}`);
console.log(`clips sur « ${values.track} » : ${before.clipCount[values.track]} → ${after.clipCount[values.track]}`);
console.log(`points de tempo : ${before.tempo.length} → ${after.tempo.length}`);
// Everything outside the edited regions must be unchanged.
const untouched = before.tracks.filter((tr) => tr.name !== values.track).every((tr) => original.slice(tr.start, tr.end) === xml.slice(after.tracks.find((x) => x.name === tr.name)!.start, after.tracks.find((x) => x.name === tr.name)!.end));
console.log(`autres pistes inchangées : ${untouched ? "oui" : "NON"}`);
