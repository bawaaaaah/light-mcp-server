import { useCallback, useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents, useTopic } from "../hooks/useTopic";

interface Section {
  id: string;
  name: string;
  look?: string;
  cue?: string;
  idea?: string;
  bars: number;
}
interface Song {
  id: string;
  title: string;
  key?: string;
  bpm: number;
  mood: string[];
  sections: Section[];
}
interface Setlist {
  id: string;
  name: string;
  songs: string[];
}
interface SongState {
  setlist?: string;
  song?: string;
  section?: string;
  follow: boolean;
}

export function SongsPage() {
  const t = useT();
  const [songs, setSongs] = useState<Song[]>([]);
  const [setlists, setSetlists] = useState<Setlist[]>([]);
  const [sheet, setSheet] = useState<string | null>(null);
  const [error, setError] = useState("");
  const state = useTopic<SongState>("light:song", { follow: true });

  const refresh = useCallback(() => {
    void cmd<Song[]>("song.list").then(setSongs).catch((e: Error) => setError(e.message));
    void cmd<Setlist[]>("setlist.list").then(setSetlists).catch(() => undefined);
  }, []);
  useEffect(refresh, [refresh]);
  useCommandEvents(["song.put", "song.delete", "setlist.put", "song.grid_fill"], refresh);
  const run = (name: string, args: unknown = {}) => cmd(name, args).catch((e: Error) => setError(e.message));

  const current = setlists.find((s) => s.id === state.setlist);
  const ordered = current ? current.songs.map((id) => songs.find((s) => s.id === id)).filter((s): s is Song => Boolean(s)) : songs;

  return (
    <div className="songs">
      <section className="bar">
        <select value={state.setlist ?? ""} onChange={(e) => e.target.value && void run("setlist.select", { id: e.target.value })}>
          <option value="">{t.setlist} —</option>
          {setlists.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button onClick={() => void run("setlist.prev")}>◀ {t.song}</button>
        <button onClick={() => void run("setlist.next")}>
          {t.song} ▶
        </button>
        <label className="row">
          <input type="checkbox" checked={state.follow} onChange={(e) => void run("song.follow", { on: e.target.checked })} /> {t.follow}
        </label>
        <button className="ghost" onClick={() => void cmd<string>("export.cuesheet", state.setlist ? { setlist: state.setlist } : {}).then(setSheet)}>
          {t.cuesheet}
        </button>
        {error && (
          <span className="error" onClick={() => setError("")}>
            {error}
          </span>
        )}
      </section>
      {ordered.length === 0 && <p className="hint">{t.noSongs}</p>}
      {ordered.map((song) => (
        <section key={song.id} className={song.id === state.song ? "song current" : "song"}>
          <h2 onClick={() => void run("song.select", { id: song.id })}>
            {song.title} <small>{[song.key, `${song.bpm} BPM`, song.mood.join(", ")].filter(Boolean).join(" · ")}</small>
          </h2>
          <div className="grid">
            {song.sections.map((sec) => (
              <button
                key={sec.id}
                className={`look ${song.id === state.song && sec.id === state.section ? "on" : ""} ${sec.look ? "" : "danger"}`}
                title={[sec.cue, sec.idea].filter(Boolean).join(" — ")}
                onClick={() => void run("song.section.go", { song: song.id, section: sec.id })}
              >
                {sec.name}
                {sec.cue && <small className="cue">{sec.cue}</small>}
              </button>
            ))}
          </div>
        </section>
      ))}
      {sheet && (
        <section>
          <h2>{t.cuesheet}</h2>
          <pre className="monitor">{sheet}</pre>
        </section>
      )}
    </div>
  );
}
