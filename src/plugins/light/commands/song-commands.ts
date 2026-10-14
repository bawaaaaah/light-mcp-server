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
import { cueSheet, placeSections, sectionAt, SetlistSchema, SongSchema, type Setlist, type Song } from "../songs/songs.js";
import { readAls, setLocators, setTempoSteps, setTrackClips, writeAls, type ClipSpec } from "../ableton/live-set.js";

export interface SongState {
  setlist?: string;
  song?: string;
  section?: string;
  follow: boolean;
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
    description: "Creates or updates a song: title, key, BPM, mood keywords (guard rail), palette, sections (name, look, cue « repère », idea, bars, optional atBar), start position in the DAW (startBeat).",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ song: SongSchema }),
    run: ({ song: sg }) => {
      for (const sec of sg.sections) if (sec.look && !s.runtime.looks.get(sec.look)) throw new Error(`section ${sec.id} : look inconnu ${sec.look}`);
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
      if (s.tempo.state().source !== "midi") s.tempo.setBpm(sg.bpm);
      if (start && sg.sections[0]) return goSection(sg, sg.sections[0].id);
      s.publish({ ...s.state });
      return { song: sg.id };
    },
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

/** Called on every frame/tempo tick: follow the MIDI position into the current song's sections. */
export function followPosition(s: SongServices): void {
  if (!s.state.follow || !s.state.song) return;
  const t = s.tempo.state();
  if (t.source !== "midi" || !t.running || t.position === null) return;
  const sg = s.songs.get(s.state.song);
  if (!sg) return;
  const sec = sectionAt(sg, t.position - (sg.startBeat ?? 0));
  if (!sec || sec.id === s.state.section) return;
  s.state.section = sec.id;
  if (sec.look) s.runtime.go(sec.look);
  s.publish({ ...s.state });
}
