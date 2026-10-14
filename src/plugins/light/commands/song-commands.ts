/**
 * Song, setlist and timeline-follow commands, plus the cue sheet and Live Set exports.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CommandRegistry } from "./registry.js";
import type { Collection } from "../data/store.js";
import { slugify } from "../data/store.js";
import type { ShowRuntime } from "../show/runtime.js";
import type { Mapping } from "../midi/mapping.js";
import type { TempoClock } from "../timing/tempo.js";
import { cuesBetween, cueSheet, placeSections, sectionAt, SetlistSchema, songEnd, SongSchema, type Setlist, type Song } from "../songs/songs.js";
import { songBoard } from "../songs/board.js";
import { displayHex } from "../engine/display.js";
import { readAls, setLocators, setTempoSteps, setTrackClips, writeAls, type ClipSpec } from "../ableton/live-set.js";

export interface SongState {
  setlist?: string;
  song?: string;
  section?: string;
  follow: boolean;
  /** Internal transport (no MIDI clock): the song runs on the engine tempo from `offset` beats. */
  transport?: { playing: boolean; startBeats: number; offset: number };
  /** Song position in beats (MIDI clock or transport), while one of them runs. */
  position?: number;
}

export interface SongServices {
  runtime: ShowRuntime;
  songs: Collection<Song>;
  setlists: Collection<Setlist>;
  tempo: TempoClock;
  mappings: () => Mapping[];
  dataRoot: string;
  state: SongState;
  publish: (state: SongState) => void;
  /** Runs a timeline action through the command layer (origin "timeline"). */
  run?: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Last position seen, to fire the cues passed since (internal). */
  lastPosition?: { song: string; at: number };
}

/** Note that triggers a look, from the mappings (for cue sheets and the Live Set). */
export function noteForLook(mappings: Mapping[], lookId: string): { channel: number; note: number } | undefined {
  const m = mappings.find((x) => x.input.type === "note" && x.on.command === "look.go" && x.on.args.id === lookId);
  return m ? { channel: m.input.channel, note: m.input.number } : undefined;
}

