/**
 * P3 — Builds a MIDI Effect Rack from a shell .adg exported by your own Live version.
 *
 *   npm run proto:adg -- --shell <shell.adg> --chains <chains.json> [--out prototypes/out/test-rack.adg]
 *
 * chains.json: { "userName": "...", "annotation": "...", "chains": [{ "name": "...", "note": 36, "color": 12 }] }
 * Without --chains, a 6-chain demo rack is generated.
 *
 * Then drop the .adg on a MIDI track in Live and check: rack opens, chain names, one-key zones
 * (Key editor), colours, and that a clip note lights the right chain.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { buildRackXml, listChains, readAdg, writeAdg, type RackSpec } from "../src/plugins/light/ableton/midi-effect-rack.js";

const { values } = parseArgs({
  options: {
    shell: { type: "string" },
    chains: { type: "string" },
    out: { type: "string", default: "prototypes/out/test-rack.adg" },
  },
});
if (!values.shell) {
  console.error("--shell <fichier .adg> est requis (un MIDI Effect Rack à une chaîne, exporté tel quel depuis Live).");
  process.exit(1);
}

const spec: RackSpec = values.chains
  ? (JSON.parse(readFileSync(values.chains, "utf8")) as RackSpec)
  : {
      userName: "light-mcp-server · démo · ch 1",
      annotation: "Rack de démonstration généré par le prototype P3. Faders : Master = CC 7.",
      chains: [
        { name: "Intro · respiration", note: 36, color: 12 },
        { name: "Couplet · palette qui tourne", note: 37, color: 12 },
        { name: "Refrain · damier (claque)", note: 38, color: 12 },
        { name: "Pont · masques colorés", note: 39, color: 12 },
        { name: "❌ Flash blanc", note: 60, color: 0 },
        { name: "■ Blackout", note: 61, color: 0 },
      ],
    };

const shellXml = readAdg(readFileSync(values.shell));
const xml = buildRackXml(shellXml, spec);
const check = listChains(xml);
mkdirSync(dirname(values.out!), { recursive: true });
writeFileSync(values.out!, writeAdg(xml));
console.log(`${values.out} : ${check.length} chaînes`);
for (const c of check) console.log(`  note ${String(c.note).padStart(3)} · couleur ${String(c.color).padStart(2)} · ${c.name}`);
