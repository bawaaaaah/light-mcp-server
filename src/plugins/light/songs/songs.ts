/**
 * Songs and setlists (docs/specs/presets-songs-notes.md): a song is a list of sections, each
 * pointing to a look, with its cue (« repère »), its idea, and its position in bars. The runtime
 * keeps the current song/section, and can follow the MIDI clock position (SPP): when Ableton plays
 * or is scrubbed, the section under the playhead is re-established (no reliance on a one-shot note).
 */
import { z } from "zod";

export const SectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  look: z.string().optional(),
  /** Structural cue: « l'entrée franche du groupe », « premier refrain ». */
  cue: z.string().optional(),
  idea: z.string().optional(),
  /** Section length in bars (used to place sections when `atBar` is absent, and for the Live Set). */
  bars: z.number().positive().default(8),
  /** Position from the song start, in bars (0-based); absent = right after the previous section. */
  atBar: z.number().min(0).optional(),
  notes: z.string().optional(),
});
export type Section = z.infer<typeof SectionSchema>;

export const SongSchema = z.object({
  id: z.string(),
  title: z.string(),
  key: z.string().optional(),
  bpm: z.number().min(20).max(400).default(120),
  beatsPerBar: z.number().int().min(1).max(16).default(4),
  /** 1–2 mood keywords: the guard rail of every section. */
  mood: z.array(z.string()).default([]),
  palette: z.string().optional(),
  sections: z.array(SectionSchema).default([]),
  /** Where the song starts in the DAW arrangement, in beats (to follow SPP). */
  startBeat: z.number().min(0).optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type Song = z.infer<typeof SongSchema>;

export const SetlistSchema = z.object({ id: z.string(), name: z.string(), songs: z.array(z.string()).default([]), notes: z.string().optional() });
export type Setlist = z.infer<typeof SetlistSchema>;

/** Sections with absolute positions in beats from the song start. */
export function placeSections(song: Song): { section: Section; startBeat: number; endBeat: number }[] {
  const out: { section: Section; startBeat: number; endBeat: number }[] = [];
  let cursor = 0;
  for (const s of song.sections) {
    const start = s.atBar !== undefined ? s.atBar * song.beatsPerBar : cursor;
    const end = start + s.bars * song.beatsPerBar;
    out.push({ section: s, startBeat: start, endBeat: end });
    cursor = end;
  }
  return out;
}

/** Section under a position (beats from the song start), or undefined before the first one. */
export function sectionAt(song: Song, beat: number): Section | undefined {
  let found: Section | undefined;
  for (const p of placeSections(song)) if (beat >= p.startBeat) found = p.section;
  return found;
}

/** Cue sheet (« feuille de conduite ») in Markdown. */
export function cueSheet(songs: Song[], lookName: (id: string) => string | undefined, noteOf: (lookId: string) => string | undefined): string {
  const lines: string[] = [];
  for (const song of songs) {
    lines.push(`## ${song.title}${song.key ? ` — ${song.key}` : ""} · ${song.bpm} BPM${song.mood.length ? ` · ${song.mood.join(", ")}` : ""}`, "");
    lines.push("| Mesure | Section | Repère | Look | Note | Idée |", "|--:|---|---|---|---|---|");
    for (const p of placeSections(song)) {
      const s = p.section;
      lines.push(`| ${p.startBeat / song.beatsPerBar + 1} | ${s.name} | ${s.cue ?? ""} | ${s.look ? (lookName(s.look) ?? s.look) : ""} | ${s.look ? (noteOf(s.look) ?? "") : ""} | ${s.idea ?? ""} |`);
    }
    if (song.notes) lines.push("", `> ${song.notes}`);
    lines.push("");
  }
  return lines.join("\n");
}