export function registerSongCommands(reg: CommandRegistry, s: SongServices): void {
  const id = z.object({ id: z.string() });
  const song = (songId?: string) => {
    const sid = songId ?? s.state.song;
    const found = sid ? s.songs.get(sid) : undefined;
    if (!found) throw new Error(sid ? `chant inconnu : ${sid}` : "aucun chant sélectionné");
    return found;
  };
  const goSection = (sg: Song, sectionId: string) => {
    const sec = sg.sections.find((x) => x.id === sectionId);
    if (!sec) throw new Error(`section inconnue : ${sectionId}`);
    s.state.song = sg.id;
    s.state.section = sec.id;
    if (sec.look) s.runtime.go(sec.look);
    s.publish({ ...s.state });
    return { song: sg.id, section: sec.id, look: sec.look };
  };

  reg.register({ name: "song.list", title: "Chants", description: "Songs of the show with their sections (look, cue, idea, position in bars).", right: "dashboards:view", readOnly: true, profiles: ["design", "live"], schema: z.object({}), run: () => s.songs.list() });
  reg.register({
    name: "song.put",
    title: "Chant",
    description: "Creates or updates a song: title, key, BPM, mood keywords (guard rail), palette, sections (name, look, cue « repère », idea, bars, optional atBar), timeline actions (cues: any non-song command with its args, at a 0-based bar and beat, fired in playback), start position in the DAW (startBeat).",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ song: SongSchema }),
    run: ({ song: sg }) => {
      for (const sec of sg.sections) if (sec.look && !s.runtime.looks.get(sec.look)) throw new Error(`section ${sec.id} : look inconnu ${sec.look}`);
      for (const c of sg.cues) {
        const def = reg.get(c.command);
        if (!def) throw new Error(`action ${c.id} : commande inconnue ${c.command}`);
        if (/^song\.|^setlist\./.test(c.command)) throw new Error(`action ${c.id} : une action de chant ne peut pas piloter les chants (${c.command})`);
        const parsed = def.schema.safeParse(c.args);
        if (!parsed.success) throw new Error(`action ${c.id} (${c.command}) : ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(", ")}`);
      }
      return s.songs.put(sg);
    },
  });
  reg.register({ name: "song.delete", title: "Supprimer un chant", description: "Deletes a song.", right: "show:write", profiles: ["design"], schema: id, run: ({ id: i }) => ({ deleted: s.songs.delete(i) }) });
  reg.register({
    name: "song.select",
    title: "Sélectionner un chant",
    description: "Makes a song current (sets the manual tempo to its BPM unless the tempo follows the MIDI clock) and starts its first section.",
    right: "commands:trigger",
    profiles: ["live"],
    schema: z.object({ id: z.string(), start: z.boolean().default(true) }),
    run: ({ id: i, start }) => {
      const sg = song(i);
      s.state.song = sg.id;
      s.state.section = undefined;
      s.state.transport = undefined;
      if (s.tempo.state().source !== "midi") s.tempo.setBpm(sg.bpm);
      if (start && sg.sections[0]) return goSection(sg, sg.sections[0].id);
      s.publish({ ...s.state });
      return { song: sg.id };
    },
  });
  reg.register({
    name: "song.play",
    title: "Lecture du chant",
    description:
      "Internal transport, for playing without a DAW: the song runs on the engine tempo (its BPM unless the tempo follows the MIDI clock) from a section or a bar, sections start by themselves and timeline actions fire. Stops at the end of the song. A running MIDI clock (DAW playing) always takes precedence.",
    right: "commands:trigger",
    profiles: ["live"],
    schema: z.object({ song: z.string().optional(), section: z.string().optional(), bar: z.number().min(0).optional() }),
    run: ({ song: sid, section, bar }) => {
      const sg = song(sid);
      if (s.tempo.state().source !== "midi") s.tempo.setBpm(sg.bpm);
      const placed = placeSections(sg);
      const offset = section !== undefined ? placed.find((p) => p.section.id === section)?.startBeat : bar !== undefined ? bar * sg.beatsPerBar : 0;
      if (offset === undefined) throw new Error(`section inconnue : ${section}`);
      s.state.song = sg.id;
      s.state.section = undefined;
      s.state.transport = { playing: true, startBeats: s.tempo.state().beats, offset };
      s.lastPosition = { song: sg.id, at: offset - 1e-9 }; // an action placed exactly at the start fires
      followPosition(s);
      return { song: sg.id, fromBeat: offset, section: s.state.section };
    },
  });
  reg.register({
    name: "song.stop",
    title: "Arrêter la lecture",
    description: "Stops the internal transport (the looks keep playing).",
    right: "commands:trigger",
    profiles: ["live"],
    schema: z.object({}),
    run: () => {
      const was = Boolean(s.state.transport?.playing);
      s.state.transport = undefined;
      s.state.position = undefined;
      s.publish({ ...s.state });
      return { stopped: was };
    },
  });
  reg.register({
    name: "export.board",
    title: "Planche d'un chant",
    description: "Storyboard of a song as SVG: one band per section (height by length), the first steps of its look in colour on the canvas, cadence, cue and timeline actions. Printable.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design"],
    schema: z.object({ song: z.string().optional() }),
    run: ({ song: sid }) =>
      songBoard(song(sid), (lookId) => {
        const look = s.runtime.looks.get(lookId);
        if (!look) return undefined;
        let steps: (string | null)[][] = [];
        try {
          steps = s.runtime.stepsOf(look).map((st) => st.map((c) => (c ? displayHex(c) : null)));
        } catch {
          steps = [];
        }
        const e = look.timing.every;
        const cadence = `${"beats" in e ? `${e.beats} t` : `${e.seconds} s`} par pas · ${look.timing.attack < 0.2 ? "claque" : look.timing.attack > 0.8 ? "respire" : `attaque ${Math.round(look.timing.attack * 100)} %`} · ${look.technique.kind}`;
        return { name: look.name, steps, cadence };
      }),
  });
  reg.register({ name: "song.section.go", title: "Lancer une section", description: "Starts a section of a song (its look; exclusive groups release the previous one).", right: "commands:trigger", profiles: ["live"], schema: z.object({ song: z.string().optional(), section: z.string() }), run: ({ song: sid, section }) => goSection(song(sid), section) });
  const step = (dir: 1 | -1) => () => {
    const sg = song();
    const i = sg.sections.findIndex((x) => x.id === s.state.section);
    const next = sg.sections[Math.max(0, Math.min(sg.sections.length - 1, i + dir))];
    if (!next) throw new Error("chant sans section");
    return goSection(sg, next.id);
  };
  reg.register({ name: "song.next", title: "Section suivante", description: "Next section of the current song.", right: "commands:trigger", profiles: ["live"], schema: z.object({}), run: step(1) });
  reg.register({ name: "song.prev", title: "Section précédente", description: "Previous section of the current song.", right: "commands:trigger", profiles: ["live"], schema: z.object({}), run: step(-1) });
  reg.register({ name: "song.state", title: "Chant courant", description: "Current setlist, song and section, and whether the position follows the MIDI clock.", right: "dashboards:view", readOnly: true, profiles: ["live"], schema: z.object({}), run: () => ({ ...s.state }) });
  reg.register({
    name: "song.follow",
    title: "Suivre la position MIDI",
    description: "When on, the section under the MIDI clock position (SPP from the DAW) is started automatically, so a scrub in the middle of a section re-establishes the right look.",
    right: "commands:trigger",
    profiles: ["live"],
    schema: z.object({ on: z.boolean() }),
    run: ({ on }) => {
      s.state.follow = on;
      s.publish({ ...s.state });
      return { follow: on };
    },
  });

  reg.register({ name: "setlist.list", title: "Setlists", description: "Setlists of the show.", right: "dashboards:view", readOnly: true, profiles: ["design", "live"], schema: z.object({}), run: () => s.setlists.list() });
  reg.register({ name: "setlist.put", title: "Setlist", description: "Creates or updates a setlist (ordered song ids).", right: "show:write", profiles: ["design"], schema: z.object({ setlist: SetlistSchema }), run: ({ setlist }) => s.setlists.put(setlist) });
  const setlistStep = (dir: 1 | -1) => () => {
    const sl = s.state.setlist ? s.setlists.get(s.state.setlist) : undefined;
    if (!sl) throw new Error("aucune setlist sélectionnée");
    const i = sl.songs.indexOf(s.state.song ?? "");
    const next = sl.songs[Math.max(0, Math.min(sl.songs.length - 1, i + dir))];
    if (!next) throw new Error("setlist vide");
    return reg.invoke("song.select", { id: next }, { origin: "system", can: () => true });
  };
  reg.register({
    name: "setlist.select",
    title: "Sélectionner une setlist",
    description: "Makes a setlist current and selects its first song.",
    right: "commands:trigger",
    profiles: ["live"],
    schema: id,
    run: async ({ id: i }) => {
      const sl = s.setlists.get(i);
      if (!sl) throw new Error(`setlist inconnue : ${i}`);
      s.state.setlist = i;
      return sl.songs[0] ? reg.invoke("song.select", { id: sl.songs[0] }, { origin: "system", can: () => true }) : { setlist: i };
    },
  });
  reg.register({ name: "setlist.next", title: "Chant suivant", description: "Next song of the current setlist.", right: "commands:trigger", profiles: ["live"], schema: z.object({}), run: setlistStep(1) });
  reg.register({ name: "setlist.prev", title: "Chant précédent", description: "Previous song of the current setlist.", right: "commands:trigger", profiles: ["live"], schema: z.object({}), run: setlistStep(-1) });

  reg.register({
    name: "export.cuesheet",
    title: "Feuille de conduite",
    description: "Cue sheet in Markdown for a setlist (or every song): per section, bar, cue, look, trigger note and idea.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design", "live"],
    schema: z.object({ setlist: z.string().optional() }),
    run: ({ setlist }) => {
      const ids = setlist ? (s.setlists.get(setlist)?.songs ?? []) : s.songs.list().map((x) => x.id);
      const songs = ids.map((x) => s.songs.get(x)).filter((x): x is Song => Boolean(x));
      return cueSheet(songs, (lookId) => s.runtime.looks.get(lookId)?.name, (lookId) => {
        const n = noteForLook(s.mappings(), lookId);
        return n ? `${n.note} (ch ${n.channel})` : undefined;
      });
    },
  });

  reg.register({
    name: "export.liveset",
    title: "Poser la setlist dans un Live Set",
    description:
      "Writes a copy of a Live Set (data/private/<als>) with one locator per song (+ STOP), one autonomous clip per section carrying its trigger note on the given track, and a flat tempo per song. Live must be closed. Output: data/exports/<name>.als.",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ setlist: z.string(), als: z.string(), track: z.string(), name: z.string().default("setlist"), gapBars: z.number().int().min(0).default(10) }),
    run: ({ setlist, als, track, name, gapBars }) => {
      const sl = s.setlists.get(setlist);
      if (!sl) throw new Error(`setlist inconnue : ${setlist}`);
      const src = path.resolve(s.dataRoot, "private", als);
      if (!src.startsWith(path.resolve(s.dataRoot, "private") + path.sep) || !existsSync(src)) throw new Error(`Live Set introuvable : data/private/${als}`);
      const locators: { time: number; name: string }[] = [];
      const clips: ClipSpec[] = [];
      const tempo: { start: number; end: number; bpm: number }[] = [];
      const missing: string[] = [];
      let t = 0;
      for (const songId of sl.songs) {
        const sg = s.songs.get(songId);
        if (!sg) continue;
        const start = t;
        locators.push({ time: start, name: sg.title });
        for (const p of placeSections(sg)) {
          const note = p.section.look ? noteForLook(s.mappings(), p.section.look) : undefined;
          if (p.section.look && !note) missing.push(`${sg.title} · ${p.section.name}`);
          clips.push({ name: `${sg.title} · ${p.section.name}`, start: start + p.startBeat, end: start + p.endBeat, notes: note ? [{ time: 0, note: note.note, duration: 1 }] : [] });
          t = Math.max(t, start + p.endBeat);
        }
        locators.push({ time: t, name: "STOP" });
        tempo.push({ start, end: t, bpm: sg.bpm });
        const bar = sg.beatsPerBar;
        t = Math.ceil((t / bar + gapBars) / 10) * 10 * bar; // ≥ gap, restart on a round ten of bars
      }
      let xml = readAls(readFileSync(src));
      xml = setLocators(xml, locators);
      xml = setTrackClips(xml, track, clips);
      xml = setTempoSteps(xml, tempo);
      const outDir = path.join(s.dataRoot, "exports");
      mkdirSync(outDir, { recursive: true });
      const out = path.join(outDir, `${slugify(name)}.als`);
      writeFileSync(out, writeAls(xml));
      return { file: path.relative(s.dataRoot, out), locators: locators.length, clips: clips.length, sectionsWithoutNote: missing };
    },
  });
}

