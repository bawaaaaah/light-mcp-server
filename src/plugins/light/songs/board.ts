/**
 * Storyboard (« planche », docs/specs/presets-songs-notes.md) of a song, in SVG: one band per
 * section (height ∝ its length in bars), the first steps of its look drawn on the canvas cells,
 * the cadence, the cue (« repère ») and the timeline actions. Printable, or convertible to PDF.
 * Pure: the caller gives the looks already rendered as screen colours.
 */
import { cueBeat, placeSections, type Song } from "./songs.js";

export interface BoardLook {
  name: string;
  /** Steps as screen colours per cell (null = untouched). */
  steps: (string | null)[][];
  cadence: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const WIDTH = 960;
const LABEL = 230;
const STRIPS = 4;
const GAP = 10;
const PX_PER_BAR = 9;
const MIN_BAND = 64;

export function songBoard(song: Song, lookOf: (id: string) => BoardLook | undefined): string {
  const placed = placeSections(song);
  const bpb = song.beatsPerBar;
  const head = 64;
  const cuesIn = (from: number, to: number) => song.cues.filter((c) => cueBeat(song, c) >= from && cueBeat(song, c) < to);
  const bands = placed.map((p) => Math.max(MIN_BAND, ((p.endBeat - p.startBeat) / bpb) * PX_PER_BAR, 72 + cuesIn(p.startBeat, p.endBeat).length * 13));
  const height = head + bands.reduce((a, b) => a + b, 0) + 24;
  const stripWidth = (WIDTH - LABEL - 20 - GAP * (STRIPS - 1)) / STRIPS;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${Math.ceil(height)}" viewBox="0 0 ${WIDTH} ${Math.ceil(height)}" font-family="system-ui, sans-serif">`);
  out.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  const meta = [song.key, `${song.bpm} BPM`, `${bpb}/4`, song.mood.join(", ")].filter(Boolean).join(" · ");
  out.push(`<text x="16" y="30" font-size="20" font-weight="700" fill="#111">${esc(song.title)}</text>`);
  out.push(`<text x="16" y="50" font-size="12" fill="#555">${esc(meta)}</text>`);
  let y = head;
  placed.forEach((p, i) => {
    const h = bands[i]!;
    const s = p.section;
    const look = s.look ? lookOf(s.look) : undefined;
    out.push(`<g class="section" data-section="${esc(s.id)}">`);
    out.push(`<rect x="8" y="${y}" width="${WIDTH - 16}" height="${h - 4}" rx="6" fill="${i % 2 ? "#f4f5f8" : "#fafbfc"}" stroke="#d9dce3"/>`);
    out.push(`<text x="18" y="${y + 20}" font-size="14" font-weight="600" fill="#111">${esc(s.name)}</text>`);
    out.push(`<text x="18" y="${y + 36}" font-size="11" fill="#555">mesure ${p.startBeat / bpb + 1} → ${p.endBeat / bpb} (${(p.endBeat - p.startBeat) / bpb} mes.)</text>`);
    if (s.cue) out.push(`<text x="18" y="${y + 51}" font-size="11" fill="#7a4b00">« ${esc(s.cue)} »</text>`);
    if (!look) {
      out.push(`<text x="${LABEL}" y="${y + 24}" font-size="12" fill="#c62828">${s.look ? `look introuvable : ${esc(s.look)}` : "pas de look"}</text>`);
    } else {
      out.push(`<text x="${LABEL}" y="${y + 16}" font-size="12" fill="#111">${esc(look.name)} <tspan fill="#777">· ${esc(look.cadence)}</tspan></text>`);
      look.steps.slice(0, STRIPS).forEach((step, k) => {
        const x0 = LABEL + k * (stripWidth + GAP);
        const cw = stripWidth / Math.max(1, step.length);
        step.forEach((c, j) => {
          out.push(`<rect x="${(x0 + j * cw).toFixed(1)}" y="${y + 24}" width="${Math.max(1, cw - 1).toFixed(1)}" height="22" fill="${c ?? "#e3e5ea"}" stroke="#b9bdc6" stroke-width="0.6"${c ? "" : ' stroke-dasharray="2 2"'}/>`);
        });
        out.push(`<text x="${x0}" y="${y + 58}" font-size="9" fill="#888">pas ${k + 1}${k === STRIPS - 1 && look.steps.length > STRIPS ? ` (+${look.steps.length - STRIPS})` : ""}</text>`);
      });
    }
    // timeline actions inside this section
    cuesIn(p.startBeat, p.endBeat).forEach((c, k) => {
      const label = c.label ?? c.command;
      out.push(`<text x="${LABEL}" y="${y + 72 + k * 13}" font-size="10" fill="#1a56c4">◆ mesure ${c.atBar + 1}.${c.beat + 1} : ${esc(label)}</text>`);
    });
    out.push(`</g>`);
    y += h;
  });
  out.push(`</svg>`);
  return out.join("\n");
}
