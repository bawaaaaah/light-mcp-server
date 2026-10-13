/**
 * P12 — QLC+ workspace import and analysis (step 1 of "import then rebuild").
 *
 *   npm run proto:qxw -- --qxw <workspace.qxw> --fixtures <dir with .qxf> [--details]
 *
 * Reports: fixtures and missing definitions, decoded cells, sequences with attack / run order /
 * colours / guessed technique, recurring palettes, MIDI mapping and exclusive (solo) groups.
 * Reads only; prints nothing that is written anywhere else.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseQxf } from "../src/plugins/light/venue/qxf-import.js";
import { parseQxw } from "../src/plugins/light/presets/qxw-import.js";
import { analyzeWorkspace } from "../src/plugins/light/presets/qxw-analyze.js";

const { values } = parseArgs({
  options: {
    qxw: { type: "string" },
    fixtures: { type: "string", default: "data/fixtures" },
    details: { type: "boolean", default: false },
    expected: { type: "string" },
  },
});
if (!values.qxw) {
  console.error("--qxw <fichier> requis");
  process.exit(1);
}

const t0 = performance.now();
const ws = parseQxw(readFileSync(values.qxw, "utf8"));
const defs = readdirSync(values.fixtures!)
  .filter((f) => f.endsWith(".qxf"))
  .map((f) => parseQxf(readFileSync(join(values.fixtures!, f), "utf8")));
const a = analyzeWorkspace(ws, defs);
const ms = performance.now() - t0;

const byType = new Map<string, number>();
for (const f of ws.functions.values()) byType.set(f.type, (byType.get(f.type) ?? 0) + 1);
console.log(`Workspace QLC+ ${ws.qlcVersion} · lu et analysé en ${ms.toFixed(0)} ms`);
console.log(`Fixtures : ${ws.fixtures.length} · fonctions : ${[...byType].map(([t, n]) => `${t} ${n}`).join(", ")}`);
console.log(`Widgets : ${ws.widgets.length} (${ws.widgets.filter((w) => w.input).length} avec entrée MIDI) · cadres solo : ${ws.soloFrames.map((s) => `#${s.id} (${s.members.length} boutons)`).join(", ") || "aucun"}`);
console.log(`Cellules décodées : ${a.cells.length}${a.missingDefinitions.length ? ` · définitions manquantes : ${a.missingDefinitions.join(" ; ")}` : ""}`);

const techniques = new Map<string, number>();
for (const s of a.sequences) techniques.set(s.technique, (techniques.get(s.technique) ?? 0) + 1);
console.log(`\nSéquences analysées : ${a.sequences.length}`);
console.log(`Techniques reconnues : ${[...techniques].sort((x, y) => y[1] - x[1]).map(([t, n]) => `${t} ${n}`).join(" · ")}`);
const attacks = { claque: 0, intermédiaire: 0, respire: 0 };
for (const s of a.sequences) attacks[s.attackLabel] += 1;
console.log(`Attaque : claque ${attacks.claque} · intermédiaire ${attacks.intermédiaire} · respire ${attacks.respire}`);
const conf = { haute: 0, moyenne: 0, basse: 0 };
for (const s of a.sequences) conf[s.confidence] += 1;
console.log(`Confiance de reconnaissance : haute ${conf.haute} · moyenne ${conf.moyenne} · basse ${conf.basse}`);

console.log(`\nPalettes récurrentes (top 8 sur ${a.palettes.length}) :`);
for (const p of a.palettes.slice(0, 8)) console.log(`  ×${p.usedBy}  ${p.colors.join(" ")}`);

const noteCount = a.midi.filter((m) => m.binding.startsWith("note")).length;
const ccCount = a.midi.filter((m) => m.binding.startsWith("CC")).length;
console.log(`\nMapping MIDI : ${noteCount} notes, ${ccCount} CC, ${a.midi.filter((m) => m.binding.startsWith("horloge")).length} horloge`);

if (values.details) {
  console.log("\nDétail des séquences :");
  for (const s of a.sequences)
    console.log(`  #${s.id} ${s.name} — ${s.steps} pas · ${s.runOrder} · ${s.stepMs.toFixed(0)} ms/pas · attaque ${(s.attack * 100).toFixed(0)} % (${s.attackLabel}) · ${s.technique} [${s.confidence}] · ${s.colors.slice(0, 5).join(" ")}`);
  console.log("\nDétail MIDI :");
  for (const m of a.midi) console.log(`  ${m.binding.padEnd(22)} ${m.caption}${m.soloFrame !== undefined ? ` (solo #${m.soloFrame})` : ""}`);
}

if (values.expected) {
  // Ground truth: { "<function id>": "<technique label from the user's own notes>" } (kept private).
  const expected = JSON.parse(readFileSync(values.expected, "utf8")) as Record<string, string>;
  const norm = (label: string) =>
    label.replace(/\s*\+\s*punch.*/, "").replace(/,.*$/, "").replace("lights partiels", "masques").trim();
  let ok = 0;
  let punchOk = 0;
  const misses: string[] = [];
  for (const [id, label] of Object.entries(expected)) {
    const s = a.sequences.find((x) => x.id === Number(id));
    if (!s) continue;
    const want = norm(label);
    if (s.technique === want) ok += 1;
    else misses.push(`#${id} attendu « ${want} », reconnu « ${s.technique} »`);
    const wantPunch = /punch/.test(label);
    if (wantPunch === (s.attackLabel === "claque")) punchOk += 1;
  }
  const n = Object.keys(expected).length;
  console.log(`\nÉvaluation : technique ${ok}/${n} (${((ok / n) * 100).toFixed(0)} %) · punch/attaque ${punchOk}/${n}`);
  for (const m of misses) console.log(`  ✗ ${m}`);
}