/**
 * Called on every frame: follows the song position — the MIDI clock while the DAW plays (SPP),
 * otherwise the internal transport — into the current song: the section under the position starts
 * (MIDI: when « suivre » is on), and the timeline actions passed since the last frame fire.
 * A jump (scrub, SPP, new start) fires nothing: only normal playback does.
 */
export function followPosition(s: SongServices): void {
  if (!s.state.song) return;
  const sg = s.songs.get(s.state.song);
  if (!sg) return;
  const t = s.tempo.state();
  let pos: number | undefined;
  let follow = false;
  if (t.source === "midi" && t.running && t.position !== null) {
    pos = t.position - (sg.startBeat ?? 0);
    follow = s.state.follow;
  } else if (s.state.transport?.playing) {
    pos = t.beats - s.state.transport.startBeats + s.state.transport.offset;
    follow = true;
    if (pos >= songEnd(sg)) {
      s.state.transport = undefined;
      s.state.position = undefined;
      s.lastPosition = undefined;
      s.publish({ ...s.state });
      return;
    }
  }
  if (pos === undefined) {
    s.lastPosition = undefined;
    return;
  }
  let changed = false;
  if (follow) {
    const sec = sectionAt(sg, pos);
    if (sec && sec.id !== s.state.section) {
      s.state.section = sec.id;
      if (sec.look) s.runtime.go(sec.look);
      changed = true;
    }
  }
  const last = s.lastPosition?.song === sg.id ? s.lastPosition.at : undefined;
  if (last !== undefined && pos > last && pos - last < 2 && s.run) {
    for (const cue of cuesBetween(sg, last, pos)) void s.run(cue.command, cue.args).catch(() => undefined);
  }
  s.lastPosition = { song: sg.id, at: pos };
  // publish the position at most every half beat, and on section changes
  if (changed || s.state.position === undefined || Math.abs(pos - s.state.position) >= 0.5) {
    s.state.position = Math.round(pos * 100) / 100;
    s.publish({ ...s.state });
  }
}
